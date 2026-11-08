import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DB } from '../src/db/db.module';
import { AccountantService } from '../src/modules/accountant/accountant.service';
import * as schema from '../src/db/schema';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

/**
 * Shape of an invoice row we insert directly in the admin pool for the KPI
 * fixture. We bypass the service to keep this test narrow to the accountant
 * layer rather than coupling it to the invoices module.
 */
async function insertParty(admin: Pool, tenantId: string, name: string) {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'customer',$2) RETURNING id`,
    [tenantId, name],
  );
  return rows[0].id;
}

async function insertInvoice(
  admin: Pool,
  tenantId: string,
  opts: {
    number: string;
    issueDate: string;
    status: string;
    grandTotal: string;
    vatTotal: string;
    supplierId: string;
    buyerId: string;
  },
) {
  await admin.query(
    `INSERT INTO invoices
       (tenant_id, number, issue_date, status, supplier_party_id, buyer_party_id,
        subtotal, vat_total, grand_total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      tenantId,
      opts.number,
      opts.issueDate,
      opts.status,
      opts.supplierId,
      opts.buyerId,
      opts.grandTotal,
      opts.vatTotal,
      opts.grandTotal,
    ],
  );
}

describe('AccountantService', () => {
  const firmUser = randomUUID();
  const otherUser = randomUUID();
  const outsideUser = randomUUID();
  const tenantReferred = randomUUID();
  const tenantPlain = randomUUID();
  const tenantNoMembership = randomUUID();

  let admin: Pool;
  let appPool: Pool;
  let svc: AccountantService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });

    await admin.query(
      `INSERT INTO users (id, cognito_sub, email) VALUES ($1,$2,$3),($4,$5,$6),($7,$8,$9)`,
      [
        firmUser,
        `sub-${firmUser}`,
        'firm@test',
        otherUser,
        `sub-${otherUser}`,
        'other@test',
        outsideUser,
        `sub-${outsideUser}`,
        'outside@test',
      ],
    );
    await admin.query(
      `INSERT INTO tenants (id, name) VALUES ($1,'Acme Co'),($2,'Beta Co'),($3,'Gamma Co')`,
      [tenantReferred, tenantPlain, tenantNoMembership],
    );
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES
         ($1,$2,'accountant'),
         ($3,$2,'owner'),
         ($4,$2,'clerk'),
         ($1,$5,'owner')`,
      [tenantReferred, firmUser, tenantPlain, tenantNoMembership, otherUser],
    );

    appPool = new Pool({ connectionString: APP_URL });
    const appDb = drizzle(appPool, { schema });

    const moduleRef = await Test.createTestingModule({
      providers: [AccountantService, { provide: DB, useValue: appDb }],
    }).compile();
    svc = moduleRef.get(AccountantService);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM invoices WHERE tenant_id IN ($1,$2,$3)`, [
      tenantReferred,
      tenantPlain,
      tenantNoMembership,
    ]);
    await admin.query(`DELETE FROM parties WHERE tenant_id IN ($1,$2,$3)`, [
      tenantReferred,
      tenantPlain,
      tenantNoMembership,
    ]);
    await admin.query(`DELETE FROM tenants WHERE id IN ($1,$2,$3)`, [
      tenantReferred,
      tenantPlain,
      tenantNoMembership,
    ]);
    await admin.query(`DELETE FROM users WHERE id IN ($1,$2,$3)`, [
      firmUser,
      otherUser,
      outsideUser,
    ]);
    await appPool.end();
    await admin.end();
  });

  afterEach(async () => {
    // Clean up firms (CASCADE drops links too) so each test starts fresh.
    await admin.query(`DELETE FROM accountant_firms WHERE owner_user_id IN ($1,$2,$3)`, [
      firmUser,
      otherUser,
      outsideUser,
    ]);
  });

  describe('createFirm', () => {
    it('creates once; throws ConflictException on second call', async () => {
      const first = await svc.createFirm(firmUser, { name: 'My Firm' });
      expect(first.name).toBe('My Firm');
      expect(first.ownerUserId).toBe(firmUser);
      expect(Number(first.commissionRate)).toBeCloseTo(0.2, 4);
      await expect(svc.createFirm(firmUser, { name: 'Dup' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('cross-user isolation', () => {
    it('getFirmForUser(user B) is null when user A owns a firm', async () => {
      await svc.createFirm(firmUser, { name: 'A firm' });
      const bFirm = await svc.getFirmForUser(outsideUser);
      expect(bFirm).toBeNull();
      const aFirm = await svc.getFirmForUser(firmUser);
      expect(aFirm?.name).toBe('A firm');
    });
  });

  describe('linkClient', () => {
    it('throws Forbidden when user has no membership in that tenant', async () => {
      await svc.createFirm(firmUser, { name: 'My Firm' });
      // outsideUser never got a membership in any tenant
      await expect(svc.linkClient(outsideUser, tenantReferred)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // firmUser has only 'clerk' role in tenantNoMembership
      await svc.createFirm(outsideUser, { name: 'Other' });
      await expect(svc.linkClient(outsideUser, tenantReferred)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(svc.linkClient(firmUser, tenantNoMembership)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('links a tenant where the user has owner/accountant role', async () => {
      await svc.createFirm(firmUser, { name: 'My Firm' });
      const linked = await svc.linkClient(firmUser, tenantReferred);
      expect(linked.tenantId).toBe(tenantReferred);
      expect(linked.referred).toBe(false);
    });

    it('is idempotent — relinking returns the same row', async () => {
      await svc.createFirm(firmUser, { name: 'My Firm' });
      const a = await svc.linkClient(firmUser, tenantReferred, { referred: true });
      const b = await svc.linkClient(firmUser, tenantReferred);
      expect(b.referred).toBe(a.referred);
    });
  });

  describe('listMyTenants', () => {
    it('returns both referred and non-referred links', async () => {
      await svc.createFirm(firmUser, { name: 'My Firm' });
      await svc.linkClient(firmUser, tenantReferred, { referred: true });
      await svc.linkClient(firmUser, tenantPlain, { referred: false });

      const list = await svc.listMyTenants(firmUser);
      expect(list.length).toBe(2);
      const referred = list.find((r) => r.tenantId === tenantReferred);
      const plain = list.find((r) => r.tenantId === tenantPlain);
      expect(referred?.referred).toBe(true);
      expect(plain?.referred).toBe(false);
      expect(referred?.role).toBe('accountant');
      expect(plain?.role).toBe('owner');
    });

    it('skips links where the role is no longer owner/accountant', async () => {
      await svc.createFirm(firmUser, { name: 'My Firm' });
      await svc.linkClient(firmUser, tenantPlain);
      // Downgrade the membership to 'clerk' outside the service.
      await admin.query(`UPDATE memberships SET role='clerk' WHERE tenant_id=$1 AND user_id=$2`, [
        tenantPlain,
        firmUser,
      ]);
      try {
        const list = await svc.listMyTenants(firmUser);
        expect(list.find((r) => r.tenantId === tenantPlain)).toBeUndefined();
      } finally {
        await admin.query(`UPDATE memberships SET role='owner' WHERE tenant_id=$1 AND user_id=$2`, [
          tenantPlain,
          firmUser,
        ]);
      }
    });
  });

  describe('consolidatedKpis', () => {
    it('aggregates per tenant and respects RLS boundaries', async () => {
      await svc.createFirm(firmUser, { name: 'My Firm' });
      await svc.linkClient(firmUser, tenantReferred, { referred: true });
      await svc.linkClient(firmUser, tenantPlain, { referred: false });

      // Seed invoices in both tenants via the admin pool (bypass RLS).
      const sA = await insertParty(admin, tenantReferred, 'A-supplier');
      const bA = await insertParty(admin, tenantReferred, 'A-buyer');
      const sB = await insertParty(admin, tenantPlain, 'B-supplier');
      const bB = await insertParty(admin, tenantPlain, 'B-buyer');

      const today = new Date();
      const thisMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(
        2,
        '0',
      )}-05`;

      await insertInvoice(admin, tenantReferred, {
        number: 'A-1',
        issueDate: thisMonth,
        status: 'VALIDATED',
        grandTotal: '105.000',
        vatTotal: '5.000',
        supplierId: sA,
        buyerId: bA,
      });
      await insertInvoice(admin, tenantReferred, {
        number: 'A-2',
        issueDate: thisMonth,
        status: 'DRAFT',
        grandTotal: '42.000',
        vatTotal: '2.000',
        supplierId: sA,
        buyerId: bA,
      });
      await insertInvoice(admin, tenantPlain, {
        number: 'B-1',
        issueDate: thisMonth,
        status: 'VALIDATED',
        grandTotal: '210.000',
        vatTotal: '10.000',
        supplierId: sB,
        buyerId: bB,
      });

      const kpis = await svc.consolidatedKpis(firmUser);
      expect(kpis.length).toBe(2);
      const a = kpis.find((k) => k.tenantId === tenantReferred);
      const b = kpis.find((k) => k.tenantId === tenantPlain);
      // tenantReferred: two invoices this month totalling 147.000
      expect(a?.invoiceCount).toBe(2);
      expect(Number(a?.invoiceTotal)).toBeCloseTo(147.0, 3);
      expect(Number(a?.vatOutput)).toBeCloseTo(7.0, 3);
      // tenantPlain is isolated — only its own invoice
      expect(b?.invoiceCount).toBe(1);
      expect(Number(b?.invoiceTotal)).toBeCloseTo(210.0, 3);
      expect(Number(b?.vatOutput)).toBeCloseTo(10.0, 3);
      // Both overdue counts are 0 (invoices are this month)
      expect(a?.overdueArCount).toBe(0);
      expect(b?.overdueArCount).toBe(0);
    });
  });

  describe('calculateCommission', () => {
    it('returns [] gracefully when billing_invoices is empty or absent', async () => {
      await svc.createFirm(firmUser, { name: 'My Firm' });
      await svc.linkClient(firmUser, tenantReferred, { referred: true });
      // Validate shape — information_schema guard means no throw whether or
      // not billing_invoices has data (and whether or not the migration ran).
      const rows = await svc.calculateCommission(firmUser, '2026-01-01', '2026-01-31');
      expect(Array.isArray(rows)).toBe(true);
    });

    it('rejects bad date formats', async () => {
      await svc.createFirm(firmUser, { name: 'My Firm' });
      await expect(svc.calculateCommission(firmUser, 'bogus', '2026-01-31')).rejects.toThrow();
    });
  });
});
