import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { LocalSigner } from '../src/modules/signing/local-signer';
import { generateQrPng, buildQrPayload } from '../src/modules/signing/qr';
import { SigningService } from '../src/modules/signing/signing.service';
import type { Signer } from '../src/modules/signing/signer.port';

describe('LocalSigner', () => {
  const signer = new LocalSigner();
  const payload = Buffer.from('hello faatora', 'utf8');

  it('produces a non-empty base64 signature', async () => {
    const r = await signer.sign(payload);
    expect(r.algorithm).toBe('RSA-SHA256');
    expect(r.keyId).toBe('local-dev-key');
    expect(typeof r.signatureValue).toBe('string');
    expect(r.signatureValue.length).toBeGreaterThan(0);
    expect(() => Buffer.from(r.signatureValue, 'base64')).not.toThrow();
    expect(Buffer.from(r.signatureValue, 'base64').length).toBeGreaterThan(0);
  });

  it('verifies its own signature over the same bytes', async () => {
    const r = await signer.sign(payload);
    const ok = await signer.verify(payload, r.signatureValue);
    expect(ok).toBe(true);
  });

  it('rejects a signature over different bytes', async () => {
    const r = await signer.sign(payload);
    const ok = await signer.verify(Buffer.from('tampered', 'utf8'), r.signatureValue);
    expect(ok).toBe(false);
  });

  it('exposes a public key PEM', () => {
    const pem = signer.getPublicKeyPem();
    expect(pem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(pem).toContain('-----END PUBLIC KEY-----');
  });
});

describe('generateQrPng', () => {
  it('returns a base64 string that decodes to a PNG', async () => {
    const payload = JSON.stringify(
      buildQrPayload({
        uuid: '00000000-0000-0000-0000-000000000000',
        number: 'INV-TEST-001',
        issueDate: '2026-10-17',
        grandTotal: '105.000',
        vatTotal: '5.000',
        supplierVatin: 'OM1234567890',
      }),
    );
    const b64 = await generateQrPng(payload);
    expect(typeof b64).toBe('string');
    expect(b64.startsWith('iVBOR')).toBe(true);
    const buf = Buffer.from(b64, 'base64');
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});

/**
 * Scripted transaction mock. The service runs its select/update/insert calls
 * in a known, fixed order; we feed it the responses in that order rather than
 * matching on table identity (which is brittle against drizzle internals).
 */
interface Script {
  selectResults: unknown[][];
  inserted: Array<Record<string, unknown>>;
  updated: Array<Record<string, unknown>>;
}

function makeDbFromScript(script: Script) {
  let selectIdx = 0;
  const terminal = (data: unknown[]) => ({
    limit: async () => data,
    orderBy: async () => data,
  });
  const tx = {
    select() {
      const data = script.selectResults[selectIdx++] ?? [];
      return {
        from: () => ({
          where: () => terminal(data),
        }),
      };
    },
    update() {
      return {
        set: (v: Record<string, unknown>) => ({
          where: async () => {
            script.updated.push(v);
            return [];
          },
        }),
      };
    },
    insert() {
      return {
        values: async (v: Record<string, unknown>) => {
          script.inserted.push(v);
          return [];
        },
      };
    },
    execute: async () => undefined,
  };
  return {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  };
}

const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '55555555-5555-5555-5555-555555555555';
const INVOICE_ID = '11111111-1111-1111-1111-111111111111';
const SUPPLIER_ID = '33333333-3333-3333-3333-333333333333';
const BUYER_ID = '66666666-6666-6666-6666-666666666666';

function invoiceFixture(status: string, documentUuid: string | null = null) {
  return {
    id: INVOICE_ID,
    tenantId: TENANT_ID,
    type: 'invoice',
    number: 'INV-TEST-001',
    documentUuid,
    status,
    currency: 'OMR',
    issueDate: '2026-10-17',
    supplierPartyId: SUPPLIER_ID,
    buyerPartyId: BUYER_ID,
    subtotal: '100.000',
    vatTotal: '5.000',
    grandTotal: '105.000',
    notes: null,
  };
}

function supplierFixture() {
  return {
    id: SUPPLIER_ID,
    tenantId: TENANT_ID,
    kind: 'supplier',
    name: 'Faatora Supplier LLC',
    vatin: 'OM1234567890',
    country: 'OM',
    peppolId: null,
    address: null,
  };
}

function buyerFixture() {
  return {
    id: BUYER_ID,
    tenantId: TENANT_ID,
    kind: 'customer',
    name: 'Faatora Buyer LLC',
    vatin: 'OM0987654321',
    country: 'OM',
    peppolId: null,
    address: null,
  };
}

function lineFixtures() {
  return [
    {
      id: 'line-1',
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      lineNo: 1,
      description: 'Widget',
      quantity: '2.000',
      unitCode: 'C62',
      unitPrice: '50.000',
      vatCategory: 'S',
      vatRate: '5.00',
      lineNet: '100.000',
    },
  ];
}

const fakeSigner: Signer = {
  async sign() {
    return { signatureValue: 'ZmFrZS1zaWc=', algorithm: 'RSA-SHA256', keyId: 'local-dev-key' };
  },
  async verify() {
    return true;
  },
};

describe('SigningService', () => {
  it('rejects when invoice status is not VALIDATED', async () => {
    const script: Script = {
      selectResults: [[invoiceFixture('DRAFT')]],
      inserted: [],
      updated: [],
    };
    const db = makeDbFromScript(script) as never;
    const svc = new SigningService(db, fakeSigner);
    await expect(svc.sign(TENANT_ID, INVOICE_ID, USER_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects when invoice is not found', async () => {
    const script: Script = { selectResults: [[]], inserted: [], updated: [] };
    const db = makeDbFromScript(script) as never;
    const svc = new SigningService(db, fakeSigner);
    await expect(svc.sign(TENANT_ID, INVOICE_ID, USER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses to run when supplier party not found for this tenant', async () => {
    const script: Script = {
      selectResults: [
        [invoiceFixture('VALIDATED')], // invoices
        [], // supplier lookup returns nothing (not visible in this tenant)
      ],
      inserted: [],
      updated: [],
    };
    const db = makeDbFromScript(script) as never;
    const svc = new SigningService(db, fakeSigner);
    await expect(svc.sign(TENANT_ID, INVOICE_ID, USER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses to run when buyer party not found for this tenant', async () => {
    const script: Script = {
      selectResults: [
        [invoiceFixture('VALIDATED')], // invoices
        [supplierFixture()], // supplier found
        [], // buyer lookup returns nothing
      ],
      inserted: [],
      updated: [],
    };
    const db = makeDbFromScript(script) as never;
    const svc = new SigningService(db, fakeSigner);
    await expect(svc.sign(TENANT_ID, INVOICE_ID, USER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rebuilds UBL server-side, signs, updates, and inserts', async () => {
    const script: Script = {
      selectResults: [
        [invoiceFixture('VALIDATED')], // invoices
        [supplierFixture()],
        [buyerFixture()],
        lineFixtures(),
      ],
      inserted: [],
      updated: [],
    };
    const db = makeDbFromScript(script) as never;
    const svc = new SigningService(db, fakeSigner);

    const outcome = await svc.sign(TENANT_ID, INVOICE_ID, USER_ID);

    expect(outcome.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.documentUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(outcome.signatureValue).toBe('ZmFrZS1zaWc=');
    expect(outcome.pdfBase64.length).toBeGreaterThan(0);
    expect(outcome.qrPngBase64.length).toBeGreaterThan(0);

    const statusUpdate = script.updated.find((u) => u.status === 'SIGNED');
    expect(statusUpdate).toBeDefined();
    expect(statusUpdate?.documentUuid).toBe(outcome.documentUuid);

    const signedRow = script.inserted.find((r) => r.sha256 === outcome.sha256);
    expect(signedRow).toBeDefined();
    expect(signedRow?.signatureAlgorithm).toBe('RSA-SHA256');
    expect(signedRow?.keyId).toBe('local-dev-key');
    expect(signedRow?.tenantId).toBe(TENANT_ID);
    expect(signedRow?.invoiceId).toBe(INVOICE_ID);
    // The signed XML must be server-rebuilt UBL, not any client string.
    const signedXml = signedRow?.signedXml as string;
    expect(typeof signedXml).toBe('string');
    expect(signedXml.length).toBeGreaterThan(0);
    expect(signedXml).toContain('<cbc:ID>INV-TEST-001</cbc:ID>');
    // sha256 must match the bytes we actually wrote.
    const expected = createHash('sha256').update(signedXml, 'utf8').digest('hex');
    expect(signedRow?.sha256).toBe(expected);
    expect(typeof signedRow?.qrPngBase64).toBe('string');
    expect((signedRow?.qrPngBase64 as string).length).toBeGreaterThan(0);
  });

  it('reuses an existing documentUuid rather than generating a new one', async () => {
    const existingUuid = '44444444-4444-4444-4444-444444444444';
    const script: Script = {
      selectResults: [
        [invoiceFixture('VALIDATED', existingUuid)],
        [supplierFixture()],
        [buyerFixture()],
        lineFixtures(),
      ],
      inserted: [],
      updated: [],
    };
    const db = makeDbFromScript(script) as never;
    const svc = new SigningService(db, fakeSigner);
    const outcome = await svc.sign(TENANT_ID, INVOICE_ID, USER_ID);
    expect(outcome.documentUuid).toBe(existingUuid);
  });
});
