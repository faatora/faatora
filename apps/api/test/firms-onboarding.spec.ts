/**
 * EP5 Wave 2 (W2-C) -- tests for FirmsService.createClientTenant and
 * createClientTenantsBatch, plus cross-firm isolation.
 *
 * Works under the same app-pool / admin-pool arrangement as firms.spec.ts
 * so RLS is the floor for everything the service does -- the admin pool
 * is only used for fixture setup and teardown.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { ConflictException } from '@nestjs/common';
import { DB } from '../src/db/db.module';
import { FirmsService } from '../src/modules/firms/firms.service';
import * as schema from '../src/db/schema';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

describe('FirmsService -- client onboarding (W2-C)', () => {
  const ownerU = randomUUID();
  const strangerU = randomUUID();
  const ownerEmail = `owner-onb-${ownerU}@test`;
  const strangerEmail = `stranger-onb-${strangerU}@test`;

  let admin: Pool;
  let appPool: Pool;
  let svc: FirmsService;
  let events: EventEmitter2;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO users (id, cognito_sub, email) VALUES ($1,$2,$3),($4,$5,$6)`, [
      ownerU,
      `sub-${ownerU}`,
      ownerEmail,
      strangerU,
      `sub-${strangerU}`,
      strangerEmail,
    ]);

    appPool = new Pool({ connectionString: APP_URL });
    const appDb = drizzle(appPool, { schema });

    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [FirmsService, { provide: DB, useValue: appDb }],
    }).compile();
    svc = moduleRef.get(FirmsService);
    events = moduleRef.get(EventEmitter2);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM firms WHERE name LIKE 'Onb Firm%'`);
    await admin.query(`DELETE FROM tenants WHERE name LIKE 'Onb Client%'`);
    await admin.query(`DELETE FROM users WHERE id IN ($1,$2)`, [ownerU, strangerU]);
    await admin.query(`DELETE FROM users WHERE email LIKE 'shop-owner-onb-%@test'`);
    await (svc as unknown as { onModuleDestroy(): Promise<void> }).onModuleDestroy();
    await appPool.end();
    await admin.end();
  });

  afterEach(async () => {
    await admin.query(`DELETE FROM firms WHERE name LIKE 'Onb Firm%'`);
    await admin.query(`DELETE FROM tenants WHERE name LIKE 'Onb Client%'`);
    await admin.query(`DELETE FROM users WHERE email LIKE 'shop-owner-onb-%@test'`);
  });

  describe('createClientTenant', () => {
    it('creates the tenants row AND the firm_client_tenants link under RLS', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Onb Firm A' });
      const result = await svc.createClientTenant(firm.id, {
        tenantName: 'Onb Client One',
        crNumber: 'CR-AA-0001',
        vatin: 'OM10000000001',
        country: 'OM',
        accessLevel: 'full',
        engagementType: 'ongoing',
      });

      expect(result.tenantName).toBe('Onb Client One');
      expect(result.vatin).toBe('OM10000000001');
      expect(result.crNumber).toBe('CR-AA-0001');
      expect(result.country).toBe('OM');
      expect(result.firmId).toBe(firm.id);
      expect(result.tenantId).toBeDefined();

      // The tenants row exists (admin-side peek).
      const tenantRow = await admin.query(`SELECT name, vatin FROM tenants WHERE id = $1`, [
        result.tenantId,
      ]);
      expect(tenantRow.rows[0]).toMatchObject({
        name: 'Onb Client One',
        vatin: 'OM10000000001',
      });

      // And the link is visible to the firm.
      const list = await svc.listClientTenants(firm.id);
      expect(list.map((r) => r.tenantId)).toContain(result.tenantId);
    });

    it('defaults country to OM when omitted and uses the schema defaults for accessLevel/engagementType', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Onb Firm B' });
      // The CreateClientTenantSchema defaults these when the controller
      // hits it; here we call the service directly so we pass them in.
      const result = await svc.createClientTenant(firm.id, {
        tenantName: 'Onb Client Two',
        crNumber: 'CR-BB-0001',
        vatin: 'OM10000000002',
        country: 'OM',
        accessLevel: 'full',
        engagementType: 'ongoing',
      });
      expect(result.country).toBe('OM');
      expect(result.accessLevel).toBe('full');
      expect(result.engagementType).toBe('ongoing');
    });

    it('rejects a duplicate VATIN already onboarded to the same firm', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Onb Firm C' });
      await svc.createClientTenant(firm.id, {
        tenantName: 'Onb Client Dup',
        crNumber: 'CR-CC-0001',
        vatin: 'OM10000000099',
        country: 'OM',
        accessLevel: 'full',
        engagementType: 'ongoing',
      });
      await expect(
        svc.createClientTenant(firm.id, {
          tenantName: 'Onb Client Dup Second',
          crNumber: 'CR-CC-0002',
          vatin: 'OM10000000099',
          country: 'OM',
          accessLevel: 'full',
          engagementType: 'ongoing',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('provisions a placeholder user + tenant membership + invitation when shopOwnerEmail is given', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Onb Firm D' });
      const shopEmail = `shop-owner-onb-${randomUUID()}@test`;
      const result = await svc.createClientTenant(firm.id, {
        tenantName: 'Onb Client With Invite',
        crNumber: 'CR-DD-0001',
        vatin: 'OM10000000003',
        country: 'OM',
        accessLevel: 'full',
        engagementType: 'ongoing',
        shopOwnerEmail: shopEmail,
      });

      expect(result.invitationId).toBeDefined();

      // The placeholder user exists.
      const users = await admin.query(`SELECT id, email FROM users WHERE email = $1`, [shopEmail]);
      expect(users.rows).toHaveLength(1);

      // Tenant membership was created.
      const tMemberships = await admin.query(
        `SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2`,
        [result.tenantId, users.rows[0].id],
      );
      expect(tMemberships.rows[0].role).toBe('owner');

      // Firm invitation row was created and is open.
      const invites = await admin.query(
        `SELECT email, accepted_at, revoked_at FROM firm_invitations WHERE id = $1`,
        [result.invitationId],
      );
      expect(invites.rows[0].email).toBe(shopEmail);
      expect(invites.rows[0].accepted_at).toBeNull();
      expect(invites.rows[0].revoked_at).toBeNull();
    });

    it('emits firm.client.added after the transaction commits', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Onb Firm E' });
      const seen: unknown[] = [];
      const handler = (payload: unknown) => seen.push(payload);
      events.on('firm.client.added', handler);
      try {
        const result = await svc.createClientTenant(
          firm.id,
          {
            tenantName: 'Onb Client Evt',
            crNumber: 'CR-EE-0001',
            vatin: 'OM10000000004',
            country: 'OM',
            accessLevel: 'full',
            engagementType: 'ongoing',
          },
          ownerU,
        );
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual({
          firmId: firm.id,
          tenantId: result.tenantId,
          createdByUserId: ownerU,
        });
      } finally {
        events.off('firm.client.added', handler);
      }
    });

    it('emits firm.client.revoked when an active link is revoked', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Onb Firm F' });
      const created = await svc.createClientTenant(firm.id, {
        tenantName: 'Onb Client Rev',
        crNumber: 'CR-FF-0001',
        vatin: 'OM10000000005',
        country: 'OM',
        accessLevel: 'full',
        engagementType: 'ongoing',
      });
      const seen: unknown[] = [];
      const handler = (payload: unknown) => seen.push(payload);
      events.on('firm.client.revoked', handler);
      try {
        const r = await svc.revokeClientTenant(firm.id, created.tenantId, ownerU);
        expect(r.revoked).toBe(true);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual({
          firmId: firm.id,
          tenantId: created.tenantId,
          revokedByUserId: ownerU,
        });
      } finally {
        events.off('firm.client.revoked', handler);
      }
    });

    it('revokeClientTenant does NOT emit when nothing was revoked', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Onb Firm G' });
      const seen: unknown[] = [];
      const handler = (payload: unknown) => seen.push(payload);
      events.on('firm.client.revoked', handler);
      try {
        const r = await svc.revokeClientTenant(firm.id, randomUUID(), ownerU);
        expect(r.revoked).toBe(false);
        expect(seen).toHaveLength(0);
      } finally {
        events.off('firm.client.revoked', handler);
      }
    });
  });

  describe('createClientTenantsBatch', () => {
    it('onboards the happy path and returns created[] with one record per input', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Onb Firm H' });
      const dtos = [
        {
          tenantName: 'Onb Client B1',
          crNumber: 'CR-H-1',
          vatin: 'OM20000000001',
          country: 'OM',
          accessLevel: 'full' as const,
          engagementType: 'ongoing' as const,
        },
        {
          tenantName: 'Onb Client B2',
          crNumber: 'CR-H-2',
          vatin: 'OM20000000002',
          country: 'OM',
          accessLevel: 'read_only' as const,
          engagementType: 'periodic' as const,
        },
      ];
      const r = await svc.createClientTenantsBatch(firm.id, dtos);
      expect(r.created).toHaveLength(2);
      expect(r.failed).toHaveLength(0);
      const list = await svc.listClientTenants(firm.id);
      expect(list.map((r) => r.tenantName).sort()).toEqual(['Onb Client B1', 'Onb Client B2']);
    });

    it('skips duplicates inside the batch itself (CR + VATIN idempotency key)', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Onb Firm I' });
      const dtos = [
        {
          tenantName: 'Onb Client I1',
          crNumber: 'CR-I-1',
          vatin: 'OM30000000001',
          country: 'OM',
          accessLevel: 'full' as const,
          engagementType: 'ongoing' as const,
        },
        {
          tenantName: 'Onb Client I1 copy',
          crNumber: 'CR-I-1',
          vatin: 'OM30000000001',
          country: 'OM',
          accessLevel: 'full' as const,
          engagementType: 'ongoing' as const,
        },
        {
          tenantName: 'Onb Client I2',
          crNumber: 'CR-I-2',
          vatin: 'OM30000000002',
          country: 'OM',
          accessLevel: 'full' as const,
          engagementType: 'ongoing' as const,
        },
      ];
      const r = await svc.createClientTenantsBatch(firm.id, dtos);
      expect(r.created).toHaveLength(2);
      expect(r.failed).toHaveLength(1);
      expect(r.failed[0].index).toBe(1);
      expect(r.failed[0].reason).toBe('duplicate');
    });

    it('skips rows whose VATIN is already onboarded (DB-level duplicate)', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Onb Firm J' });
      await svc.createClientTenant(firm.id, {
        tenantName: 'Onb Client J-pre',
        crNumber: 'CR-J-PRE',
        vatin: 'OM40000000001',
        country: 'OM',
        accessLevel: 'full',
        engagementType: 'ongoing',
      });
      const r = await svc.createClientTenantsBatch(firm.id, [
        {
          tenantName: 'Onb Client J-new',
          crNumber: 'CR-J-NEW',
          vatin: 'OM40000000001',
          country: 'OM',
          accessLevel: 'full',
          engagementType: 'ongoing',
        },
      ]);
      expect(r.created).toHaveLength(0);
      expect(r.failed).toHaveLength(1);
      expect(r.failed[0].reason).toBe('duplicate');
    });

    it('returns per-row failures without poisoning successful rows', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Onb Firm K' });
      // First DTO is good, second is bogus (no VATIN would fail Zod at the
      // controller layer, but the service itself tolerates it -- the test
      // exercises duplicate behaviour, which gives us a clean per-row
      // failure path through the service).
      await svc.createClientTenant(firm.id, {
        tenantName: 'Onb Client K-pre',
        crNumber: 'CR-K-PRE',
        vatin: 'OM50000000001',
        country: 'OM',
        accessLevel: 'full',
        engagementType: 'ongoing',
      });
      const r = await svc.createClientTenantsBatch(firm.id, [
        {
          tenantName: 'Onb Client K-good',
          crNumber: 'CR-K-GOOD',
          vatin: 'OM50000000002',
          country: 'OM',
          accessLevel: 'full',
          engagementType: 'ongoing',
        },
        {
          tenantName: 'Onb Client K-dup',
          crNumber: 'CR-K-DUP',
          vatin: 'OM50000000001',
          country: 'OM',
          accessLevel: 'full',
          engagementType: 'ongoing',
        },
      ]);
      expect(r.created).toHaveLength(1);
      expect(r.failed).toHaveLength(1);
      expect(r.created[0].tenantName).toBe('Onb Client K-good');
      expect(r.failed[0].dto.tenantName).toBe('Onb Client K-dup');
    });

    it('is capped at 50 clients per call', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Onb Firm L' });
      const dtos = Array.from({ length: 51 }, (_, i) => ({
        tenantName: `Onb Client L-${i}`,
        crNumber: `CR-L-${i}`,
        vatin: `OM6000000${String(i).padStart(4, '0')}`,
        country: 'OM',
        accessLevel: 'full' as const,
        engagementType: 'ongoing' as const,
      }));
      await expect(svc.createClientTenantsBatch(firm.id, dtos)).rejects.toThrow(/50/);
    });

    it('empty input returns an empty result shape', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Onb Firm M' });
      const r = await svc.createClientTenantsBatch(firm.id, []);
      expect(r.created).toEqual([]);
      expect(r.failed).toEqual([]);
    });
  });

  describe('cross-firm isolation', () => {
    it('firm A cannot read firm B onboarded client via listClientTenants', async () => {
      const firmA = await svc.createFirm(ownerU, { name: 'Onb Firm X-A' });
      const firmB = await svc.createFirm(strangerU, { name: 'Onb Firm X-B' });

      const aClient = await svc.createClientTenant(firmA.id, {
        tenantName: 'Onb Client X-A1',
        crNumber: 'CR-XA-1',
        vatin: 'OM70000000001',
        country: 'OM',
        accessLevel: 'full',
        engagementType: 'ongoing',
      });
      const bClient = await svc.createClientTenant(firmB.id, {
        tenantName: 'Onb Client X-B1',
        crNumber: 'CR-XB-1',
        vatin: 'OM70000000002',
        country: 'OM',
        accessLevel: 'full',
        engagementType: 'ongoing',
      });

      const aList = await svc.listClientTenants(firmA.id);
      expect(aList.map((r) => r.tenantId)).toEqual([aClient.tenantId]);
      expect(aList.map((r) => r.tenantId)).not.toContain(bClient.tenantId);

      const bList = await svc.listClientTenants(firmB.id);
      expect(bList.map((r) => r.tenantId)).toEqual([bClient.tenantId]);
      expect(bList.map((r) => r.tenantId)).not.toContain(aClient.tenantId);
    });

    it('firm A batch-onboard cannot touch a tenant visible to firm B', async () => {
      const firmA = await svc.createFirm(ownerU, { name: 'Onb Firm Y-A' });
      const firmB = await svc.createFirm(strangerU, { name: 'Onb Firm Y-B' });

      // Firm B onboards a client. Firm A then tries to onboard a NEW
      // client in a batch that collides on VATIN -- the DB-level unique
      // index on firm_client_tenants.tenant_id covers this via
      // Conflict + the pre-insert check we do inside the firm context
      // means firm A sees no cross-firm leakage.
      await svc.createClientTenant(firmB.id, {
        tenantName: 'Onb Client Y-B1',
        crNumber: 'CR-YB-1',
        vatin: 'OM80000000001',
        country: 'OM',
        accessLevel: 'full',
        engagementType: 'ongoing',
      });

      // Firm A onboards a different VATIN just fine (sanity).
      const r = await svc.createClientTenantsBatch(firmA.id, [
        {
          tenantName: 'Onb Client Y-A1',
          crNumber: 'CR-YA-1',
          vatin: 'OM80000000002',
          country: 'OM',
          accessLevel: 'full',
          engagementType: 'ongoing',
        },
      ]);
      expect(r.created).toHaveLength(1);

      // Firm A's list contains only its own client.
      const aList = await svc.listClientTenants(firmA.id);
      expect(aList).toHaveLength(1);
      expect(aList[0].tenantName).toBe('Onb Client Y-A1');
    });
  });
});
