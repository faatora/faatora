/**
 * Unit tests for the i18n audit script.
 *
 * We exercise the pure helpers (`flatten`, `runAudit`, `scanFileForHardcodedStrings`)
 * against fixtures rather than invoking the full `main()` entry point. This
 * keeps the tests hermetic and fast — no file writes, no console noise.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flatten, runAudit, scanFileForHardcodedStrings, type AuditResult } from './i18n-audit';

function makeFixture(): { webRoot: string; i18nRoot: string; cleanup: () => void } {
  const webRoot = mkdtempSync(join(tmpdir(), 'faatora-i18n-audit-'));
  const i18nRoot = join(webRoot, 'src', 'i18n');
  mkdirSync(i18nRoot, { recursive: true });
  mkdirSync(join(webRoot, 'src', 'pages'), { recursive: true });
  return {
    webRoot,
    i18nRoot,
    cleanup: () => rmSync(webRoot, { recursive: true, force: true }),
  };
}

describe('flatten', () => {
  it('keeps string leaves and joins paths with a dot', () => {
    const out = flatten({
      brand: 'Faatora',
      nav: { en: 'English', ar: 'Arabic' },
      checker: { result: { score: 'Score' } },
    });
    expect(out).toEqual({
      brand: 'Faatora',
      'nav.en': 'English',
      'nav.ar': 'Arabic',
      'checker.result.score': 'Score',
    });
  });

  it('ignores non-string leaves (arrays, numbers, null)', () => {
    const out = flatten({
      a: 'ok',
      b: 42 as unknown as string,
      c: ['nope'] as unknown as string,
      d: null as unknown as string,
    });
    expect(out).toEqual({ a: 'ok' });
  });
});

describe('runAudit', () => {
  let fx: ReturnType<typeof makeFixture>;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  it('flags missing, empty, stale and identical values', () => {
    const en = {
      brand: 'Faatora',
      hello: 'Hello',
      only_in_en: 'Only EN',
      duplicated: 'Same',
      interpolated: '{{name}}',
      empty_candidate: 'Has value',
    };
    const ar = {
      brand: 'Faatora', // exempt
      hello: 'مرحبا',
      only_in_ar: 'يتيم',
      duplicated: 'Same', // suspicious
      interpolated: '{{name}}', // exempt (pattern)
      empty_candidate: '   ',
    };
    writeFileSync(join(fx.i18nRoot, 'en.json'), JSON.stringify(en), 'utf8');
    writeFileSync(join(fx.i18nRoot, 'ar.json'), JSON.stringify(ar), 'utf8');

    const result: AuditResult = runAudit({ webRoot: fx.webRoot, i18nRoot: fx.i18nRoot });
    expect(result.totalEnKeys).toBe(6);
    expect(result.totalArKeys).toBe(6);
    expect(result.missingInAr).toEqual(['only_in_en']);
    expect(result.staleInAr).toEqual(['only_in_ar']);
    expect(result.emptyInAr).toEqual(['empty_candidate']);
    expect(result.identicalValues).toEqual(['duplicated']);
  });

  it('has a stable, documented shape', () => {
    writeFileSync(join(fx.i18nRoot, 'en.json'), '{}');
    writeFileSync(join(fx.i18nRoot, 'ar.json'), '{}');
    const result = runAudit({ webRoot: fx.webRoot, i18nRoot: fx.i18nRoot });
    // The test harness relies on these fields being present with these types.
    expect(result).toMatchObject({
      locales: ['en', 'ar'],
      totalEnKeys: 0,
      totalArKeys: 0,
      missingInAr: [],
      emptyInAr: [],
      staleInAr: [],
      identicalValues: [],
      hardcodedStrings: [],
    });
  });
});

describe('scanFileForHardcodedStrings', () => {
  it('flags aria-label literals that are not wrapped in t()', () => {
    const src = `
      export function X() {
        return <div role="group" aria-label="Language" />;
      }
    `;
    const findings = scanFileForHardcodedStrings('/tmp/X.tsx', src, '/tmp');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'attribute', text: 'Language', line: 3 });
  });

  it('flags prepositions sitting between two JSX interpolations', () => {
    const src = `
      export function P({ a, b }: { a: string; b: string }) {
        return <span>{a} to {b}</span>;
      }
    `;
    const findings = scanFileForHardcodedStrings('/tmp/P.tsx', src, '/tmp');
    expect(findings.some((f) => f.text === 'to')).toBe(true);
  });

  it('does not confuse try/catch/finally braces with JSX text', () => {
    const src = `
      export async function Q() {
        try {
          await doThing();
        } catch (e) {
          setError(String(e));
        } finally {
          done();
        }
        return null;
      }
    `;
    const findings = scanFileForHardcodedStrings('/tmp/Q.tsx', src, '/tmp');
    // None of "catch" / "finally" should slip through.
    expect(findings.map((f) => f.text)).not.toContain('catch');
    expect(findings.map((f) => f.text)).not.toContain('finally');
  });

  it('does not flag TypeScript generics as JSX text', () => {
    const src = `
      interface Props {
        onChange: (ev: React.ChangeEvent<HTMLInputElement>) => void;
      }
      export function F(_: Props) {
        const p: Promise<void> = Promise.resolve();
        void p;
        return null;
      }
    `;
    const findings = scanFileForHardcodedStrings('/tmp/F.tsx', src, '/tmp');
    expect(findings).toEqual([]);
  });

  it('does not flag JSX text that is already wrapped in t()', () => {
    const src = `
      import { useTranslation } from 'react-i18next';
      export function H() {
        const { t } = useTranslation();
        return <button>{t('pos.print')}</button>;
      }
    `;
    const findings = scanFileForHardcodedStrings('/tmp/H.tsx', src, '/tmp');
    expect(findings).toEqual([]);
  });

  it('flags validator error strings pushed into an errors array (.ts file)', () => {
    const src = `
      export function validate(x: { name: string }): string[] {
        const errors: string[] = [];
        if (!x.name) errors.push('name is required');
        return errors;
      }
    `;
    const findings = scanFileForHardcodedStrings('/tmp/v.ts', src, '/tmp');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'string-literal', text: 'name is required' });
  });
});
