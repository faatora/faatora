import { assessReadiness } from '../src/modules/leads/readiness';
import type { CreateLeadDto } from '../src/modules/leads/dto/create-lead.dto';
const baseLead = (overrides: Partial<CreateLeadDto> = {}): CreateLeadDto => ({
  email: 'founder@example.om',
  fullName: 'Said Al-Harthy',
  companyName: 'Example LLC',
  phone: '+968 9123 4567',
  revenueBand: '500k-1M',
  currentTool: 'Zoho Books',
  invoiceVolumeBand: '100-500',
  b2cShare: '0',
  erp: 'Zoho',
  vatRegistered: true,
  ...overrides,
});
describe('assessReadiness', () => {
  it('marks a VAT-registered Zoho user with low volume as ready', () => {
    const v = assessReadiness(baseLead());
    expect(v.ready).toBe(true);
    expect(v.score).toBe(100);
    expect(v.blockers).toEqual([]);
    expect(v.deadline).toBe('2027-10-01');
  });
  it('uses the April deadline when revenueBand is >5M', () => {
    const v = assessReadiness(baseLead({ revenueBand: '>5M' }));
    expect(v.deadline).toBe('2027-04-01');
  });
  it('flags excel + >2000 volume as not ready with multiple blockers', () => {
    const v = assessReadiness(
      baseLead({
        currentTool: 'Excel spreadsheets',
        invoiceVolumeBand: '>2000',
        erp: undefined,
      }),
    );
    expect(v.ready).toBe(false);
    expect(v.blockers).toContain("Current invoicing tool won't produce PINT-OM/UBL 2.1 XML");
    expect(v.blockers).toContain('High volume on manual tooling');
    expect(v.score).toBeLessThan(70);
  });
  it('recommends ERP connection when volume >=500-2000 and erp missing', () => {
    const v = assessReadiness(
      baseLead({ currentTool: 'Odoo', invoiceVolumeBand: '500-2000', erp: '' }),
    );
    expect(v.recommendations).toContain('Connect to a supported ERP/accounting system');
  });
  it('recommends B2C batching for B2C-heavy VAT-registered sellers', () => {
    const v = assessReadiness(baseLead({ b2cShare: '>50' }));
    expect(v.recommendations).toContain('Enable B2C 24h batching mode');
    expect(v.ready).toBe(true);
    expect(v.score).toBe(95);
  });
  it('recommends VAT registration without adding a blocker', () => {
    const v = assessReadiness(baseLead({ vatRegistered: false }));
    expect(v.recommendations).toContain('Register for VAT if applicable');
    expect(v.blockers).toEqual([]);
    expect(v.ready).toBe(true);
  });
});
