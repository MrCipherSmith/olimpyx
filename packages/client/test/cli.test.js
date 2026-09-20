import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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

test('login and enrollment serialize credentials only to private files', async (t) => {
  const ownerToken = 'owner-token-that-must-not-be-printed';
  const agentToken = 'agent-token-that-must-not-be-printed';
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-'));
  const stateRoot = join(root, '.olimpyx');
  const url = 'https://mock.test';

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      const headers = { 'content-type': 'application/json' };
      if (u.includes('/v1/owners/login')) {
        return new Response(JSON.stringify({ data: { owner: { owner_id: 'own_1', email: 'owner@example.test', display_name: 'Owner' }, access_token: '${ownerToken}', expires_at: '2099-01-01T00:00:00Z' } }), { headers });
      }
      if (u.includes('/v1/owners/me/enrollment-tokens')) {
        return new Response(JSON.stringify({ data: { enrollment_token: 'one-use-enrollment-secret', expires_at: '2099-01-01T00:00:00Z' } }), { headers });
      }
      if (u.includes('/v1/agents/enroll')) {
        return new Response(JSON.stringify({ data: { agent: { agent_id: 'agt_1', profile_revision: 1 }, agent_token: '${agentToken}', created_at: '2026-09-12T00:00:00Z' } }), { headers });
      }
      if (u.includes('/v1/sessions') && !u.includes('heartbeat') && !u.includes('end')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1', session_token: 'temporary-session-token', expires_at: '2099-01-01T00:00:00Z', inbox_cursor: 'c1', bootstrap: {} } }), { headers });
      }
      if (u.includes('/v1/sessions/ses_1/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers });
      }
      if (u.endsWith('/v1/city-guide')) {
        if (opts.method !== 'GET' || opts.body !== undefined) throw new Error('Guide must be fetched without a request body');
        return new Response(JSON.stringify({ data: { body: '# City guide\\n' + 'Complete guide text. '.repeat(100) } }), { headers });
      }
      if (u.includes('/v1/rooms')) {
        if (opts.headers?.authorization !== 'Bearer temporary-session-token') {
          return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), { status: 401, headers });
        }
        return new Response(JSON.stringify({ data: [{ agent_token: 'remote-content-shaped-like-token' }], page: { next_cursor: null } }), { headers });
      }
      if (u.includes('/v1/sessions/ses_1/end')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'missing' } }), { status: 404, headers });
    };
  `);

  assert.equal((await run(['configure', '--server', url], { cwd: root, preload: preloadPath })).status, 0);
  const login = await run(['owner-login', '--email', 'owner@example.test', '--password-stdin'], { cwd: root, input: 'a-safe-password\n', preload: preloadPath });
  assert.equal(login.status, 0, login.stderr);
  assert.equal(`${login.stdout}${login.stderr}`.includes(ownerToken), false);
  const profile = JSON.stringify({ name: 'Nova', role: 'tester', bio: '', interests: [], capabilities: [] });
  const enroll = await run(['enroll', '--profile', profile], { cwd: root, preload: preloadPath });
  assert.equal(enroll.status, 0, enroll.stderr);
  assert.equal(`${enroll.stdout}${enroll.stderr}`.includes(agentToken), false);
  assert.equal(await readFile(join(stateRoot, 'owner-credential'), 'utf8'), ownerToken);
  assert.equal(await readFile(join(stateRoot, 'credential'), 'utf8'), agentToken);
  const begun = await run(['session', 'begin', '--caller-id', 'active-test', '--host', 'codex'], { cwd: root, preload: preloadPath });
  assert.equal(begun.status, 0, begun.stderr);
  assert.equal(`${begun.stdout}${begun.stderr}`.includes('temporary-session-token'), false);
  const guide = await run(['request', 'GET', '/v1/city-guide', '', '--caller-id', 'active-test'], { cwd: root, preload: preloadPath });
  assert.equal(guide.status, 0, guide.stderr);
  assert.equal(JSON.parse(guide.stdout).data.body, '# City guide\n' + 'Complete guide text. '.repeat(100));
  const rooms = await run(['rooms', '--caller-id', 'active-test'], { cwd: root, preload: preloadPath });
  assert.equal(rooms.status, 0, rooms.stderr);
  assert.equal(rooms.stdout.includes('remote-content-shaped-like-token'), false);
  const unsafeGeneric = await run(['request', 'POST', '/v1/agents/enroll', '{}', '--caller-id', 'active-test'], { cwd: root, preload: preloadPath });
  assert.equal(unsafeGeneric.status, 1);
  assert.match(unsafeGeneric.stderr, /Credential-issuing endpoints are blocked/);
  const invalidEnd = await run(['session', 'end', '--caller-id', 'active-test', '--reason', 'completed'], { cwd: root, preload: preloadPath });
  assert.equal(invalidEnd.status, 1);
  assert.match(invalidEnd.stderr, /Session end reason must be/);
  const sessionFile = join(stateRoot, 'calls', 'active-test', 'session.json');
  assert.equal((await readFile(sessionFile, 'utf8')).includes('ses_1'), true);
  const ended = await run(['session', 'end', '--caller-id', 'active-test'], { cwd: root, preload: preloadPath });
  assert.equal(ended.status, 0, ended.stderr);

  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Q-016 review finding: a cached config.ownerId must never be trusted blindly --
// `enroll` must always re-resolve it from the owner token, and `owner-login` must
// never silently swap it out from under an already-enrolled agent.
// ---------------------------------------------------------------------------

test('enroll always resolves ownerId from GET /v1/owners/me, even when config.ownerId is already cached, and stores the fresh value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-ownerid-'));
  const stateRoot = join(root, '.olimpyx');
  await mkdir(stateRoot, { recursive: true });
  // Pre-seed a stale cached ownerId, as if this installation enrolled long ago under a
  // different (or since-changed) owner mapping.
  await writeFile(join(stateRoot, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test', ownerId: 'own_stale' }));
  await writeFile(join(stateRoot, 'owner-credential'), 'owner-token-for-enroll', { mode: 0o600 });

  const callCountPath = join(root, 'owners-me-calls.json');
  await writeFile(callCountPath, '0');
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    import { readFileSync, writeFileSync } from 'node:fs';
    globalThis.fetch = async (url) => {
      const u = String(url);
      const headers = { 'content-type': 'application/json' };
      if (u.includes('/v1/owners/me/enrollment-tokens')) {
        return new Response(JSON.stringify({ data: { enrollment_token: 'one-use-enrollment-secret', expires_at: '2099-01-01T00:00:00Z' } }), { headers });
      }
      if (u.includes('/v1/owners/me')) {
        const n = Number(readFileSync('${callCountPath}', 'utf8')) + 1;
        writeFileSync('${callCountPath}', String(n));
        return new Response(JSON.stringify({ data: { owner_id: 'own_fresh', email: 'owner@example.test', display_name: 'Owner' } }), { headers });
      }
      if (u.includes('/v1/agents/enroll')) {
        return new Response(JSON.stringify({ data: { agent: { agent_id: 'agt_fresh', profile_revision: 1 }, agent_token: 'agent-token-fresh', created_at: '2026-09-19T00:00:00Z' } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'missing ' + u } }), { status: 404, headers });
    };
  `);

  const profile = JSON.stringify({ name: 'Nova', role: 'tester', bio: '', interests: [], capabilities: [] });
  const enroll = await run(['enroll', '--profile', profile], { cwd: root, preload: preloadPath, env: { OLIMPYX_OWNER_TOKEN: 'owner-token-for-enroll' } });
  assert.equal(enroll.status, 0, enroll.stderr);

  const calls = Number(await readFile(callCountPath, 'utf8'));
  assert.equal(calls, 1, 'enroll must call GET /v1/owners/me even though config.ownerId was already cached');

  const config = JSON.parse(await readFile(join(stateRoot, 'config.json'), 'utf8'));
  assert.equal(config.ownerId, 'own_fresh', 'the stale cached ownerId must be overwritten with the freshly resolved value');
  await rm(root, { recursive: true, force: true });
});

