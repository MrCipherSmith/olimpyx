import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');
function run(args, { cwd, input = '', env = {} }) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolveResult({ status, stdout, stderr })); child.stdin.end(input);
  });
}

test('login and enrollment serialize credentials only to private files', async (t) => {
  const ownerToken = 'owner-token-that-must-not-be-printed'; const agentToken = 'agent-token-that-must-not-be-printed';
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/owners/login') response.end(JSON.stringify({ data: { owner: { owner_id: 'own_1', email: 'owner@example.test', display_name: 'Owner' }, access_token: ownerToken, expires_at: '2099-01-01T00:00:00Z' } }));
    else if (request.url === '/v1/owners/me/enrollment-tokens') response.end(JSON.stringify({ data: { enrollment_token: 'one-use-enrollment-secret', expires_at: '2099-01-01T00:00:00Z' } }));
    else if (request.url === '/v1/agents/enroll') response.end(JSON.stringify({ data: { agent: { agent_id: 'agt_1', profile_revision: 1 }, agent_token: agentToken, created_at: '2026-09-12T00:00:00Z' } }));
    else if (request.url === '/v1/sessions') response.end(JSON.stringify({ data: { session_id: 'ses_1', session_token: 'temporary-session-token', expires_at: '2099-01-01T00:00:00Z', inbox_cursor: 'c1', bootstrap: {} } }));
    else if (request.url === '/v1/sessions/ses_1/heartbeat') response.end(JSON.stringify({ data: { session_id: 'ses_1' } }));
    else if (request.url === '/v1/rooms') { assert.equal(request.headers.authorization, 'Bearer temporary-session-token'); response.end(JSON.stringify({ data: [{ agent_token: 'remote-content-shaped-like-token' }], page: { next_cursor: null } })); }
    else if (request.url === '/v1/sessions/ses_1/end') response.end(JSON.stringify({ data: { session_id: 'ses_1' } }));
    else { response.statusCode = 404; response.end(JSON.stringify({ error: { message: 'missing' } })); }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen)); t.after(() => server.close());
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-')); const stateRoot = join(root, '.olimpyx'); const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await run(['configure', '--server', url], { cwd: root })).status, 0);
  const login = await run(['owner-login', '--email', 'owner@example.test', '--password-stdin'], { cwd: root, input: 'a-safe-password\n' });
  assert.equal(login.status, 0, login.stderr); assert.equal(`${login.stdout}${login.stderr}`.includes(ownerToken), false);
  const profile = JSON.stringify({ name: 'Nova', role: 'tester', bio: '', interests: [], capabilities: [] });
  const enroll = await run(['enroll', '--profile', profile], { cwd: root });
  assert.equal(enroll.status, 0, enroll.stderr); assert.equal(`${enroll.stdout}${enroll.stderr}`.includes(agentToken), false);
  assert.equal(await readFile(join(stateRoot, 'owner-credential'), 'utf8'), ownerToken);
  assert.equal(await readFile(join(stateRoot, 'credential'), 'utf8'), agentToken);
  const begun = await run(['session', 'begin', '--caller-id', 'active-test', '--host', 'codex'], { cwd: root });
  assert.equal(begun.status, 0, begun.stderr); assert.equal(`${begun.stdout}${begun.stderr}`.includes('temporary-session-token'), false);
  const rooms = await run(['rooms', '--caller-id', 'active-test'], { cwd: root });
  assert.equal(rooms.status, 0, rooms.stderr);
  assert.equal(rooms.stdout.includes('remote-content-shaped-like-token'), false);
  const unsafeGeneric = await run(['request', 'POST', '/v1/agents/enroll', '{}', '--caller-id', 'active-test'], { cwd: root });
  assert.equal(unsafeGeneric.status, 1); assert.match(unsafeGeneric.stderr, /Credential-issuing endpoints are blocked/);
  const invalidEnd = await run(['session', 'end', '--reason', 'completed'], { cwd: root });
  assert.equal(invalidEnd.status, 1); assert.match(invalidEnd.stderr, /Session end reason must be/);
  assert.equal((await readFile(join(stateRoot, 'session.json'), 'utf8')).includes('ses_1'), true);
  const ended = await run(['session', 'end'], { cwd: root }); assert.equal(ended.status, 0, ended.stderr);
});

test('message retries reuse a durable idempotency key after a committed response is lost', async (t) => {
  const seenKeys = [];
  const committed = new Map();
  let dropFirstResponse = true;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/sessions') {
      response.end(JSON.stringify({ data: { session_id: 'ses_retry', session_token: 'temporary-session-token', expires_at: '2099-01-01T00:00:00Z', inbox_cursor: 'c1', bootstrap: {} } }));
      return;
    }
    if (request.url === '/v1/sessions/ses_retry/heartbeat') {
      response.end(JSON.stringify({ data: { session_id: 'ses_retry' } }));
      return;
    }
    if (request.url === '/v1/rooms/rom_retry/messages') {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const key = request.headers['idempotency-key'];
        seenKeys.push(key);
        if (!committed.has(key)) committed.set(key, { message_id: `msg_${committed.size + 1}`, ...JSON.parse(raw) });
        if (dropFirstResponse) {
          dropFirstResponse = false;
          request.socket.destroy();
          return;
        }
        response.end(JSON.stringify({ data: committed.get(key) }));
      });
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: 'missing' } }));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => server.close());
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-idempotency-'));
  const url = `http://127.0.0.1:${server.address().port}`;
  await run(['configure', '--server', url], { cwd: root });
  await import('../src/state.js').then(async ({ LocalState }) => {
    await new LocalState(join(root, '.olimpyx')).saveCredential('agent-token');
  });
  assert.equal((await run(['session', 'begin', '--caller-id', 'retry-test', '--host', 'codex'], { cwd: root })).status, 0);
  const command = ['message', '--room', 'rom_retry', '--recipient', 'agt_peer', '--body', 'same logical message', '--caller-id', 'retry-test'];
  const first = await run(command, { cwd: root });
  assert.equal(first.status, 1);
  assert.match(first.stderr, /fetch failed/);
  const second = await run(command, { cwd: root });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).data.message_id, 'msg_1');
  assert.equal(seenKeys.length, 2);
  assert.equal(seenKeys[0], seenKeys[1]);
  assert.equal(committed.size, 1);
  await assert.rejects(readFile(join(root, '.olimpyx', 'pending-mutations.json'), 'utf8'), { code: 'ENOENT' });
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

