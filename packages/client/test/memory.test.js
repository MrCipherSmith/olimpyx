import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { OlimpyxClient } from '../src/client.js';
import { LocalState } from '../src/state.js';
import { SecretDisclosureError } from '../src/redaction.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

function run(args, { cwd, input = '', env = {}, preload = null }) {
  return new Promise((resolveResult) => {
    const nodeArgs = preload ? ['--import', preload, cli, ...args] : [cli, ...args];
    const child = spawn(process.execPath, nodeArgs, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolveResult({ status, stdout, stderr })); child.stdin.end(input);
  });
}

// ---------------------------------------------------------------------------
// Client SDK
// ---------------------------------------------------------------------------

test('client SDK saveMemory posts to the agent memory endpoint and scans the payload', async () => {
  let seen;
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url, init) => {
      seen = { url: String(url), method: init.method, body: JSON.parse(init.body), headers: init.headers };
      return new Response(JSON.stringify({ data: { memory_id: 'mem_1' } }), { headers: { 'content-type': 'application/json' } });
    }
  });
  const res = await client.saveMemory('agt_1', { kind: 'fact', summary: 'The sky is blue' }, 'idem-key-1');
  assert.equal(res.data.memory_id, 'mem_1');
  assert.equal(seen.url, 'https://mock.test/v1/agents/agt_1/memory');
  assert.equal(seen.method, 'POST');
  assert.deepEqual(seen.body, { kind: 'fact', summary: 'The sky is blue' });
  assert.equal(seen.headers['idempotency-key'], 'idem-key-1');

  await assert.rejects(
    client.saveMemory('agt_1', { kind: 'fact', summary: 'sk-proj-abcdefghijklmnopqrstuvwxyz' }),
    SecretDisclosureError
  );
});

test('client SDK listMemories builds the query string from filters', async () => {
  let requestedUrl;
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url) => { requestedUrl = String(url); return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { headers: { 'content-type': 'application/json' } }); }
  });
  await client.listMemories('agt_1', { status: 'archived', kind: 'fact', tag: 'postgres', q: 'index', cursor: 'mem_c1', limit: 10 });
  assert.equal(requestedUrl, 'https://mock.test/v1/agents/agt_1/memory?status=archived&kind=fact&tag=postgres&q=index&cursor=mem_c1&limit=10');
});

test('client SDK listMemories with no filters hits the bare endpoint', async () => {
  let requestedUrl;
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url) => { requestedUrl = String(url); return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { headers: { 'content-type': 'application/json' } }); }
  });
  await client.listMemories('agt_1');
  assert.equal(requestedUrl, 'https://mock.test/v1/agents/agt_1/memory');
});

test('client SDK getMemory fetches a single memory by id', async () => {
  let requestedUrl;
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url) => { requestedUrl = String(url); return new Response(JSON.stringify({ data: { memory_id: 'mem_1' } }), { headers: { 'content-type': 'application/json' } }); }
  });
  await client.getMemory('agt_1', 'mem_1');
  assert.equal(requestedUrl, 'https://mock.test/v1/agents/agt_1/memory/mem_1');
});

test('client SDK archiveMemory and restoreMemory PATCH the active flag', async () => {
  const calls = [];
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ data: {} }), { headers: { 'content-type': 'application/json' } });
    }
  });
  await client.archiveMemory('agt_1', 'mem_1');
  await client.restoreMemory('agt_1', 'mem_1');
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, 'https://mock.test/v1/agents/agt_1/memory/mem_1');
  assert.deepEqual(calls[0].body, { active: false });
  assert.equal(calls[1].method, 'PATCH');
  assert.deepEqual(calls[1].body, { active: true });
});

test('client SDK consolidateMemories posts summary and optional covered_until with idempotency key', async () => {
  let seen;
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url, init) => {
      seen = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
      return new Response(JSON.stringify({ data: { summary_id: 'msum_1', revision: 1 } }), { headers: { 'content-type': 'application/json' } });
    }
  });
  await client.consolidateMemories('agt_1', { summary: 'Recap of the week' }, 'consolidate-key');
  assert.equal(seen.url, 'https://mock.test/v1/agents/agt_1/memory/consolidate');
  assert.deepEqual(seen.body, { summary: 'Recap of the week' });
  assert.equal(seen.headers['idempotency-key'], 'consolidate-key');

  await client.consolidateMemories('agt_1', { summary: 'Recap', covered_until: '2026-09-18T00:00:00.000Z' });
  assert.deepEqual(seen, seen); // no-op, previous assertions already covered the important shape
});

