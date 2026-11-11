/**
 * i18n audit for the Faatora web app.
 *
 * Loads every en and ar translation bundle (currently only `src/i18n/*.json`
 * in each locale, kept open-ended for a future split into feature-scoped
 * files) and reports:
 *
 *   1. Keys present in en but missing (or empty) in ar.
 *   2. Keys present in ar but missing in en (stale).
 *   3. Keys whose en and ar values are literally identical — a reliable
 *      signal that ar was never actually translated (brand names, numeric
 *      format strings and single-character glyphs are excluded via a
 *      configurable allow-list below).
 *
 * It also greps the src tree for string literals passed as JSX children
 * or as human-facing attributes (placeholder/title/alt/aria-label) that
 * are NOT wrapped in `t(...)`. The grep is intentionally conservative:
 * bare identifiers (`{variable}`) and anything that looks like a
 * className / data-testid / id value is excluded. The result is written
 * to `UNTRANSLATED-STRINGS.md` with file paths and line numbers.
 *
 * Produces four artifacts in --out-dir (default: this script's directory):
 *   - i18n-audit-report.md      — human-readable summary
 *   - i18n-audit-report.json    — machine-readable summary (consumed by tests)
 *   - UNTRANSLATED-STRINGS.md   — list of hardcoded strings to refactor
 *
 * Run:
 *   node --experimental-strip-types apps/web/scripts/i18n-audit.ts
 *   # or
 *   tsx apps/web/scripts/i18n-audit.ts
 *
 * Exit code: 0 always; this is a reporter, not a gate.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, '..');
const srcRoot = resolve(webRoot, 'src');
const i18nRoot = resolve(srcRoot, 'i18n');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

export interface AuditResult {
  locales: string[];
  totalEnKeys: number;
  totalArKeys: number;
  missingInAr: string[];
  emptyInAr: string[];
  staleInAr: string[];
  identicalValues: string[];
  hardcodedStrings: HardcodedString[];
}

export interface HardcodedString {
  file: string;
  line: number;
  kind: 'jsx-text' | 'attribute' | 'string-literal';
  text: string;
  context: string;
}

// -----------------------------------------------------------------------------
// JSON loading + flattening
// -----------------------------------------------------------------------------

function loadJson(path: string): Record<string, JsonValue> {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as Record<string, JsonValue>;
}

/**
 * Walk every leaf in a nested object; return a flat `a.b.c` -> value map.
 * Only string leaves are kept — numbers / booleans / null / arrays are rare
 * in react-i18next bundles and would be a code smell anyway.
 */
export function flatten(obj: Record<string, JsonValue>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      out[key] = v;
    } else if (typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v as Record<string, JsonValue>, key));
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Translation-equality allow-list
// -----------------------------------------------------------------------------

/**
 * Values that are legitimately the same in both locales — brand names,
 * well-known product names, acronyms, and purely-numeric or symbolic strings.
 * Keeping this list explicit so that any new "identical" case is a deliberate
 * exemption, not an invisible gap.
 */
const IDENTICAL_EXEMPT_VALUES = new Set<string>([
  // product + tool names that don't translate
  'Faatora',
  'Zoho Books CSV',
  'OMR',
]);

const IDENTICAL_EXEMPT_PATTERNS: RegExp[] = [
  /^\d[\d\s.,+\-/]*$/, // pure numeric / dates
  /^[\p{P}\p{S}]+$/u, // pure punctuation / symbols
  /^\{\{[\w.]+\}\}$/, // single interpolation like "{{email}}"
];

function isIdenticalExempt(value: string): boolean {
  if (IDENTICAL_EXEMPT_VALUES.has(value)) return true;
  return IDENTICAL_EXEMPT_PATTERNS.some((rx) => rx.test(value));
}

// -----------------------------------------------------------------------------
// Hardcoded-string scanner
// -----------------------------------------------------------------------------

const JSX_EXTENSIONS = new Set(['.tsx', '.jsx']);
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.jsx']);
const SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '__snapshots__', 'scripts']);
const SCAN_SKIP_FILES = new Set(['vite-env.d.ts']);

