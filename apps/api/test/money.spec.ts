import { computeTotals } from '../src/modules/invoices/money';
describe('computeTotals', () => {
  it('computes standard-rate line totals', () => {
    const t = computeTotals([{ quantity: 3, unitPrice: 10, vatCategory: 'S', vatRate: 5 }]);
    expect(t.subtotal).toBe(30);
    expect(t.vatTotal).toBe(1.5);
    expect(t.grandTotal).toBe(31.5);
  });
  it('groups by category+rate', () => {
    const t = computeTotals([
      { quantity: 1, unitPrice: 100, vatCategory: 'S', vatRate: 5 },
      { quantity: 2, unitPrice: 50, vatCategory: 'Z', vatRate: 0 },
    ]);
    expect(t.subtotal).toBe(200);
    expect(t.vatTotal).toBe(5);
    expect(t.grandTotal).toBe(205);
  });
  it('rounds in baisa without float drift', () => {
    const t = computeTotals([{ quantity: 1, unitPrice: 0.105, vatCategory: 'S', vatRate: 5 }]);
    expect(t.subtotal).toBe(0.105);
    expect(t.vatTotal).toBe(0.005);
    expect(t.grandTotal).toBe(0.11);
  });
});
