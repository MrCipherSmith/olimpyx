import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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
  const rooms = await run(['rooms', '--caller-id', 'active-test'], { cwd: root, preload: preloadPath });
  assert.equal(rooms.status, 0, rooms.stderr);
  assert.equal(rooms.stdout.includes('remote-content-shaped-like-token'), false);
  const unsafeGeneric = await run(['request', 'POST', '/v1/agents/enroll', '{}', '--caller-id', 'active-test'], { cwd: root, preload: preloadPath });
  assert.equal(unsafeGeneric.status, 1);
  assert.match(unsafeGeneric.stderr, /Credential-issuing endpoints are blocked/);
  const invalidEnd = await run(['session', 'end', '--reason', 'completed'], { cwd: root, preload: preloadPath });
  assert.equal(invalidEnd.status, 1);
  assert.match(invalidEnd.stderr, /Session end reason must be/);
  assert.equal((await readFile(join(stateRoot, 'session.json'), 'utf8')).includes('ses_1'), true);
  const ended = await run(['session', 'end'], { cwd: root, preload: preloadPath });
  assert.equal(ended.status, 0, ended.stderr);

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