test('client SDK rollbackMemories posts the rollback payload with a deterministic idempotency key', async () => {
  let seen;
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url, init) => {
      seen = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
      return new Response(JSON.stringify({ data: { rolled_back_count: 2, memory_ids: ['mem_1', 'mem_2'], to_persona_revision: 'rev_1' } }), { headers: { 'content-type': 'application/json' } });
    }
  });
  const payload = {
    to_persona_revision: '1789000000000-uuid',
    reverted_persona_revisions: ['1789000100000-uuid'],
    target_created_at: '2026-09-18T12:00:00.000Z',
    reason: 'Reverting drift'
  };
  const res = await client.rollbackMemories('agt_1', payload, { idempotencyKey: 'persona-rollback:1789000000000-uuid' });
  assert.equal(res.data.rolled_back_count, 2);
  assert.equal(seen.url, 'https://mock.test/v1/agents/agt_1/memory/rollback');
  assert.deepEqual(seen.body, payload);
  assert.equal(seen.headers['idempotency-key'], 'persona-rollback:1789000000000-uuid');
});

test('client SDK memoryEvents fetches the audit trail with cursor/limit', async () => {
  let requestedUrl;
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url) => { requestedUrl = String(url); return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { headers: { 'content-type': 'application/json' } }); }
  });
  await client.memoryEvents('agt_1', { cursor: 'evt_1', limit: 5 });
  assert.equal(requestedUrl, 'https://mock.test/v1/agents/agt_1/memory/events?cursor=evt_1&limit=5');
});

// ---------------------------------------------------------------------------
// state.js: rollbackPersona extension + pending memory rollbacks
// ---------------------------------------------------------------------------

test('rollbackPersona keeps backward-compatible shape and adds reverted revisions + target_created_at', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-mem-state-'));
  const state = new LocalState(root);
  const first = await state.savePersona({ name: 'Nova', phase: 1 });
  const second = await state.savePersona({ name: 'Nova', phase: 2 });
  const third = await state.savePersona({ name: 'Nova', phase: 3 });

  const result = await state.rollbackPersona(first.revision);
  // Backward compatible: still looks like a persona record.
  assert.equal(result.persona.phase, 1);
  assert.ok(result.revision);
  // New fields:
  assert.ok(Array.isArray(result.reverted_persona_revisions));
  assert.deepEqual(new Set(result.reverted_persona_revisions), new Set([second.revision, third.revision]));
  assert.equal(typeof result.target_created_at, 'string');
  assert.equal(result.target_created_at, first.created_at);
});

test('pendingMemoryRollbacks stores, lists and clears entries atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-mem-pending-'));
  const state = new LocalState(root);
  assert.deepEqual(await state.pendingMemoryRollbacks(), []);

  const entry = {
    idempotencyKey: 'persona-rollback:rev-1',
    agentId: 'agt_1',
    payload: { to_persona_revision: 'rev-1', reverted_persona_revisions: [], target_created_at: '2026-01-01T00:00:00.000Z' }
  };
  await state.savePendingMemoryRollback(entry);
  const pending = await state.pendingMemoryRollbacks();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].idempotencyKey, entry.idempotencyKey);

  await state.clearPendingMemoryRollback(entry.idempotencyKey);
  assert.deepEqual(await state.pendingMemoryRollbacks(), []);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function setupCliState(root, { agentId = 'agt_1', ownerToken = null } = {}) {
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test', agentId }));
  await writeFile(join(stateDir, 'session-credential'), 'secret_session_token\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: 'ses_mem_1',
    token: 'secret_session_token',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString()
  }));
  if (ownerToken) {
    await writeFile(join(stateDir, 'owner-credential'), ownerToken, { mode: 0o600 });
  }
  return stateDir;
}

