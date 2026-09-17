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

test('listen returns immediately when events are received', async () => {
  let calledUrl;
  const client = new OlimpyxClient({
    serverUrl: 'https://example.test',
    token: 't',
    fetchImpl: async (url) => {
      calledUrl = url;
      return new Response(JSON.stringify({
        data: [{
          event_id: 'evt_01',
          cursor: 'c2',
          type: 'message.created',
          occurred_at: '2026-09-17T22:00:00Z',
          resource: { kind: 'message', id: 'msg_01' }
        }],
        page: { next_cursor: 'c2' }
      }), { headers: { 'content-type': 'application/json' } });
    }
  });
  const started = Date.now();
  const result = await client.listen({ cursor: 'c1', timeoutMs: 25_000, maxWaitMs: 60_000 });
  const duration = Date.now() - started;

  assert.equal(result.status, 'received');
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].event_id, 'evt_01');
  assert.equal(result.page.next_cursor, 'c2');
  assert.equal(result.poll_cycles, 1);
  assert.equal(typeof result.waited_sec, 'number');
  assert.ok(duration < 1000, `Expected duration < 1000ms, got ${duration}ms`);
  assert.equal(calledUrl, 'https://example.test/v1/inbox/events?after_cursor=c1&limit=100');
});

test('listen executes multiple cycles and returns idle_timeout when deadline elapses', async () => {
  let cycles = 0;
  const client = new OlimpyxClient({
    serverUrl: 'https://example.test',
    token: 't',
    fetchImpl: async () => {
      cycles++;
      return new Response(JSON.stringify({ data: [], page: { next_cursor: `c_${cycles}` } }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const result = await client.listen({
    cursor: 'c0',
    timeoutMs: 30,
    maxWaitMs: 80
  });

  assert.equal(result.status, 'idle_timeout');
  assert.deepEqual(result.data, []);
  assert.ok(result.poll_cycles >= 2, `Expected >= 2 poll cycles, got ${result.poll_cycles}`);
  assert.equal(result.page.next_cursor, `c_${result.poll_cycles}`);
  assert.equal(typeof result.waited_sec, 'number');
});

test('listen executes onHeartbeat callback before each wait iteration', async () => {
  const sequence = [];
  const client = new OlimpyxClient({
    serverUrl: 'https://example.test',
    token: 't',
    fetchImpl: async () => {
      sequence.push('wait');
      return new Response(JSON.stringify({ data: [], page: { next_cursor: 'c1' } }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await client.listen({
    cursor: 'c0',
    timeoutMs: 30,
    maxWaitMs: 80,
    onHeartbeat: async () => {
      sequence.push('heartbeat');
    }
  });

  assert.ok(sequence.length >= 4, `Expected at least 4 operations, got ${sequence.length}`);
  for (let i = 0; i < sequence.length; i++) {
    if (i % 2 === 0) {
      assert.equal(sequence[i], 'heartbeat', `Operation at index ${i} should be heartbeat`);
    } else {
      assert.equal(sequence[i], 'wait', `Operation at index ${i} should be wait`);
    }
  }
});

test('listen retries on transient network and 5xx errors with backoff', async () => {
  let attempts = 0;
  const client = new OlimpyxClient({
    serverUrl: 'https://example.test',
    token: 't',
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) throw new TypeError('fetch failed');
      if (attempts === 2) {
        return new Response(JSON.stringify({ error: { message: 'Bad Gateway' } }), {
          status: 502,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({
        data: [{ event_id: 'evt_recovered', cursor: 'c_rec' }],
        page: { next_cursor: 'c_rec' }
      }), { headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await client.listen({
    cursor: 'c0',
    timeoutMs: 50,
    maxWaitMs: 1000,
    _backoffDelays: [10, 20, 30]
  });

  assert.equal(result.status, 'received');
  assert.equal(result.data[0].event_id, 'evt_recovered');
  assert.equal(attempts, 3);
});

test('listen aborts immediately on non-transient 4xx errors without retrying', async () => {
  let attempts = 0;
  const client = new OlimpyxClient({
    serverUrl: 'https://example.test',
    token: 't',
    fetchImpl: async () => {
      attempts++;
      return new Response(JSON.stringify({ error: { message: 'Session expired' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await assert.rejects(
    client.listen({ timeoutMs: 50, maxWaitMs: 1000, _backoffDelays: [10, 20, 30] }),
    (err) => err.status === 401
  );
  assert.equal(attempts, 1);
});

test('listen throws error when transient retries are exhausted', async () => {
  let attempts = 0;
  const client = new OlimpyxClient({
    serverUrl: 'https://example.test',
    token: 't',
    fetchImpl: async () => {
      attempts++;
      throw new TypeError('fetch failed');
    }
  });

  await assert.rejects(
    client.listen({ timeoutMs: 50, maxWaitMs: 1000, _backoffDelays: [5, 5, 5] }),
    (err) => err instanceof TypeError && err.message.includes('fetch failed')
  );
  assert.equal(attempts, 4); // 1 initial + 3 retries = 4 attempts
});

test('listen cancels in-flight operations via AbortSignal', async () => {
  const controller = new AbortController();
  const client = new OlimpyxClient({
    serverUrl: 'https://example.test',
    token: 't',
    fetchImpl: async (url, init) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(JSON.stringify({ data: [] }))), 5000);
        if (init.signal) {
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Fetch aborted by signal'));
          }, { once: true });
        }
      });
    }
  });

  const listenPromise = client.listen({
    timeoutMs: 5000,
    maxWaitMs: 30000,
    signal: controller.signal
  });

  setTimeout(() => controller.abort(new Error('User abort')), 20);
  await assert.rejects(listenPromise, (err) => err.message.includes('User abort') || err.message.includes('Fetch aborted by signal'));
});

test('listen aborts backoff sleep immediately when signal is triggered', async () => {
  const controller = new AbortController();
  const client = new OlimpyxClient({
    serverUrl: 'https://example.test',
    token: 't',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    }
  });

  const started = Date.now();
  const listenPromise = client.listen({
    timeoutMs: 5000,
    maxWaitMs: 30000,
    signal: controller.signal,
    _backoffDelays: [5000, 5000, 5000]
  });

  setTimeout(() => controller.abort(new Error('Abort during sleep')), 30);
  await assert.rejects(listenPromise, (err) => err.message.includes('Abort during sleep'));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `Expected fast abort (<500ms), took ${elapsed}ms`);
});

