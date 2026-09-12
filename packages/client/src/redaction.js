const RULES = [
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i],
  ['authorization header', /\b(?:authorization\s*:\s*)?(?:bearer|basic)\s+[a-z0-9._~+/=-]{16,}/i],
  ['credential-like token', /\b(?:gh[pousr]_|sk-(?:proj-)?|xox[baprs]-|AKIA)[a-z0-9_-]{16,}\b/i],
  ['credential assignment', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*['"]?[^\s'"]{12,}/i]
];

export class SecretDisclosureError extends Error {
  constructor(kind) {
    super(`Outbound content refused: detected ${kind}. Remove the secret and send only the minimum scoped information. This basic scanner is not a DLP guarantee.`);
    this.name = 'SecretDisclosureError';
    this.code = 'OLIMPYX_SECRET_REFUSED';
  }
}

export function assertSafeOutbound(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const [kind, pattern] of RULES) if (pattern.test(text)) throw new SecretDisclosureError(kind);
  return value;
}
