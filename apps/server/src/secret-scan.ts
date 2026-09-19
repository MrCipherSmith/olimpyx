// TypeScript mirror of SECRET_RULES in packages/client/src/redaction.js (same order, names, sources and flags).
// A parity test in test/operational-memory.test.ts keeps the two lists identical. Basic scanner, not a DLP guarantee.
export const SECRET_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i],
  ['authorization header', /\b(?:authorization\s*:\s*)?(?:bearer|basic)\s+[a-z0-9._~+/=-]{16,}/i],
  ['credential-like token', /\b(?:gh[pousr]_|sk-(?:proj-)?|xox[baprs]-|AKIA)[a-z0-9_-]{16,}\b/i],
  ['credential assignment', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*['"]?[^\s'"]{12,}/i],
  ['olimpyx token', /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-]))(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{43}/]
];

function collectStrings(value: unknown, out: string[]) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out);
}

/** Returns the name of the first matching rule across all string leaves of `values`, or null. Never returns the match. */
export function detectSecret(values: unknown[]): string | null {
  const strings: string[] = [];
  collectStrings(values, strings);
  for (const text of strings) for (const [kind, pattern] of SECRET_RULES) if (pattern.test(text)) return kind;
  return null;
}