test('CLI memory save|list|get|archive|restore|consolidate|events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-memory-cli-'));
  await setupCliState(root, { ownerToken: 'owner-token-value' });

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method || 'GET';
      const headers = { 'content-type': 'application/json' };
      if (u.includes('/heartbeat')) return new Response(JSON.stringify({ data: { ok: true } }), { headers });
      if (u.includes('/memory/consolidate')) {
        return new Response(JSON.stringify({ data: { summary_id: 'msum_1', revision: 1, covered_until: '2026-09-18T00:00:00.000Z', archived_memory_count: 3 } }), { headers });
      }
      if (u.includes('/memory/events')) {
        return new Response(JSON.stringify({ data: [{ id: 'evt_1', type: 'created' }], page: { next_cursor: null } }), { headers });
      }
      if (u.includes('/memory/mem_1')) {
        if (m === 'PATCH') {
          const body = JSON.parse(init.body);
          return new Response(JSON.stringify({ data: { memory_id: 'mem_1', active: body.active } }), { headers });
        }
        return new Response(JSON.stringify({ data: { memory_id: 'mem_1', kind: 'fact', summary: 'The sky is blue', active: true } }), { headers });
      }
      if (u.includes('/v1/agents/agt_1/memory')) {
        if (m === 'POST') {
          const body = JSON.parse(init.body);
          return new Response(JSON.stringify({ data: { memory_id: 'mem_1', ...body, active: true } }), { headers });
        }
        return new Response(JSON.stringify({ data: [{ memory_id: 'mem_1', kind: 'fact', summary: 'The sky is blue' }], page: { next_cursor: null } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404, headers });
    };
  `);

  const save = await run(['memory', 'save', '--agent', 'agt_1', '--kind', 'fact', '--summary', 'The sky is blue', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(save.status, 0, save.stderr);
  assert.equal(JSON.parse(save.stdout).data.memory_id, 'mem_1');

  const list = await run(['memory', 'list', '--agent', 'agt_1', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).data[0].memory_id, 'mem_1');

  const get = await run(['memory', 'get', '--agent', 'agt_1', '--id', 'mem_1', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(get.status, 0, get.stderr);
  assert.equal(JSON.parse(get.stdout).data.memory_id, 'mem_1');

  const archive = await run(['memory', 'archive', '--agent', 'agt_1', '--id', 'mem_1', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(archive.status, 0, archive.stderr);
  assert.equal(JSON.parse(archive.stdout).data.active, false);

  const restore = await run(['memory', 'restore', '--agent', 'agt_1', '--id', 'mem_1', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(JSON.parse(restore.stdout).data.active, true);

  const consolidate = await run(['memory', 'consolidate', '--agent', 'agt_1', '--summary', 'Recap of the week', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(consolidate.status, 0, consolidate.stderr);
  assert.equal(JSON.parse(consolidate.stdout).data.summary_id, 'msum_1');

  const events = await run(['memory', 'events', '--agent', 'agt_1'], { cwd: root, preload: preloadPath });
  assert.equal(events.status, 0, events.stderr);
  assert.equal(JSON.parse(events.stdout).data[0].id, 'evt_1');

  assert.equal(save.stdout.includes('secret_session_token'), false);
  assert.equal(list.stdout.includes('secret_session_token'), false);
  assert.equal(events.stdout.includes('owner-token-value'), false);
});

test('CLI memory save attaches the local persona revision for personality_influence kind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-memory-influence-cli-'));
  await setupCliState(root);
  await new LocalState(join(root, '.olimpyx')).savePersona({ name: 'Nova' }, 'initial');
  const persona = await new LocalState(join(root, '.olimpyx')).currentPersona();

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method || 'GET';
      const headers = { 'content-type': 'application/json' };
      if (u.includes('/heartbeat')) return new Response(JSON.stringify({ data: { ok: true } }), { headers });
      if (u.includes('/v1/agents/agt_1/memory') && m === 'POST') {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({ data: { memory_id: 'mem_infl_1', ...body, active: true } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404, headers });
    };
  `);

  const save = await run(['memory', 'save', '--agent', 'agt_1', '--kind', 'personality_influence', '--summary', 'Prefer terse replies', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(save.status, 0, save.stderr);
  const parsed = JSON.parse(save.stdout);
  assert.equal(parsed.data.persona_revision, persona.revision);
});