/** Chars that mean the text probably isn't user-facing copy. */
const NON_COPY_RE = /^[\s\-_/\\.|<>+*()[\]{}!?#%&:;,0-9]+$/;

function walkSrcFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = readdirSync(current);
    for (const name of entries) {
      if (SCAN_SKIP_DIRS.has(name)) continue;
      if (SCAN_SKIP_FILES.has(name)) continue;
      const full = join(current, name);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!TS_EXTENSIONS.has(extname(name))) continue;
      if (name.endsWith('.test.tsx') || name.endsWith('.spec.tsx')) continue;
      if (name.endsWith('.test.ts') || name.endsWith('.spec.ts')) continue;
      if (name.endsWith('.d.ts')) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * Pull out suspicious hardcoded strings from a TSX file. Conservative:
 * false positives are tolerable but we try hard to avoid flagging CSS
 * class names, test IDs, routes, DOM attribute values that are not
 * user-visible, and anything already inside a `t(` call.
 *
 * The scanner is line-based and intentionally simple — it is not a real
 * TSX parser, but it is deterministic and cheap enough to run in CI.
 */
export function scanFileForHardcodedStrings(
  path: string,
  source: string,
  rootForRelative: string,
): HardcodedString[] {
  const findings: HardcodedString[] = [];
  const relPath = relative(rootForRelative, path);
  const lines = source.split(/\r?\n/);
  const isJsx = JSX_EXTENSIONS.has(extname(path));
  if (!isJsx) {
    // For plain .ts files we only look for error / message strings that are
    // likely to reach the user through a React state setter. Skip all JSX
    // passes to keep the scanner from flagging generics and operators.
    return scanTsForMessageStrings(path, source, rootForRelative);
  }

  // --- Pass 1: JSX text between tags ---------------------------------------
  // Matches '>TEXT<' where TEXT looks like user-facing copy. We deliberately
  // avoid matching TypeScript generics (`<HTMLInputElement>`, `Promise<void>`),
  // comparison operators (`>=`, `<=`) and arrow functions by guarding the
  // '>' and '<' delimiters. The scanner is line-based, so cross-line JSX
  // is not reported (an acceptable trade-off — these cases are rare and
  // usually have a wrapping tag we can key off separately).
  const JSX_TEXT_RE = /(^|[^=<>/!])>(?!=)([^<>{}\n]{2,})<(?![=<])/g;
  const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|\/\*)/;
  const TYPE_LINE_RE = /^\s*(?:import|export)\b|^\s*(?:interface|type)\b/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE_RE.test(line)) continue;
    if (TYPE_LINE_RE.test(line)) continue;
    // Function signature lines are full of generics and arrows; skip the
    // common ones where the full line is a signature rather than JSX.
    if (/^\s*(const|function|type|interface)\s/.test(line) && !/<[A-Za-z][^<>]*>[^<]/.test(line)) {
      // (A signature line that actually renders JSX would have a tag after
      // the generic; otherwise no JSX children are possible.)
      continue;
    }
    let m: RegExpExecArray | null;
    JSX_TEXT_RE.lastIndex = 0;
    while ((m = JSX_TEXT_RE.exec(line)) !== null) {
      const raw = m[2].trim();
      if (!raw) continue;
      if (NON_COPY_RE.test(raw)) continue;
      if (/\{/.test(raw)) continue;
      if (!/[A-Za-z؀-ۿ]/.test(raw)) continue;
      if (raw.startsWith('/') && raw.includes('/')) continue;
      // Entity-only ("&nbsp;" etc.) is not user copy — skip.
      if (/^&[a-z]+;$/.test(raw)) continue;
      // A single capitalised word that is almost certainly a type parameter
      // (`Promise<void>`, `Array<string>`): these are unlikely inside a tsx
      // line with JSX markup. Require either a space, punctuation, or a
      // lowercase letter so that bare `PascalCase` doesn't register.
      if (/^[A-Z][A-Za-z]*$/.test(raw)) continue;
      findings.push({
        file: relPath,
        line: i + 1,
        kind: 'jsx-text',
        text: raw,
        context: line.trim(),
      });
    }
  }

  // --- Pass 2: user-facing attributes --------------------------------------
  // placeholder/title/alt/aria-label with a quoted string literal (not a
  // JSX-expression). We skip values that look like format examples (contain
  // digits/plus/dashes only) and those wrapped in t(...).
  const ATTR_RE =
    /\b(placeholder|title|alt|aria-label|aria-description)\s*=\s*(["'])((?:(?!\2).)*)\2/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(line)) !== null) {
      const text = m[3].trim();
      if (!text) continue;
      if (NON_COPY_RE.test(text)) continue;
      // Format examples and headers used for CSV / column names
      if (/^[+\d\s,.-]+$/.test(text)) continue;
      if (!/[A-Za-z؀-ۿ]/.test(text)) continue;
      // Values that are plainly code (comma-separated no spaces and lowerCamel)
      if (/^[a-z][\w]*(,[a-z][\w]*)+$/.test(text)) continue;
      findings.push({
        file: relPath,
        line: i + 1,
        kind: 'attribute',
        text,
        context: line.trim(),
      });
    }
  }

  // --- Pass 3a: text sitting between two JSX interpolations ---------------
  // Catches cases like `{a} to {b}` where the connecting word is a bare
  // string that was never passed through t(). We look for `}TEXT{` on a
  // line that also contains a JSX tag opener somewhere.
  if (/<[A-Za-z]/.test(source.slice(0, 2000)) /* file has JSX somewhere */) {
    const BETWEEN_INTERP_RE = /\}\s*([A-Za-z][A-Za-z؀-ۿ' .,:;!?-]{1,40})\s*\{/g;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (COMMENT_LINE_RE.test(line)) continue;
      // Keep the search narrow: the line must either sit between JSX
      // tags (common case) or itself open with an interpolation that
      // continues on the next tag. The containing file was already
      // confirmed to be JSX above, so we can afford to be permissive.
      let m: RegExpExecArray | null;
      BETWEEN_INTERP_RE.lastIndex = 0;
      while ((m = BETWEEN_INTERP_RE.exec(line)) !== null) {
        const raw = m[1].trim();
        if (!raw) continue;
        if (NON_COPY_RE.test(raw)) continue;
        if (!/[A-Za-z؀-ۿ]/.test(raw)) continue;
        // Skip obvious code / destructures (`}, {...rest} {...props}`),
        // control-flow keywords sitting between JS braces (`} catch {`,
        // `} finally {`, `} else {`) and TypeScript modifiers.
        if (
          /^(const|let|var|return|if|else|while|for|do|switch|case|default|try|catch|finally|throw|yield|await|async|function|class|new|typeof|instanceof|in|of|from|as)$/.test(
            raw,
          )
        ) {
          continue;
        }
        if (/^\.{3}/.test(raw)) continue;
        findings.push({
          file: relPath,
          line: i + 1,
          kind: 'jsx-text',
          text: raw,
          context: line.trim(),
        });
      }
    }
  }

  // --- Pass 3: user-visible string literals in validation/error messages ---
  // Specifically: errors.push("..."), setError("..."), throw new Error("..."),
  // and short literal strings used as React children through a .map that end
  // up on screen. We only flag English-looking phrases (multi-word or ending
  // with punctuation), to keep noise down.
  const STRING_PUSH_RE =
    /(?:errors\.push|setError|setMessage|setBanner)\(\s*(["'`])((?:(?!\1).){3,})\1/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    STRING_PUSH_RE.lastIndex = 0;
    while ((m = STRING_PUSH_RE.exec(line)) !== null) {
      const text = m[2].trim();
      if (!text) continue;
      if (!/[A-Za-z]/.test(text)) continue;
      // Already going through t(...) somehow? Unlikely with this pattern.
      findings.push({
        file: relPath,
        line: i + 1,
        kind: 'string-literal',
        text,
        context: line.trim(),
      });
    }
  }

  return findings;
}

/**
 * For `.ts` files we only scan for strings pushed into user-visible error
 * channels (errors.push / setError / setMessage / setBanner). CSV parser
 * validation messages are the canonical case — they surface in a React
 * table cell but live in a plain `.ts` helper.
 */
function scanTsForMessageStrings(
  path: string,
  source: string,
  rootForRelative: string,
): HardcodedString[] {
  const findings: HardcodedString[] = [];
  const relPath = relative(rootForRelative, path);
  const lines = source.split(/\r?\n/);
  const STRING_PUSH_RE =
    /(?:errors\.push|setError|setMessage|setBanner)\(\s*(["'`])((?:(?!\1).){3,})\1/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    STRING_PUSH_RE.lastIndex = 0;
    while ((m = STRING_PUSH_RE.exec(line)) !== null) {
      const text = m[2].trim();
      if (!/[A-Za-z]/.test(text)) continue;
      findings.push({
        file: relPath,
        line: i + 1,
        kind: 'string-literal',
        text,
        context: line.trim(),
      });
    }
  }
  return findings;
}

// -----------------------------------------------------------------------------
// Audit orchestration
// -----------------------------------------------------------------------------

export function runAudit(opts: { webRoot: string; i18nRoot: string }): AuditResult {
  const enPath = join(opts.i18nRoot, 'en.json');
  const arPath = join(opts.i18nRoot, 'ar.json');
  const en = flatten(loadJson(enPath));
  const ar = flatten(loadJson(arPath));

  const missingInAr: string[] = [];
  const emptyInAr: string[] = [];
  const identicalValues: string[] = [];

  for (const [key, enValue] of Object.entries(en)) {
    if (!(key in ar)) {
      missingInAr.push(key);
      continue;
    }
    const arValue = ar[key];
    if (typeof arValue !== 'string' || arValue.trim().length === 0) {
      emptyInAr.push(key);
      continue;
    }
    if (arValue === enValue && !isIdenticalExempt(enValue)) {
      identicalValues.push(key);
    }
  }

  const staleInAr = Object.keys(ar).filter((k) => !(k in en));

  // Walk the src tree for hardcoded strings.
  const files = walkSrcFiles(resolve(opts.webRoot, 'src'));
  const hardcodedStrings: HardcodedString[] = [];
  for (const path of files) {
    const source = readFileSync(path, 'utf8');
    hardcodedStrings.push(...scanFileForHardcodedStrings(path, source, opts.webRoot));
  }

  return {
    locales: ['en', 'ar'],
    totalEnKeys: Object.keys(en).length,
    totalArKeys: Object.keys(ar).length,
    missingInAr: missingInAr.sort(),
    emptyInAr: emptyInAr.sort(),
    staleInAr: staleInAr.sort(),
    identicalValues: identicalValues.sort(),
    hardcodedStrings,
  };
}

// -----------------------------------------------------------------------------
// Report rendering
// -----------------------------------------------------------------------------

function renderJsonReport(result: AuditResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function renderMarkdownReport(result: AuditResult): string {
  const lines: string[] = [];
  lines.push('# i18n audit — Faatora web');
  lines.push('');
  lines.push(
    'Generated by `apps/web/scripts/i18n-audit.ts`. Rerun after any locale-bundle change.',
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- English keys: **${result.totalEnKeys}**`);
  lines.push(`- Arabic keys: **${result.totalArKeys}**`);
  lines.push(`- Missing in ar (gap): **${result.missingInAr.length}**`);
  lines.push(`- Empty in ar: **${result.emptyInAr.length}**`);
  lines.push(`- Stale in ar (orphan): **${result.staleInAr.length}**`);
  lines.push(`- Identical en == ar (untranslated): **${result.identicalValues.length}**`);
  lines.push(`- Hardcoded strings in src: **${result.hardcodedStrings.length}**`);
  lines.push('');

  const section = (title: string, items: string[]) => {
    lines.push(`## ${title}`);
    lines.push('');
    if (items.length === 0) {
      lines.push('_None — healthy._');
      lines.push('');
      return;
    }
    for (const it of items) {
      lines.push(`- \`${it}\``);
    }
    lines.push('');
  };

  section('Missing keys (in en, absent from ar)', result.missingInAr);
  section('Empty values in ar', result.emptyInAr);
  section('Stale keys (in ar, absent from en)', result.staleInAr);
  section('Suspiciously identical values (en == ar)', result.identicalValues);

  lines.push('## Hardcoded strings');
  lines.push('');
  lines.push(
    'The scanner is deliberately conservative but inherently fuzzy — review each hit before refactoring. See `apps/web/scripts/UNTRANSLATED-STRINGS.md`.',
  );
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function renderHardcodedMarkdown(result: AuditResult): string {
  const lines: string[] = [];
  lines.push('# UNTRANSLATED-STRINGS — Faatora web');
  lines.push('');
  lines.push(
    'Each entry is a string that appears to be rendered to the user but is not going through `t(...)`. The scanner is pattern-based and will produce false positives — treat this as a refactor backlog, not a lint failure.',
  );
  lines.push('');
  lines.push(`Total findings: **${result.hardcodedStrings.length}**.`);
  lines.push('');

  const byFile = new Map<string, HardcodedString[]>();
  for (const h of result.hardcodedStrings) {
    const bucket = byFile.get(h.file) ?? [];
    bucket.push(h);
    byFile.set(h.file, bucket);
  }

  const sortedFiles = [...byFile.keys()].sort();
  for (const file of sortedFiles) {
    const entries = byFile.get(file)!;
    lines.push(`## \`${file}\``);
    lines.push('');
    lines.push('| Line | Kind | Text | Context |');
    lines.push('| --- | --- | --- | --- |');
    for (const e of entries) {
      const text = e.text.replace(/\|/g, '\\|');
      const ctx = e.context.replace(/\|/g, '\\|').slice(0, 120);
      lines.push(`| ${e.line} | ${e.kind} | \`${text}\` | \`${ctx}\` |`);
    }
    lines.push('');
  }

  if (sortedFiles.length === 0) {
    lines.push('_No hardcoded strings detected._');
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

export interface MainOptions {
  outDir?: string;
  jsonOnly?: boolean;
}

function parseArgs(argv: string[]): MainOptions {
  const out: MainOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out-dir') {
      out.outDir = argv[++i];
    } else if (a === '--json-only') {
      out.jsonOnly = true;
    }
  }
  return out;
}

export function main(options: MainOptions = {}): AuditResult {
  const result = runAudit({ webRoot, i18nRoot });
  const outDir = options.outDir ? resolve(options.outDir) : scriptDir;
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, 'i18n-audit-report.json');
  writeFileSync(jsonPath, renderJsonReport(result), 'utf8');
  if (!options.jsonOnly) {
    writeFileSync(join(outDir, 'i18n-audit-report.md'), renderMarkdownReport(result), 'utf8');
    writeFileSync(
      join(outDir, 'UNTRANSLATED-STRINGS.md'),
      renderHardcodedMarkdown(result),
      'utf8',
    );
  }
  // Mirror the one-paragraph summary to stdout for a human reading the
  // command output in CI.
  const summary =
    `i18n audit: ${result.totalEnKeys} en / ${result.totalArKeys} ar keys · ` +
    `${result.missingInAr.length} missing · ${result.emptyInAr.length} empty · ` +
    `${result.identicalValues.length} identical · ${result.staleInAr.length} stale · ` +
    `${result.hardcodedStrings.length} hardcoded strings`;
  console.log(summary);
  return result;
}

// Guard so the module is also importable from tests without running main().
const invokedAsScript = (() => {
  try {
    const url = fileURLToPath(import.meta.url);
    return process.argv[1] === url;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main(parseArgs(process.argv.slice(2)));
}
