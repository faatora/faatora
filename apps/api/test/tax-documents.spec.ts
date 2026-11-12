/**
 * Unit tests for tax-documents DTO validation and service rules.
 *
 * These tests avoid the full Nest + Postgres fixture setup (which the
 * firms / audit / clearance specs use) and instead exercise the
 * service against a minimally mocked DB. This gives us fast feedback
 * on the guard rails that matter most:
 *   - DTO: class-validator surface (whitelist, required fields)
 *   - service: the "original invoice must be CLEARED" rule,
 *     cross-tenant refusal, happy-path UBL emission.
 *
 * Integration coverage of the firm-tenant RLS gates is shared with
 * the existing firm-rls / firm-imports-rls specs; this file deliberately
 * mocks out `withFirmTenant` so the business-rule logic can be reasoned
 * about in isolation.
 */

import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CreateTaxDocumentDto } from '../src/modules/tax-documents/dto/create-tax-document.dto';
import { TaxDocumentsService } from '../src/modules/tax-documents/tax-documents.service';

/* -------------------------------------------------------------------------- */
/* DTO                                                                        */
/* -------------------------------------------------------------------------- */

describe('CreateTaxDocumentDto validation', () => {
  function build(body: Record<string, unknown>): CreateTaxDocumentDto {
    return plainToInstance(CreateTaxDocumentDto, body);
  }

  // A valid v4 UUID — class-validator's @IsUUID() enforces RFC 4122
  // version bits.
  const SOME_UUID = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';

  it('accepts a valid single-line body', async () => {
    const dto = build({
      number: 'CN-0001',
      issueDate: '2026-10-20',
      originalInvoiceId: SOME_UUID,
      lines: [
        {
          description: 'Refund widget',
          quantity: 1,
          unitPrice: 10,
          vatCategory: 'S',
          vatRate: 5,
        },
      ],
    });
    const errors = await validate(dto);
    expect(errors).toEqual([]);
  });

  it('rejects empty lines array', async () => {
    const dto = build({
      number: 'CN-0001',
      issueDate: '2026-10-20',
      originalInvoiceId: SOME_UUID,
      lines: [],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toMatch(/lines/);
  });

  it('rejects a non-UUID originalInvoiceId', async () => {
    const dto = build({
      number: 'CN-0001',
      issueDate: '2026-10-20',
      originalInvoiceId: 'not-a-uuid',
      lines: [{ description: 'x', quantity: 1, unitPrice: 1 }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toMatch(/originalInvoiceId/);
  });

  it('rejects a bad date', async () => {
    const dto = build({
      number: 'CN-0001',
      issueDate: 'not-a-date',
      originalInvoiceId: SOME_UUID,
      lines: [{ description: 'x', quantity: 1, unitPrice: 1 }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toMatch(/issueDate/);
  });

  it('rejects negative unit price', async () => {
    const dto = build({
      number: 'CN-0001',
      issueDate: '2026-10-20',
      originalInvoiceId: SOME_UUID,
      lines: [{ description: 'x', quantity: 1, unitPrice: -1 }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a stub transaction that returns the given rows for each
 * table identifier the service queries. The service uses Drizzle's
 * fluent `select().from(TABLE).where(...).limit(1)` so we intercept
 * at `.from(TABLE)` and switch on the imported table reference.
 */
function makeFakeTx(opts: {
  invoiceRow?: Record<string, unknown> | null;
  supplierRow?: Record<string, unknown> | null;
  buyerRow?: Record<string, unknown> | null;
}): {
  tx: unknown;
  inserted: { headers: unknown[]; lines: unknown[] };
} {
  const inserted = { headers: [] as unknown[], lines: [] as unknown[] };

  function stubSelect(rows: unknown[]): unknown {
    return {
      from() {
        return this;
      },
      where() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return Promise.resolve(rows);
      },
      then(resolve: (v: unknown[]) => unknown) {
        return Promise.resolve(rows).then(resolve);
      },
    };
  }

  // Match on the drizzle table _.name metadata which is attached as
  // Symbol-keyed data; easier: look at the tableName property set by
  // drizzle, which is accessible via the Drizzle `getTableName` helper
  // but here we just look at the shape of the rows the test wants.
  // We track a call counter to route SELECTs by order: first SELECT is
  // the original invoice, second = supplier, third = buyer.
  let selectIdx = 0;
  const rowsByCall: unknown[][] = [
    opts.invoiceRow ? [opts.invoiceRow] : [],
    opts.supplierRow ? [opts.supplierRow] : [],
    opts.buyerRow ? [opts.buyerRow] : [],
  ];

  const tx: Record<string, unknown> = {
    select() {
      const rows = rowsByCall[selectIdx] ?? [];
      selectIdx++;
      return stubSelect(rows);
    },
    insert() {
      return {
        values(v: unknown) {
          return {
            returning() {
              // Push and echo back whatever was inserted so the
              // service's post-insert reads see what a real db would.
              if (Array.isArray(v)) {
                inserted.lines.push(...v);
                return Promise.resolve(v);
              } else {
                const row = { id: 'new-doc-id', ...(v as Record<string, unknown>) };
                inserted.headers.push(row);
                return Promise.resolve([row]);
              }
            },
          };
        },
      };
    },
    execute() {
      return Promise.resolve({ rows: [] });
    },
  };

  return { tx, inserted };
}

/** Build a DB stub whose `transaction` method runs the handler with the
 *  fake tx, mirroring `withFirmTenant`'s behaviour just enough for the
 *  service under test. */
function makeFakeDb(tx: unknown): unknown {
  return {
    transaction<T>(fn: (tx: unknown) => Promise<T>) {
      return fn(tx);
    },
  };
}

// withFirmTenant hits firm_client_tenants to assert engagement. We patch
// the module so it skips that gate for these unit tests.
jest.mock('../src/db/with-firm-tenant', () => ({
  withFirmTenant: async <T>(
    _db: unknown,
    _firmId: string,
    _tenantId: string,
    fn: (tx: unknown) => Promise<T>,
  ) => {
    const { tx } = (globalThis as { __taxDocTestFakeTx?: { tx: unknown } }).__taxDocTestFakeTx ?? {
      tx: {},
    };
    return fn(tx);
  },
}));

describe('TaxDocumentsService', () => {
  const firmId = '11111111-1111-1111-1111-111111111111';
  const tenantId = '22222222-2222-2222-2222-222222222222';
  const userId = '33333333-3333-3333-3333-333333333333';
  const invoiceId = '44444444-4444-4444-4444-444444444444';

  function build(opts: {
    invoiceRow?: Record<string, unknown> | null;
    supplierRow?: Record<string, unknown> | null;
    buyerRow?: Record<string, unknown> | null;
  }): { svc: TaxDocumentsService; inserted: { headers: unknown[]; lines: unknown[] } } {
    const { tx, inserted } = makeFakeTx(opts);
    (globalThis as { __taxDocTestFakeTx?: { tx: unknown } }).__taxDocTestFakeTx = { tx };
    const events = new EventEmitter2();
    const svc = new TaxDocumentsService(makeFakeDb(tx) as never, events);
    return { svc, inserted };
  }

  const validSupplier = {
    id: 'sup-1',
    name: 'Faatora LLC',
    vatin: 'OM1100000001',
    country: 'OM',
  };
  const validBuyer = {
    id: 'buy-1',
    name: 'Buyer SAOC',
    vatin: 'OM1100000002',
    country: 'OM',
  };

  const dto = plainToInstance(CreateTaxDocumentDto, {
    number: 'CN-0001',
    issueDate: '2026-10-20',
    originalInvoiceId: invoiceId,
    lines: [
      {
        description: 'Refund widget',
        quantity: 2,
        unitPrice: 10,
        vatCategory: 'S',
        vatRate: 5,
      },
    ],
  });

  it('refuses when the original invoice does not exist (404)', async () => {
    const { svc } = build({ invoiceRow: null });
    await expect(svc.create(firmId, tenantId, 'credit_note', userId, dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses when the original invoice belongs to a different tenant (404)', async () => {
    const otherTenant = '99999999-9999-9999-9999-999999999999';
    const { svc } = build({
      invoiceRow: {
        id: invoiceId,
        tenantId: otherTenant,
        status: 'CLEARED',
        number: 'INV-0001',
        currency: 'OMR',
        issueDate: '2026-10-01',
        supplierPartyId: 'sup-1',
        buyerPartyId: 'buy-1',
      },
    });
    await expect(svc.create(firmId, tenantId, 'credit_note', userId, dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses when the original invoice is not yet CLEARED', async () => {
    const { svc } = build({
      invoiceRow: {
        id: invoiceId,
        tenantId,
        status: 'DRAFT',
        number: 'INV-0001',
        currency: 'OMR',
        issueDate: '2026-10-01',
        supplierPartyId: 'sup-1',
        buyerPartyId: 'buy-1',
      },
    });
    await expect(svc.create(firmId, tenantId, 'credit_note', userId, dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('emits a CreditNote UBL (CreditNote-2 namespace, type 381) on happy path', async () => {
    const { svc } = build({
      invoiceRow: {
        id: invoiceId,
        tenantId,
        status: 'CLEARED',
        number: 'INV-0001',
        currency: 'OMR',
        issueDate: '2026-10-01',
        supplierPartyId: 'sup-1',
        buyerPartyId: 'buy-1',
      },
      supplierRow: validSupplier,
      buyerRow: validBuyer,
    });
    const result = await svc.create(firmId, tenantId, 'credit_note', userId, dto);
    expect(result.kind).toBe('credit_note');
    expect(result.ublXml).toContain(
      'xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"',
    );
    expect(result.ublXml).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>');
    expect(result.ublXml).toContain('<cbc:ID>INV-0001</cbc:ID>'); // billing ref
    // 2 * 10 = 20.000 OMR net, +5% = 21.000.
    expect(result.subtotal).toBe('20.000');
    expect(result.vatTotal).toBe('1.000');
    expect(result.grandTotal).toBe('21.000');
  });

  it('emits a DebitNote UBL (Invoice-2 namespace, type 383) on happy path', async () => {
    const { svc } = build({
      invoiceRow: {
        id: invoiceId,
        tenantId,
        status: 'CLEARED',
        number: 'INV-0002',
        currency: 'OMR',
        issueDate: '2026-10-01',
        supplierPartyId: 'sup-1',
        buyerPartyId: 'buy-1',
      },
      supplierRow: validSupplier,
      buyerRow: validBuyer,
    });
    const result = await svc.create(firmId, tenantId, 'debit_note', userId, dto);
    expect(result.kind).toBe('debit_note');
    expect(result.ublXml).toContain(
      'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
    );
    expect(result.ublXml).toContain('<cbc:InvoiceTypeCode>383</cbc:InvoiceTypeCode>');
    expect(result.ublXml).toContain('<cac:BillingReference>');
    expect(result.ublXml).toContain('<cbc:ID>INV-0002</cbc:ID>');
  });

  it('emits a firm.tax_document.created event on success', async () => {
    const { svc } = build({
      invoiceRow: {
        id: invoiceId,
        tenantId,
        status: 'CLEARED',
        number: 'INV-0003',
        currency: 'OMR',
        issueDate: '2026-10-01',
        supplierPartyId: 'sup-1',
        buyerPartyId: 'buy-1',
      },
      supplierRow: validSupplier,
      buyerRow: validBuyer,
    });
    const events = (svc as unknown as { events: EventEmitter2 }).events;
    const spy = jest.fn();
    events.on('firm.tax_document.created', spy);
    await svc.create(firmId, tenantId, 'credit_note', userId, dto);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      firmId,
      tenantId,
      kind: 'credit_note',
      number: 'CN-0001',
      actorUserId: userId,
    });
  });
});