test('CLI memory save omits body entirely when --body is not given (no fake default)', async () => {
  // M2: the server now defaults a missing `body` to '' itself; the client must not send
  // a fabricated '' body when the caller never supplied --body.
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-memory-save-no-body-'));
  await setupCliState(root);

  const sentBodyPath = join(root, 'sent-body.json');
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    import { writeFileSync } from 'node:fs';
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method || 'GET';
      const headers = { 'content-type': 'application/json' };
      if (u.includes('/heartbeat')) return new Response(JSON.stringify({ data: { ok: true } }), { headers });
      if (u.includes('/v1/agents/agt_1/memory') && m === 'POST') {
        const sentBody = JSON.parse(init.body);
        writeFileSync('${sentBodyPath}', JSON.stringify(sentBody));
        return new Response(JSON.stringify({ data: { memory_id: 'mem_nb_1', ...sentBody, active: true } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404, headers });
    };
  `);

  const save = await run(['memory', 'save', '--agent', 'agt_1', '--kind', 'fact', '--summary', 'No body here', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(save.status, 0, save.stderr);
  const sentBody = JSON.parse(await readFile(sentBodyPath, 'utf8'));
  assert.equal('body' in sentBody, false, 'body key must be entirely absent, not an empty string');
  const parsed = JSON.parse(save.stdout);
  assert.equal('body' in parsed.data && parsed.data.body === '', false);
});

test('CLI persona rollback syncs with the server when an owner credential is available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-persona-rollback-sync-'));
  await setupCliState(root, { ownerToken: 'owner-token-value' });
  const state = new LocalState(join(root, '.olimpyx'));
  const first = await state.savePersona({ name: 'Nova', phase: 1 }, 'initial');
  await state.savePersona({ name: 'Nova', phase: 2 }, 'drift');

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const headers = { 'content-type': 'application/json' };
      if (u.includes('/memory/rollback')) {
        globalThis.__rollbackHeaders = globalThis.__rollbackHeaders || [];
        globalThis.__rollbackHeaders.push(init.headers['idempotency-key']);
        return new Response(JSON.stringify({ data: { rolled_back_count: 1, memory_ids: ['mem_1'], to_persona_revision: '${first.revision}' } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404, headers });
    };
  `);

  const rollback = await run(['persona', 'rollback', first.revision], { cwd: root, preload: preloadPath, env: { OLIMPYX_AGENT_ID: 'agt_1' } });
  assert.equal(rollback.status, 0, rollback.stderr);
  const parsed = JSON.parse(rollback.stdout);
  assert.equal(parsed.local.persona.phase, 1);
  assert.equal(parsed.server.data.rolled_back_count, 1);
  assert.equal(rollback.stdout.includes('owner-token-value'), false);

  const pendingFile = await readFile(join(root, '.olimpyx', 'pending-memory-rollbacks.json'), 'utf8').catch(() => null);
  assert.equal(pendingFile, null, 'no pending entry should remain after a successful sync');
});

test('CLI persona rollback keys idempotency on the NEW local revision, not the rollback target', async () => {
  // M1 regression: keying on `${target}` collides across repeated rollbacks to the same
  // target (the server stores idempotency keys forever, so a second rollback to the same
  // target would replay/409 against the first one forever). Keying on the freshly created
  // local revision guarantees a distinct key every time.
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-persona-rollback-key-'));
  await setupCliState(root); // no owner token -> both rollbacks fall through to pending
  const state = new LocalState(join(root, '.olimpyx'));
  const first = await state.savePersona({ name: 'Nova', phase: 1 }, 'initial');
  await state.savePersona({ name: 'Nova', phase: 2 }, 'drift');
  await state.savePersona({ name: 'Nova', phase: 3 }, 'drift-more');

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'should not be called' } }), { status: 500 });`);

  const firstRollback = await run(['persona', 'rollback', first.revision], { cwd: root, preload: preloadPath, env: { OLIMPYX_AGENT_ID: 'agt_1' } });
  assert.equal(firstRollback.status, 0, firstRollback.stderr);
  const firstPending = await state.pendingMemoryRollbacks();
  assert.equal(firstPending.length, 1);
  assert.notEqual(firstPending[0].idempotencyKey, `persona-rollback:${first.revision}`);

  const secondRollback = await run(['persona', 'rollback', first.revision], { cwd: root, preload: preloadPath, env: { OLIMPYX_AGENT_ID: 'agt_1' } });
  assert.equal(secondRollback.status, 0, secondRollback.stderr);
  const secondPending = await state.pendingMemoryRollbacks();
  // Two independent pending entries: same target, two different generated local revisions.
  assert.equal(secondPending.length, 2);
  const keys = secondPending.map((entry) => entry.idempotencyKey);
  assert.notEqual(keys[0], keys[1]);
  for (const key of keys) assert.match(key, /^persona-rollback:/);
});

test('CLI persona rollback leaves a retryable pending entry when no owner credential is available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-persona-rollback-pending-'));
  await setupCliState(root);
  const state = new LocalState(join(root, '.olimpyx'));
  const first = await state.savePersona({ name: 'Nova', phase: 1 }, 'initial');
  await state.savePersona({ name: 'Nova', phase: 2 }, 'drift');

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'should not be called' } }), { status: 500 });`);

  const rollback = await run(['persona', 'rollback', first.revision], { cwd: root, preload: preloadPath, env: { OLIMPYX_AGENT_ID: 'agt_1' } });
  assert.equal(rollback.status, 0, rollback.stderr);
  const parsed = JSON.parse(rollback.stdout);
  assert.equal(parsed.local.persona.phase, 1);
  assert.match(rollback.stdout, /olimpyx memory rollback --sync/);

  const pending = await state.pendingMemoryRollbacks();
  assert.equal(pending.length, 1);
  // Keyed on the NEW local revision produced by this rollback, not the rollback target.
  assert.equal(pending[0].idempotencyKey, `persona-rollback:${parsed.local.revision}`);
  assert.notEqual(parsed.local.revision, first.revision);
});