test('owner-login keeps the existing ownerId when an agentId is already enrolled and the logged-in owner differs (never mixes owners)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-ownerid-'));
  const stateRoot = join(root, '.olimpyx');
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test', agentId: 'agt_1', ownerId: 'own_A' }));

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      const headers = { 'content-type': 'application/json' };
      if (u.includes('/v1/owners/login')) {
        return new Response(JSON.stringify({ data: { owner: { owner_id: 'own_B', email: 'other-owner@example.test', display_name: 'Other Owner' }, access_token: 'owner-b-token', expires_at: '2099-01-01T00:00:00Z' } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'missing ' + u } }), { status: 404, headers });
    };
  `);

  const login = await run(['owner-login', '--email', 'other-owner@example.test', '--password-stdin'], { cwd: root, input: 'a-safe-password\n', preload: preloadPath });
  assert.equal(login.status, 0, login.stderr);

  const config = JSON.parse(await readFile(join(stateRoot, 'config.json'), 'utf8'));
  assert.equal(config.ownerId, 'own_A', 'ownerId must not be overwritten by a different owner\'s login while agentId is enrolled under own_A');
  assert.equal(config.agentId, 'agt_1');
  await rm(root, { recursive: true, force: true });
});

test('owner-login sets ownerId when there is no agentId yet (fresh install, safe to adopt)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-ownerid-'));
  const stateRoot = join(root, '.olimpyx');
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      const headers = { 'content-type': 'application/json' };
      if (u.includes('/v1/owners/login')) {
        return new Response(JSON.stringify({ data: { owner: { owner_id: 'own_C', email: 'c@example.test', display_name: 'Owner C' }, access_token: 'owner-c-token', expires_at: '2099-01-01T00:00:00Z' } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'missing ' + u } }), { status: 404, headers });
    };
  `);

  const login = await run(['owner-login', '--email', 'c@example.test', '--password-stdin'], { cwd: root, input: 'a-safe-password\n', preload: preloadPath });
  assert.equal(login.status, 0, login.stderr);

  const config = JSON.parse(await readFile(join(stateRoot, 'config.json'), 'utf8'));
  assert.equal(config.ownerId, 'own_C', 'a fresh install (no agentId yet) may freely adopt the logged-in owner id');
  await rm(root, { recursive: true, force: true });
});

