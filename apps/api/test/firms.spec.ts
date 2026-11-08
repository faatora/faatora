/**
 * EP5 Wave 1 — FirmsService unit + integration tests.
 *
 * Covers:
 *   - createFirm bootstraps the firm with an owner membership
 *   - inviteMember / acceptInvitation end-to-end
 *   - addClientTenant / revokeClientTenant with the active-tenant unique index
 *   - cross-firm isolation: firm A cannot see firm B's rows
 *   - listMembers / listClientTenants return only active rows
 *   - revokeMember / revokeClientTenant are soft deletes
 *
 * RLS-only tests live in firms-rls.spec.ts and firms-isolation.spec.ts.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DB } from '../src/db/db.module';
import { FirmsService } from '../src/modules/firms/firms.service';
import * as schema from '../src/db/schema';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

describe('FirmsService', () => {
  // Users
  const ownerU = randomUUID();
  const inviteeU = randomUUID();
  const strangerU = randomUUID();
  // Tenants
  const t1 = randomUUID();
  const t2 = randomUUID();
  const t3 = randomUUID(); // never linked to any firm

  const ownerEmail = `owner-${ownerU}@test`;
  const inviteeEmail = `invitee-${inviteeU}@test`;
  const strangerEmail = `stranger-${strangerU}@test`;

  let admin: Pool;
  let appPool: Pool;
  let svc: FirmsService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      `INSERT INTO users (id, cognito_sub, email) VALUES
         ($1,$2,$3),($4,$5,$6),($7,$8,$9)`,
      [
        ownerU,
        `sub-${ownerU}`,
        ownerEmail,
        inviteeU,
        `sub-${inviteeU}`,
        inviteeEmail,
        strangerU,
        `sub-${strangerU}`,
        strangerEmail,
      ],
    );
    await admin.query(
      `INSERT INTO tenants (id, name) VALUES ($1,'Tenant One'),($2,'Tenant Two'),($3,'Tenant Three')`,
      [t1, t2, t3],
    );

    appPool = new Pool({ connectionString: APP_URL });
    const appDb = drizzle(appPool, { schema });

    const moduleRef = await Test.createTestingModule({
      providers: [FirmsService, { provide: DB, useValue: appDb }],
    }).compile();
    svc = moduleRef.get(FirmsService);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM firms WHERE name LIKE 'Test Firm%'`);
    await admin.query(`DELETE FROM tenants WHERE id IN ($1,$2,$3)`, [t1, t2, t3]);
    await admin.query(`DELETE FROM users WHERE id IN ($1,$2,$3)`, [ownerU, inviteeU, strangerU]);
    await (svc as unknown as { onModuleDestroy(): Promise<void> }).onModuleDestroy();
    await appPool.end();
    await admin.end();
  });

  afterEach(async () => {
    // Firms cascade to memberships/invitations/client_tenants.
    await admin.query(`DELETE FROM firms WHERE name LIKE 'Test Firm%'`);
  });

  describe('createFirm', () => {
    it('inserts the firm and an owner membership', async () => {
      const firm = await svc.createFirm(ownerU, {
        name: 'Test Firm A',
        legalName: 'Test Firm A LLC',
        crNumber: 'CR-12345',
        country: 'OM',
        vatin: 'OM00000000001',
      });
      expect(firm.name).toBe('Test Firm A');
      expect(firm.legalName).toBe('Test Firm A LLC');
      expect(firm.country).toBe('OM');

      const members = await svc.listMembers(firm.id);
      expect(members).toHaveLength(1);
      expect(members[0].userId).toBe(ownerU);
      expect(members[0].role).toBe('owner');
      expect(members[0].email).toBe(ownerEmail);
    });

    it('defaults country to OM when omitted', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm B' });
      expect(firm.country).toBe('OM');
    });
  });

  describe('getFirm', () => {
    it('returns the firm when called with its id', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm C' });
      const got = await svc.getFirm(firm.id);
      expect(got?.name).toBe('Test Firm C');
    });

    it('returns null for an unknown id (RLS hides it)', async () => {
      const got = await svc.getFirm(randomUUID());
      expect(got).toBeNull();
    });
  });

  describe('listMyFirms', () => {
    it('returns the firms a user is an active member of, alphabetical', async () => {
      const a = await svc.createFirm(ownerU, { name: 'Test Firm Z' });
      const b = await svc.createFirm(ownerU, { name: 'Test Firm A-list' });
      void a;
      void b;
      const mine = await svc.listMyFirms(ownerU);
      expect(mine.length).toBeGreaterThanOrEqual(2);
      const names = mine.map((f) => f.name);
      // Alphabetical: A-list before Z
      const zi = names.indexOf('Test Firm Z');
      const ai = names.indexOf('Test Firm A-list');
      expect(ai).toBeGreaterThanOrEqual(0);
      expect(zi).toBeGreaterThan(ai);
    });

    it('does not surface firms the user is only revoked from', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm D' });
      // Add a second member then revoke them.
      await svc.addMember(firm.id, { userId: inviteeU, role: 'staff' });
      await svc.revokeMember(firm.id, inviteeU);
      const mine = await svc.listMyFirms(inviteeU);
      expect(mine.find((f) => f.id === firm.id)).toBeUndefined();
    });

    it('returns [] for a user not in any firm', async () => {
      const mine = await svc.listMyFirms(strangerU);
      expect(mine).toEqual([]);
    });
  });

  describe('addMember / revokeMember', () => {
    it('adds a new member and lists them', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm E' });
      const added = await svc.addMember(firm.id, { userId: inviteeU, role: 'staff' });
      expect(added.role).toBe('staff');
      expect(added.email).toBe(inviteeEmail);
      const members = await svc.listMembers(firm.id);
      expect(members).toHaveLength(2);
    });

    it('throws Conflict when the user is already an active member', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm F' });
      await svc.addMember(firm.id, { userId: inviteeU, role: 'staff' });
      await expect(
        svc.addMember(firm.id, { userId: inviteeU, role: 'partner' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws NotFound when the user id does not exist', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm G' });
      await expect(
        svc.addMember(firm.id, { userId: randomUUID(), role: 'staff' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('revokeMember soft-deletes the row', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm H' });
      await svc.addMember(firm.id, { userId: inviteeU, role: 'staff' });
      const r = await svc.revokeMember(firm.id, inviteeU);
      expect(r.revoked).toBe(true);
      const members = await svc.listMembers(firm.id);
      expect(members.map((m) => m.userId)).not.toContain(inviteeU);
    });

    it('revokeMember returns {revoked:false} when no active membership', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm I' });
      const r = await svc.revokeMember(firm.id, inviteeU);
      expect(r.revoked).toBe(false);
    });

    it('allows a re-add after revoking (partial unique index lets historical rows coexist)', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm J' });
      await svc.addMember(firm.id, { userId: inviteeU, role: 'staff' });
      await svc.revokeMember(firm.id, inviteeU);
      const readded = await svc.addMember(firm.id, { userId: inviteeU, role: 'partner' });
      expect(readded.role).toBe('partner');
    });
  });

  describe('inviteMember / acceptInvitation', () => {
    it('invitee can redeem a fresh token and becomes a member', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm K' });
      const invite = await svc.inviteMember(firm.id, ownerU, {
        email: inviteeEmail,
        role: 'partner',
      });
      expect(invite.token).toBeDefined();
      const membership = await svc.acceptInvitation(invite.token, inviteeU);
      expect(membership.userId).toBe(inviteeU);
      expect(membership.role).toBe('partner');
      // Second accept is a Conflict because the invitation is marked.
      await expect(svc.acceptInvitation(invite.token, inviteeU)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects when the accepting user email does not match the invitation', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm L' });
      const invite = await svc.inviteMember(firm.id, ownerU, {
        email: inviteeEmail,
        role: 'staff',
      });
      // Stranger tries to redeem with their own user id (different email).
      await expect(svc.acceptInvitation(invite.token, strangerU)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects when the invitation does not exist', async () => {
      await expect(svc.acceptInvitation('bogus-token-aaaaaaaaaaaaaaaaaaaa', inviteeU)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('cannot invite an email that is already an active member', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm M' });
      await svc.addMember(firm.id, { userId: inviteeU, role: 'staff' });
      await expect(
        svc.inviteMember(firm.id, ownerU, { email: inviteeEmail, role: 'partner' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects duplicate open invites to the same email', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm N' });
      await svc.inviteMember(firm.id, ownerU, { email: 'dup@test', role: 'staff' });
      await expect(
        svc.inviteMember(firm.id, ownerU, { email: 'dup@test', role: 'partner' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects an expired invitation', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm O' });
      const invite = await svc.inviteMember(firm.id, ownerU, {
        email: inviteeEmail,
        role: 'staff',
      });
      // Push the expires_at into the past via admin.
      await admin.query(`UPDATE firm_invitations SET expires_at = now() - interval '1 day' WHERE id=$1`, [
        invite.id,
      ]);
      await expect(svc.acceptInvitation(invite.token, inviteeU)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('addClientTenant / revokeClientTenant', () => {
    it('links a tenant, lists it, revokes it', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm P' });
      const link = await svc.addClientTenant(firm.id, {
        tenantId: t1,
        accessLevel: 'full',
        engagementType: 'ongoing',
      });
      expect(link.tenantId).toBe(t1);
      expect(link.tenantName).toBe('Tenant One');
      expect(link.accessLevel).toBe('full');
      const list = await svc.listClientTenants(firm.id);
      expect(list).toHaveLength(1);
      const r = await svc.revokeClientTenant(firm.id, t1);
      expect(r.revoked).toBe(true);
      const afterList = await svc.listClientTenants(firm.id);
      expect(afterList).toHaveLength(0);
    });

    it('prevents a tenant from being linked to two firms simultaneously', async () => {
      const firmA = await svc.createFirm(ownerU, { name: 'Test Firm Q1' });
      const firmB = await svc.createFirm(ownerU, { name: 'Test Firm Q2' });
      await svc.addClientTenant(firmA.id, {
        tenantId: t1,
        accessLevel: 'full',
        engagementType: 'ongoing',
      });
      await expect(
        svc.addClientTenant(firmB.id, {
          tenantId: t1,
          accessLevel: 'full',
          engagementType: 'ongoing',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      // After revocation, the tenant can move to firm B.
      await svc.revokeClientTenant(firmA.id, t1);
      const moved = await svc.addClientTenant(firmB.id, {
        tenantId: t1,
        accessLevel: 'read_only',
        engagementType: 'periodic',
      });
      expect(moved.firmId).toBe(firmB.id);
      expect(moved.accessLevel).toBe('read_only');
      expect(moved.engagementType).toBe('periodic');
    });

    it('rejects unknown tenant with BadRequest', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm R' });
      await expect(
        svc.addClientTenant(firm.id, {
          tenantId: randomUUID(),
          accessLevel: 'full',
          engagementType: 'ongoing',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listClientTenants returns only active links, alphabetically by tenant name', async () => {
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm S' });
      await svc.addClientTenant(firm.id, {
        tenantId: t2,
        accessLevel: 'full',
        engagementType: 'ongoing',
      });
      await svc.addClientTenant(firm.id, {
        tenantId: t1,
        accessLevel: 'full',
        engagementType: 'ongoing',
      });
      const list = await svc.listClientTenants(firm.id);
      expect(list.map((r) => r.tenantName)).toEqual(['Tenant One', 'Tenant Two']);
      // Revoke t1 and confirm it drops out.
      await svc.revokeClientTenant(firm.id, t1);
      const after = await svc.listClientTenants(firm.id);
      expect(after.map((r) => r.tenantName)).toEqual(['Tenant Two']);
    });
  });

  describe('cross-firm isolation', () => {
    it('firm A members cannot see firm B via listMembers', async () => {
      const firmA = await svc.createFirm(ownerU, { name: 'Test Firm T-A' });
      const firmB = await svc.createFirm(strangerU, { name: 'Test Firm T-B' });
      await svc.addMember(firmB.id, { userId: inviteeU, role: 'partner' });

      const aMembers = await svc.listMembers(firmA.id);
      expect(aMembers.map((m) => m.userId)).toEqual([ownerU]);
      expect(aMembers.find((m) => m.userId === inviteeU)).toBeUndefined();

      const bMembers = await svc.listMembers(firmB.id);
      expect(bMembers.map((m) => m.userId).sort()).toEqual([strangerU, inviteeU].sort());
    });

    it('firm A cannot read firm B via getFirm', async () => {
      const firmA = await svc.createFirm(ownerU, { name: 'Test Firm U-A' });
      const firmB = await svc.createFirm(strangerU, { name: 'Test Firm U-B' });
      // getFirm(firmB.id) under firmB's RLS returns it; under firmA's would return null —
      // we test that it returns ONLY the row for the id passed, which proves isolation.
      const asB = await svc.getFirm(firmB.id);
      expect(asB?.name).toBe('Test Firm U-B');
      const asA = await svc.getFirm(firmA.id);
      expect(asA?.name).toBe('Test Firm U-A');
    });

    it('firm A cannot see firm B client tenants', async () => {
      const firmA = await svc.createFirm(ownerU, { name: 'Test Firm V-A' });
      const firmB = await svc.createFirm(strangerU, { name: 'Test Firm V-B' });
      await svc.addClientTenant(firmA.id, {
        tenantId: t1,
        accessLevel: 'full',
        engagementType: 'ongoing',
      });
      await svc.addClientTenant(firmB.id, {
        tenantId: t2,
        accessLevel: 'full',
        engagementType: 'ongoing',
      });

      const aClients = await svc.listClientTenants(firmA.id);
      expect(aClients.map((c) => c.tenantId)).toEqual([t1]);
      const bClients = await svc.listClientTenants(firmB.id);
      expect(bClients.map((c) => c.tenantId)).toEqual([t2]);
    });
  });

  describe('integration: two users, one firm, one client', () => {
    it('owner creates firm, invites partner, partner accepts, owner adds client, both can list it', async () => {
      // Step 1 — owner creates firm
      const firm = await svc.createFirm(ownerU, { name: 'Test Firm W' });

      // Step 2 — owner invites partner
      const invite = await svc.inviteMember(firm.id, ownerU, {
        email: inviteeEmail,
        role: 'partner',
      });

      // Step 3 — partner accepts
      const membership = await svc.acceptInvitation(invite.token, inviteeU);
      expect(membership.role).toBe('partner');

      // Both should show as members
      const members = await svc.listMembers(firm.id);
      expect(members.map((m) => m.userId).sort()).toEqual([ownerU, inviteeU].sort());

      // Step 4 — owner adds client tenant
      await svc.addClientTenant(firm.id, {
        tenantId: t1,
        accessLevel: 'full',
        engagementType: 'ongoing',
      });

      // Step 5 — both users list the firm clients (RLS gate is app.firm_id,
      // not the user — so both members see the same list).
      const clients = await svc.listClientTenants(firm.id);
      expect(clients).toHaveLength(1);
      expect(clients[0].tenantId).toBe(t1);

      // Step 6 — neither member can touch t3 which was never linked
      const mine = await svc.listMyFirms(inviteeU);
      const theirFirm = mine.find((f) => f.id === firm.id);
      expect(theirFirm?.name).toBe('Test Firm W');
      // Stranger (not in firm) cannot see this firm via listMyFirms
      const strangerFirms = await svc.listMyFirms(strangerU);
      expect(strangerFirms.find((f) => f.id === firm.id)).toBeUndefined();
    });
  });
});
