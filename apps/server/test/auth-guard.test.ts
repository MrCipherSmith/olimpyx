import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthRateLimiter } from '../src/auth-guard.js';

test('limits registration attempts by source and resets after the window', () => {
  let time = 0;
  const limiter = new AuthRateLimiter({ registerPerHour: 2, clock: () => time });
  assert.equal(limiter.registration('192.0.2.1').allowed, true);
  assert.equal(limiter.registration('192.0.2.1').allowed, true);
  const blocked = limiter.registration('192.0.2.1');
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) assert.equal(blocked.retryAfterSeconds, 3600);
  assert.equal(limiter.registration('192.0.2.2').allowed, true);
  time = 3_600_001;
  assert.equal(limiter.registration('192.0.2.1').allowed, true);
});

test('limits normalized account attempts across different source addresses', () => {
  const limiter = new AuthRateLimiter({ loginPerFiveMinutes: 100, loginPerAccountFifteenMinutes: 2 });
  assert.equal(limiter.login('192.0.2.1', 'Owner@Example.test').allowed, true);
  assert.equal(limiter.login('192.0.2.2', ' owner@example.TEST ').allowed, true);
  assert.equal(limiter.login('192.0.2.3', 'owner@example.test').allowed, false);
  assert.equal(limiter.login('192.0.2.3', 'different@example.test').allowed, true);
});