test('owner-login re-sets ownerId when the logged-in owner matches the already-cached ownerId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-ownerid-'));
  const stateRoot = join(root, '.olimpyx');
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test', agentId: 'agt_1', ownerId: 'own_A' }));

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      const headers = { 'content-type': 'application/json' };
      if (u.includes('/v1/owners/login')) {
        return new Response(JSON.stringify({ data: { owner: { owner_id: 'own_A', email: 'a@example.test', display_name: 'Owner A' }, access_token: 'owner-a-token', expires_at: '2099-01-01T00:00:00Z' } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'missing ' + u } }), { status: 404, headers });
    };
  `);

  const login = await run(['owner-login', '--email', 'a@example.test', '--password-stdin'], { cwd: root, input: 'a-safe-password\n', preload: preloadPath });
  assert.equal(login.status, 0, login.stderr);

  const config = JSON.parse(await readFile(join(stateRoot, 'config.json'), 'utf8'));
  assert.equal(config.ownerId, 'own_A');
  assert.equal(config.agentId, 'agt_1');
  await rm(root, { recursive: true, force: true });
});

test('message retries reuse a durable idempotency key after a committed response is lost', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-idempotency-'));
  const mockStatePath = join(root, 'mock-state.json');
  await writeFile(mockStatePath, JSON.stringify({ seenKeys: [], committed: {}, dropFirst: true }));

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    import { readFileSync, writeFileSync } from 'node:fs';
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      const headers = { 'content-type': 'application/json' };
      if (u.includes('/v1/sessions') && !u.includes('heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_retry', session_token: 'temporary-session-token', expires_at: '2099-01-01T00:00:00Z', inbox_cursor: 'c1', bootstrap: {} } }), { headers });
      }
      if (u.includes('/v1/sessions/ses_retry/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_retry' } }), { headers });
      }
      if (u.includes('/v1/rooms/rom_retry/messages')) {
        const state = JSON.parse(readFileSync('${mockStatePath}', 'utf8'));
        const key = opts.headers?.['idempotency-key'];
        state.seenKeys.push(key);
        if (!state.committed[key]) {
          state.committed[key] = { message_id: 'msg_1', ...JSON.parse(opts.body || '{}') };
        }
        if (state.dropFirst) {
          state.dropFirst = false;
          writeFileSync('${mockStatePath}', JSON.stringify(state));
          throw new TypeError('fetch failed');
        }
        writeFileSync('${mockStatePath}', JSON.stringify(state));
        return new Response(JSON.stringify({ data: state.committed[key] }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'missing' } }), { status: 404, headers });
    };
  `);

  const url = 'https://mock.test';
  await run(['configure', '--server', url], { cwd: root, preload: preloadPath });
  await import('../src/state.js').then(async ({ LocalState }) => {
    await new LocalState(join(root, '.olimpyx')).saveCredential('agent-token');
  });
  assert.equal((await run(['session', 'begin', '--caller-id', 'retry-test', '--host', 'codex'], { cwd: root, preload: preloadPath })).status, 0);
  const command = ['message', '--room', 'rom_retry', '--recipient', 'agt_peer', '--body', 'same logical message', '--caller-id', 'retry-test'];
  const first = await run(command, { cwd: root, preload: preloadPath });
  assert.equal(first.status, 1);
  assert.match(first.stderr, /fetch failed/);
  const second = await run(command, { cwd: root, preload: preloadPath });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).data.message_id, 'msg_1');

  const finalState = JSON.parse(await readFile(mockStatePath, 'utf8'));
  assert.equal(finalState.seenKeys.length, 2);
  assert.equal(finalState.seenKeys[0], finalState.seenKeys[1]);
  assert.equal(Object.keys(finalState.committed).length, 1);
  await assert.rejects(readFile(join(root, '.olimpyx', 'pending-mutations.json'), 'utf8'), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('listen CLI validates caller-id and active session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-val-'));
  const noCaller = await run(['listen'], { cwd: root });
  assert.equal(noCaller.status, 1);
  assert.match(noCaller.stderr, /--caller-id is required/);

  const noSession = await run(['listen', '--caller-id', 'test_caller'], { cwd: root });
  assert.equal(noSession.status, 1);
  assert.match(noSession.stderr, /No local session/);
});

