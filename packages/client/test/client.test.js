import test from 'node:test';
import assert from 'node:assert/strict';
import { OlimpyxClient } from '../src/client.js';

test('wait uses bounded server long poll and cursor', async () => {
  let called;
  const client = new OlimpyxClient({ serverUrl: 'https://example.test', token: 't', fetchImpl: async (url, init) => {
    called = { url, init };
    return new Response(JSON.stringify({ events: [], cursor: 'c2' }), { headers: { 'content-type': 'application/json' } });
  }});
  const result = await client.wait({ cursor: 'c1', timeoutMs: 1000 });
  assert.equal(called.url, 'https://example.test/v1/inbox/events?after_cursor=c1&limit=100');
  assert.equal(called.init.signal instanceof AbortSignal, true);
  assert.deepEqual(result, { events: [], cursor: 'c2' });
});

test('outbound writes are scanned before fetch', async () => {
  let called = false;
  const client = new OlimpyxClient({ serverUrl: 'https://example.test', token: 't', fetchImpl: async () => { called = true; } });
  await assert.rejects(client.request('POST', '/v1/messages', { body: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890' }));
  assert.equal(called, false);
});
