const SCALE = 1000;
const round = (n: number): number => Math.round(n);
const toMinor = (major: number): number => round(major * SCALE);
const toMajor = (minor: number): number => minor / SCALE;
export interface LineInput {
  quantity: number;
  unitPrice: number;
  vatCategory: string;
  vatRate: number;
}
export interface VatBreakdownEntry {
  category: string;
  rate: number;
  taxable: number;
  tax: number;
}
export interface Totals {
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
  vatBreakdown: VatBreakdownEntry[];
  lineNets: number[];
}
export function computeTotals(lines: LineInput[]): Totals {
  const lineNetsMinor = lines.map((l) => round(l.quantity * toMinor(l.unitPrice)));
  const groups = new Map<string, { category: string; rate: number; taxableMinor: number }>();
  lines.forEach((l, i) => {
    const key = `${l.vatCategory}|${l.vatRate}`;
    const g = groups.get(key) ?? { category: l.vatCategory, rate: l.vatRate, taxableMinor: 0 };
    g.taxableMinor += lineNetsMinor[i];
    groups.set(key, g);
  });
  let subtotalMinor = 0,
    vatTotalMinor = 0;
  const vatBreakdown: VatBreakdownEntry[] = [];
  for (const g of groups.values()) {
    const taxMinor = round((g.taxableMinor * g.rate) / 100);
    subtotalMinor += g.taxableMinor;
    vatTotalMinor += taxMinor;
    vatBreakdown.push({
      category: g.category,
      rate: g.rate,
      taxable: toMajor(g.taxableMinor),
      tax: toMajor(taxMinor),
    });
  }
  return {
    subtotal: toMajor(subtotalMinor),
    vatTotal: toMajor(vatTotalMinor),
    grandTotal: toMajor(subtotalMinor + vatTotalMinor),
    vatBreakdown,
    lineNets: lineNetsMinor.map(toMajor),
  };
}