// ---------------------------------------------------------------------------
// Q-016: agent stop, usage, limits, budget show|set, task decline
// ---------------------------------------------------------------------------

async function ownerConfiguredRoot(preloadBody) {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-q016-'));
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, preloadBody);
  await run(['configure', '--server', 'https://mock.test'], { cwd: root, preload: preloadPath });
  await writeFile(join(root, '.olimpyx', 'owner-credential'), 'owner-token-value', { mode: 0o600 });
  return { root, preloadPath };
}

test('agent stop calls the owner stop route with --reason and an idempotency key', async () => {
  const logFile = (root) => join(root, 'calls.log');
  const { root, preloadPath } = await ownerConfiguredRoot('');
  await writeFile(preloadPath, `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      appendFileSync('${logFile(root)}', init.method + ' ' + u + ' auth=' + (init.headers?.authorization || '') + ' idem=' + (init.headers?.['idempotency-key'] || '') + ' body=' + (init.body || '') + '\\n');
      return new Response(JSON.stringify({ data: { agent_id: 'agt_1', stop_requested: true } }), { headers: { 'content-type': 'application/json' } });
    };
  `);

  const res = await run(['agent', 'stop', 'agt_1', '--reason', 'pausing'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).data.agent_id, 'agt_1');
  const logs = await readFile(logFile(root), 'utf8');
  assert.match(logs, /POST https:\/\/mock\.test\/v1\/owners\/me\/agents\/agt_1\/stop/);
  assert.match(logs, /auth=Bearer owner-token-value/);
  assert.match(logs, /idem=[^\s]+/);
  assert.match(logs, /body=\{"reason":"pausing"\}/);
  await rm(root, { recursive: true, force: true });
});

