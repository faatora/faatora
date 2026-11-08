import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  validateInvoice,
  type CanonicalInvoice,
  type SemanticInvoice,
  type ValidationReport,
} from '../src/index.js';

interface Fixture {
  canonical?: CanonicalInvoice;
  semantic?: SemanticInvoice;
  expected: {
    ok: boolean;
    errorRules?: string[];
    warningRules?: string[];
  };
  _note?: string;
}

interface RunSummary {
  file: string;
  ok: boolean;
  expectedOk: boolean;
  errorRules: string[];
  warningRules: string[];
}

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures');

function loadFixtures(): Array<{ name: string; data: Fixture }> {
  const files = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((f) => ({
    name: f,
    data: JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')) as Fixture,
  }));
}

/** Collect-and-print summary so a CI reader can glance at the whole corpus. */
const summary: RunSummary[] = [];

afterAll(() => {
  if (summary.length === 0) return;
  // One-line-per-fixture table. Keep columns narrow so CI logs stay readable.
  const header = `\n[corpus] ${summary.length} fixtures\n` + `${'file'.padEnd(42)}  ok?  rules`;
  const rows = summary.map((s) => {
    const ok = s.ok === s.expectedOk ? '✓' : '✗';
    const rulesLabel =
      s.errorRules.length === 0 && s.warningRules.length === 0
        ? '(none)'
        : [
            s.errorRules.length ? `errors=${s.errorRules.join(',')}` : '',
            s.warningRules.length ? `warnings=${s.warningRules.join(',')}` : '',
          ]
            .filter(Boolean)
            .join('  ');
    return `${s.file.padEnd(42)}  ${ok}    ${rulesLabel}`;
  });
  console.log([header, ...rows].join('\n'));
});

describe('golden corpus', () => {
  const fixtures = loadFixtures();

  it('finds the expected number of fixtures (8 valid + 7 invalid = 15)', () => {
    const valids = fixtures.filter((f) => f.name.startsWith('valid-'));
    const invalids = fixtures.filter((f) => f.name.startsWith('invalid-'));
    expect(valids.length).toBe(8);
    expect(invalids.length).toBe(7);
    expect(fixtures.length).toBe(15);
  });

  for (const { name, data } of fixtures) {
    it(`fixture: ${name}`, () => {
      let report: ValidationReport;
      if (data.semantic) {
        report = validateInvoice({ semantic: data.semantic });
      } else if (data.canonical) {
        report = validateInvoice({ canonical: data.canonical });
      } else {
        throw new Error(`fixture ${name} has neither canonical nor semantic input`);
      }

      summary.push({
        file: name,
        ok: report.ok,
        expectedOk: data.expected.ok,
        errorRules: report.errors.map((e) => e.rule),
        warningRules: report.warnings.map((w) => w.rule),
      });

      // Verdict matches.
      expect(report.ok).toBe(data.expected.ok);

      // Every expected error rule is present (may have extra ones on invalid
      // fixtures where a cascade is realistic).
      const observedRules = new Set(report.errors.map((e) => e.rule));
      for (const expectedRule of data.expected.errorRules ?? []) {
        if (!observedRules.has(expectedRule)) {
          throw new Error(
            `${name}: expected error rule "${expectedRule}" not emitted. ` +
              `Observed: [${[...observedRules].join(', ') || '(none)'}]`,
          );
        }
      }

      // Every expected warning rule is present.
      const observedWarnings = new Set(report.warnings.map((w) => w.rule));
      for (const expectedWarn of data.expected.warningRules ?? []) {
        if (!observedWarnings.has(expectedWarn)) {
          throw new Error(
            `${name}: expected warning "${expectedWarn}" not emitted. ` +
              `Observed warnings: [${[...observedWarnings].join(', ') || '(none)'}]`,
          );
        }
      }

      // Valid fixtures must not emit any error.
      if (data.expected.ok) {
        if (report.errors.length !== 0) {
          throw new Error(
            `${name}: expected no errors, got [${report.errors
              .map((e) => `${e.rule}:${e.message}`)
              .join(' | ')}]`,
          );
        }
      }
    });
  }
});
