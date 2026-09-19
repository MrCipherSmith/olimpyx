import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertSafeOutbound, SecretDisclosureError, SECRET_RULES } from '../src/redaction.js';

test('allows ordinary outbound text', () => {
  assert.doesNotThrow(() => assertSafeOutbound({ body: 'Can anyone explain cursor pagination?' }));
});

test('refuses likely bearer tokens and private keys without echoing them', () => {
  const secret = 'Bearer abcdefghijklmnopqrstuvwxyz123456';
  assert.throws(() => assertSafeOutbound({ body: secret }), (error) => {
    assert.ok(error instanceof SecretDisclosureError);
    assert.equal(error.message.includes(secret), false);
    assert.match(error.message, /detected/i);
    return true;
  });
  assert.throws(() => assertSafeOutbound('-----BEGIN PRIVATE KEY-----\nabc'));
});

test('SECRET_RULES is exported with the exact shared rule set (name, source, flags)', () => {
  const expected = [
    ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i],
    ['authorization header', /\b(?:authorization\s*:\s*)?(?:bearer|basic)\s+[a-z0-9._~+/=-]{16,}/i],
    ['credential-like token', /\b(?:gh[pousr]_|sk-(?:proj-)?|xox[baprs]-|AKIA)[a-z0-9_-]{16,}\b/i],
    ['credential assignment', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*['"]?[^\s'"]{12,}/i],
    ['olimpyx token', /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-]))(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{43}/]
  ];
  assert.equal(SECRET_RULES.length, expected.length);
  expected.forEach(([name, pattern], index) => {
    assert.equal(SECRET_RULES[index][0], name, `rule ${index} name`);
    assert.equal(SECRET_RULES[index][1].source, pattern.source, `rule ${index} source`);
    assert.equal(SECRET_RULES[index][1].flags, pattern.flags, `rule ${index} flags`);
  });
});

test('refuses a bare 43-character olimpyx-style base64url token', () => {
  let token;
  for (let i = 0; i < 50; i += 1) {
    const candidate = randomBytes(32).toString('base64url');
    if (/[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && /\d/.test(candidate)) { token = candidate; break; }
  }
  assert.ok(token, 'failed to generate a mixed-case, digit-containing token in 50 tries');
  assert.equal(token.length, 43);
  assert.throws(() => assertSafeOutbound({ body: `Here is the token: ${token}` }), SecretDisclosureError);
});

test('does not flag id-shaped strings like mem_<32 hex chars>', () => {
  const id = `mem_${'a1b2c3d4'.repeat(4)}`;
  assert.equal(id.length, 36);
  assert.doesNotThrow(() => assertSafeOutbound({ memory_id: id }));
});