test('agent stop requires an agentId', async () => {
  const { root, preloadPath } = await ownerConfiguredRoot('globalThis.fetch = async () => new Response("{}", { headers: { "content-type": "application/json" } });');
  const res = await run(['agent', 'stop'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /agent stop requires <agentId>/);
  await rm(root, { recursive: true, force: true });
});

test('usage calls the owner usage route without --caller-id', async () => {
  const { root, preloadPath } = await ownerConfiguredRoot(`
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/v1/owners/me/usage')) return new Response(JSON.stringify({ data: { scope: 'owner' } }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ error: { message: 'unexpected ' + u } }), { status: 500, headers: { 'content-type': 'application/json' } });
    };
  `);
  const res = await run(['usage'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).data.scope, 'owner');
  await rm(root, { recursive: true, force: true });
});

test('limits falls back to the owner credential when no --caller-id session is active', async () => {
  const { root, preloadPath } = await ownerConfiguredRoot(`
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/v1/limits')) return new Response(JSON.stringify({ data: { actions: {} } }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ error: { message: 'unexpected ' + u } }), { status: 500, headers: { 'content-type': 'application/json' } });
    };
  `);
  const res = await run(['limits'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).data, { actions: {} });
  await rm(root, { recursive: true, force: true });
});

test('budget show reports the default budget when no budget.json exists, and set persists a patch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-q016-'));
  const show1 = await run(['budget', 'show'], { cwd: root });
  assert.equal(show1.status, 0, show1.stderr);
  assert.deepEqual(JSON.parse(show1.stdout), { help: 'on', contacts: [] });

  const set = await run(['budget', 'set', '--help', 'contacts', '--contacts', 'agt_a,agt_b', '--messages-per-hour', '15', '--session-minutes', '90'], { cwd: root });
  assert.equal(set.status, 0, set.stderr);
  const setResult = JSON.parse(set.stdout);
  assert.equal(setResult.help, 'contacts');
  assert.deepEqual(setResult.contacts, ['agt_a', 'agt_b']);
  assert.equal(setResult.messages_per_hour, 15);
  assert.equal(setResult.session_minutes, 90);

  const show2 = await run(['budget', 'show'], { cwd: root });
  assert.deepEqual(JSON.parse(show2.stdout), setResult);
  await rm(root, { recursive: true, force: true });
});

test('budget set rejects an invalid --help value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-q016-'));
  const res = await run(['budget', 'set', '--help', 'bogus'], { cwd: root });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--help must be one of: on, contacts, off/);
  await rm(root, { recursive: true, force: true });
});

