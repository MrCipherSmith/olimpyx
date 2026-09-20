#!/usr/bin/env node
/**
 * i18n coverage scan — flags JSX text / attribute literals that look like user-visible
 * copy but are NOT wrapped in `t(...)`.
 *
 * Usage:  node scripts/i18n-coverage.mjs [--quiet]
 *
 * Cheap guardrail. We intentionally allow:
 *  - status enum strings ("online", "offline", "draft", "review", …)
 *  - language codes ("ru", "en")
 *  - numbers, punctuation, route slugs
 *  - aria-hidden decorations and icons
 *  - test fixtures
 *
 * Whitelisted files: see `WHITELIST` below — city components are out of scope for the
 * initial M2 pass; lift them in a follow-up.
 *
 * Exits 1 on findings (and prints them) so CI can block the change.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SCAN_DIRS = ['apps/web/src/components', 'apps/web/src/App.tsx'];
const WHITELIST = [
  // City scene UI was excluded from the M2 catalog pass; follow-up ticket covers it.
  'apps/web/src/components/city',
];

const ALLOWED_TOKEN = /^(ru|en|online|offline|away|draft|review|published|retracted|unconfirmed|confirmed|contested|confirm|refute|comment|revoked|connecting|hi|loading|left|right|top|bottom|center|start|end|true|false)$/i;
const DECORATIVE_ARROW = /^[←→↑↓↗↘↙↖]+$/;

const FILES = [];
for (const target of SCAN_DIRS) {
  const full = join(ROOT, target);
  if (!exists(full)) continue;
  const stat = statSync(full);
  if (stat.isFile()) { FILES.push(full); continue; }
  walk(full);
}

function exists(p) { try { statSync(p); return true; } catch { return false; } }
function isWhitelisted(file) {
  const rel = relative(ROOT, file);
  return WHITELIST.some(prefix => rel === prefix || rel.startsWith(prefix + sep));
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === '__snapshots__' || entry === 'node_modules') continue;
      walk(full);
    } else if (/\.(tsx?|jsx?)$/.test(entry) && !/\.test\.(tsx?|jsx?)$/.test(entry)) {
      FILES.push(full);
    }
  }
}

const findings = [];
const JSX_TEXT_RE = />([^<>{}]+)</g;
const ATTR_RE = /\b(placeholder|title|aria-label|alt)\s*=\s*(['"`])([^'"`]+)\2/g;

for (const file of FILES) {
  if (isWhitelisted(file)) continue;
  const src = readFileSync(file, 'utf8');

  for (const m of src.matchAll(JSX_TEXT_RE)) {
    const text = m[1];
    if (!looksLikeUserCopy(text)) continue;
    const index = src.indexOf(m[0]);
    const line = src.slice(0, index).split('\n').length;
    findings.push({ file: relative(ROOT, file), line, text });
  }

  for (const m of src.matchAll(ATTR_RE)) {
    const text = m[3];
    if (!looksLikeUserCopy(text)) continue;
    const index = src.indexOf(m[0]);
    const line = src.slice(0, index).split('\n').length;
    findings.push({ file: relative(ROOT, file), line, text, attr: m[1] });
  }
}

function looksLikeUserCopy(raw) {
  const text = raw.trim();
  if (text.length < 4) return false;
  if (ALLOWED_TOKEN.test(text)) return false;
  if (DECORATIVE_ARROW.test(text)) return false;
  if (/^[\d\s.,:%/+\-()$€£¥]+$/.test(text)) return false;
  // JS expression bodies leak through the JSX regex when expressions span multiple lines.
  // Filter out fragments that look like code rather than prose: a colon followed by text in
  // single quotes / parens / equals, or more codey tokens than letters.
  const codey = (text.match(/[=(){}\[\];,]|=>|===|!==|\?\.|\?\?/g) ?? []).length;
  const lettery = (text.match(/[A-Za-zА-Яа-яЁё]/g) ?? []).length;
  if (codey >= 3) return false;
  if (codey > 0 && codey * 3 > lettery) return false;
  // Must look like prose: at least one space, OR a capitalised single word.
  if (!/\s/.test(text) && !/^[A-ZА-ЯЁ][a-zа-яё]{3,}$/.test(text)) return false;
  if (!/[A-Za-zА-Яа-яЁё]{2,}/.test(text)) return false;
  return true;
}

if (findings.length === 0) {
  if (!process.argv.includes('--quiet')) console.log('✓ i18n coverage: no hard-coded user copy in', FILES.length, 'scanned files');
  process.exit(0);
}

console.log(`✗ i18n coverage: ${findings.length} potential hard-coded literal(s):`);
for (const f of findings.slice(0, 50)) {
  const where = f.attr ? `${f.attr}="${f.text}"` : `text "${f.text.slice(0, 80)}"`;
  console.log(`  ${f.file}:${f.line}  ${where}`);
}
if (findings.length > 50) console.log(`  …and ${findings.length - 50} more`);
process.exit(1);