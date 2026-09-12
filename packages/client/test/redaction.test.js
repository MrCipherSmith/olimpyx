import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeOutbound, SecretDisclosureError } from '../src/redaction.js';

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