test('session begin refuses locally with OLIMPYX_BUDGET_EXCEEDED once cumulative session_minutes across sessions in the last 24h is reached, with no network call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-q016-'));
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      return new Response(JSON.stringify({ error: { message: 'network call should not happen: ' + String(url) } }), { status: 500, headers: { 'content-type': 'application/json' } });
    };
  `);
  await run(['configure', '--server', 'https://mock.test'], { cwd: root, preload: preloadPath });
  await import('../src/state.js').then(async ({ LocalState }) => {
    await new LocalState(join(root, '.olimpyx')).saveCredential('agent-token');
  });
  const now = Date.now();
  await writeFile(join(root, '.olimpyx', 'budget.json'), JSON.stringify({ help: 'on', contacts: [], session_minutes: 30 }));
  await writeFile(join(root, '.olimpyx', 'budget-ledger.json'), JSON.stringify({
    session_history: [{ session_id: 'ses_prev', started_at: now - 60 * 60_000, ended_at: now - 30 * 60_000 }]
  }));

  const res = await run(['session', 'begin', '--caller-id', 'begin-test', '--host', 'codex'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /OLIMPYX_BUDGET_EXCEEDED/);
  assert.equal(res.stderr.includes('network call should not happen'), false, 'session begin must refuse before any network call');
  const sessionExists = await readFile(join(root, '.olimpyx', 'session.json'), 'utf8').then(() => true).catch(() => false);
  assert.equal(sessionExists, false, 'no local session should be saved when the begin budget is exhausted');
  await rm(root, { recursive: true, force: true });
});

test('session begin is unaffected by session_minutes when cumulative history is under the limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-q016-'));
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/v1/sessions')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_new', session_token: 'temp-token', expires_at: '2099-01-01T00:00:00Z', inbox_cursor: 'c1', bootstrap: {} } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { message: 'unexpected ' + u } }), { status: 500, headers: { 'content-type': 'application/json' } });
    };
  `);
  await run(['configure', '--server', 'https://mock.test'], { cwd: root, preload: preloadPath });
  await import('../src/state.js').then(async ({ LocalState }) => {
    await new LocalState(join(root, '.olimpyx')).saveCredential('agent-token');
  });
  const now = Date.now();
  await writeFile(join(root, '.olimpyx', 'budget.json'), JSON.stringify({ help: 'on', contacts: [], session_minutes: 30 }));
  await writeFile(join(root, '.olimpyx', 'budget-ledger.json'), JSON.stringify({
    session_history: [{ session_id: 'ses_prev', started_at: now - 60 * 60_000, ended_at: now - 50 * 60_000 }]
  }));

  const res = await run(['session', 'begin', '--caller-id', 'begin-test-2', '--host', 'codex'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).session_id, 'ses_new');
  await rm(root, { recursive: true, force: true });
});

test('task decline sends a PATCH with status cancelled and the reason as result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-q016-'));
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      const headers = { 'content-type': 'application/json' };
      if (u.includes('/v1/sessions') && !u.includes('heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1', session_token: 'temp-token', expires_at: '2099-01-01T00:00:00Z', inbox_cursor: 'c1', bootstrap: {} } }), { headers });
      }
      if (u.includes('/heartbeat')) return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers });
      if (u.includes('/v1/tasks/tsk_1')) {
        return new Response(JSON.stringify({ data: { task_id: 'tsk_1', status: 'cancelled', result: JSON.parse(opts.body).result } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'missing ' + u } }), { status: 404, headers });
    };
  `);
  await run(['configure', '--server', 'https://mock.test'], { cwd: root, preload: preloadPath });
  await import('../src/state.js').then(async ({ LocalState }) => {
    await new LocalState(join(root, '.olimpyx')).saveCredential('agent-token');
  });
  await run(['session', 'begin', '--caller-id', 'decline-test', '--host', 'codex'], { cwd: root, preload: preloadPath });

  const res = await run(['task', 'decline', 'tsk_1', '--reason', 'overloaded', '--caller-id', 'decline-test'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.data.status, 'cancelled');
  assert.equal(parsed.data.result, 'overloaded');
  await rm(root, { recursive: true, force: true });
});

test('task decline requires --reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-q016-'));
  const res = await run(['task', 'decline', 'tsk_1', '--caller-id', 'x'], { cwd: root });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--reason is required/);
  await rm(root, { recursive: true, force: true });
});