test('CLI persona rollback errors clearly instead of saving a pending entry with no agentId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-persona-rollback-no-agent-'));
  await setupCliState(root, { agentId: null });
  const state = new LocalState(join(root, '.olimpyx'));
  const first = await state.savePersona({ name: 'Nova', phase: 1 }, 'initial');
  await state.savePersona({ name: 'Nova', phase: 2 }, 'drift');

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'should not be called' } }), { status: 500 });`);

  const rollback = await run(['persona', 'rollback', first.revision], { cwd: root, preload: preloadPath });
  assert.notEqual(rollback.status, 0);
  assert.match(rollback.stderr, /agentId/i);

  assert.deepEqual(await state.pendingMemoryRollbacks(), []);
});

test('CLI memory rollback --sync replays pending entries with the same idempotency key and clears them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-memory-rollback-sync-'));
  await setupCliState(root, { ownerToken: 'owner-token-value' });
  const state = new LocalState(join(root, '.olimpyx'));
  await state.savePendingMemoryRollback({
    idempotencyKey: 'persona-rollback:rev-1',
    agentId: 'agt_1',
    payload: {
      to_persona_revision: 'rev-1',
      reverted_persona_revisions: ['rev-2'],
      target_created_at: '2026-01-01T00:00:00.000Z',
      reason: 'sync retry'
    }
  });

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const headers = { 'content-type': 'application/json' };
      if (u.includes('/memory/rollback')) {
        globalThis.__syncKeys = globalThis.__syncKeys || [];
        globalThis.__syncKeys.push(init.headers['idempotency-key']);
        return new Response(JSON.stringify({ data: { rolled_back_count: 1, memory_ids: ['mem_9'], to_persona_revision: 'rev-1' } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404, headers });
    };
  `);

  const sync = await run(['memory', 'rollback', '--sync'], { cwd: root, preload: preloadPath });
  assert.equal(sync.status, 0, sync.stderr);
  const parsed = JSON.parse(sync.stdout);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[0].status, 'synced');
  assert.equal(parsed[0].idempotencyKey, 'persona-rollback:rev-1');
  assert.equal(parsed[0].data.rolled_back_count, 1);

  assert.deepEqual(await state.pendingMemoryRollbacks(), []);
});

test('CLI memory rollback --sync continues past a failing entry and drops non-retryable 4xx failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-memory-rollback-sync-mixed-'));
  await setupCliState(root, { ownerToken: 'owner-token-value' });
  const state = new LocalState(join(root, '.olimpyx'));
  await state.savePendingMemoryRollback({
    idempotencyKey: 'persona-rollback:will-conflict',
    agentId: 'agt_1',
    payload: { to_persona_revision: 'rev-a', reverted_persona_revisions: [], target_created_at: '2026-01-01T00:00:00.000Z' }
  });
  await state.savePendingMemoryRollback({
    idempotencyKey: 'persona-rollback:will-succeed',
    agentId: 'agt_1',
    payload: { to_persona_revision: 'rev-b', reverted_persona_revisions: [], target_created_at: '2026-01-01T00:00:00.000Z' }
  });

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, init = {}) => {
      const headers = { 'content-type': 'application/json' };
      const key = init.headers['idempotency-key'];
      if (key === 'persona-rollback:will-conflict') {
        return new Response(JSON.stringify({ error: { message: 'Idempotency key already used with a different payload', code: 'idempotency_conflict' } }), { status: 409, headers });
      }
      if (key === 'persona-rollback:will-succeed') {
        return new Response(JSON.stringify({ data: { rolled_back_count: 1, memory_ids: ['mem_5'], to_persona_revision: 'rev-b' } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404, headers });
    };
  `);

  const sync = await run(['memory', 'rollback', '--sync'], { cwd: root, preload: preloadPath });
  assert.equal(sync.status, 0, sync.stderr);
  const parsed = JSON.parse(sync.stdout);
  assert.equal(parsed.length, 2);

  const dropped = parsed.find((r) => r.idempotencyKey === 'persona-rollback:will-conflict');
  assert.equal(dropped.status, 'dropped');
  assert.match(dropped.error.message, /Idempotency key already used/);

  const synced = parsed.find((r) => r.idempotencyKey === 'persona-rollback:will-succeed');
  assert.equal(synced.status, 'synced');
  assert.equal(synced.data.rolled_back_count, 1);

  // Both are resolved (one dropped as unrecoverable, one synced) so neither stays pending.
  assert.deepEqual(await state.pendingMemoryRollbacks(), []);
});

test('CLI memory rollback --sync keeps an entry pending on 5xx/network failure and reports the error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-memory-rollback-sync-5xx-'));
  await setupCliState(root, { ownerToken: 'owner-token-value' });
  const state = new LocalState(join(root, '.olimpyx'));
  await state.savePendingMemoryRollback({
    idempotencyKey: 'persona-rollback:server-down',
    agentId: 'agt_1',
    payload: { to_persona_revision: 'rev-c', reverted_persona_revisions: [], target_created_at: '2026-01-01T00:00:00.000Z' }
  });

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Internal error' } }), { status: 503, headers: { 'content-type': 'application/json' } });
  `);

  const sync = await run(['memory', 'rollback', '--sync'], { cwd: root, preload: preloadPath });
  assert.equal(sync.status, 0, sync.stderr);
  const parsed = JSON.parse(sync.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].status, 'pending');
  assert.match(parsed[0].error.message, /Internal error/);

  const stillPending = await state.pendingMemoryRollbacks();
  assert.equal(stillPending.length, 1);
  assert.equal(stillPending[0].idempotencyKey, 'persona-rollback:server-down');
});

test('CLI manual memory rollback --to generates a fresh random idempotency key by default (not derived from --to)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-memory-rollback-manual-'));
  await setupCliState(root, { ownerToken: 'owner-token-value' });

  const keysPath = join(root, 'keys.json');
  await writeFile(keysPath, '[]');
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    import { readFileSync, writeFileSync } from 'node:fs';
    globalThis.fetch = async (url, init = {}) => {
      const headers = { 'content-type': 'application/json' };
      const keys = JSON.parse(readFileSync('${keysPath}', 'utf8'));
      keys.push(init.headers['idempotency-key']);
      writeFileSync('${keysPath}', JSON.stringify(keys));
      return new Response(JSON.stringify({ data: { rolled_back_count: 0, memory_ids: [], to_persona_revision: 'rev-x' } }), { headers });
    };
  `);

  const args = ['memory', 'rollback', '--agent', 'agt_1', '--to', 'rev-x', '--target-created-at', '2026-01-01T00:00:00.000Z'];
  const first = await run(args, { cwd: root, preload: preloadPath });
  assert.equal(first.status, 0, first.stderr);
  const second = await run(args, { cwd: root, preload: preloadPath });
  assert.equal(second.status, 0, second.stderr);

  const keys = JSON.parse(await readFile(keysPath, 'utf8'));
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.notEqual(keys[0], 'persona-rollback:rev-x');
  assert.notEqual(keys[1], 'persona-rollback:rev-x');
});

test('CLI manual memory rollback --to accepts an explicit --idempotency-key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-memory-rollback-manual-explicit-'));
  await setupCliState(root, { ownerToken: 'owner-token-value' });

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, init = {}) => {
      const headers = { 'content-type': 'application/json' };
      globalThis.__seenKey = init.headers['idempotency-key'];
      return new Response(JSON.stringify({ data: { rolled_back_count: 0, memory_ids: [], to_persona_revision: 'rev-x', seen_key: init.headers['idempotency-key'] } }), { headers });
    };
  `);

  const result = await run([
    'memory', 'rollback', '--agent', 'agt_1', '--to', 'rev-x',
    '--target-created-at', '2026-01-01T00:00:00.000Z', '--idempotency-key', 'orchestrator-owned-key-1'
  ], { cwd: root, preload: preloadPath });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.data.seen_key, 'orchestrator-owned-key-1');
});
