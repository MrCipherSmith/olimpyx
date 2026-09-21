import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

function run(args, { cwd, input = '', env = {}, preload = null }) {
  return new Promise((resolveResult) => {
    const nodeArgs = preload ? ['--import', preload, cli, ...args] : [cli, ...args];
    const child = spawn(process.execPath, nodeArgs, {
      cwd,
      env: { ...process.env, OLIMPYX_HOME: join(cwd, '.olimpyx'), ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolveResult({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

// Sets up a participant home with an already-active session for `call_1`, the same way
// threads.test.js does it: writing session.json / session-credential directly rather than
// going through the full owner-login/enroll/session-begin flow.
async function seededRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const stateDir = join(root, '.olimpyx');
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'calls', 'call_1', 'session-credential'), 'secret\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'calls', 'call_1', 'session.json'), JSON.stringify({
    session_id: 'ses_1',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString()
  }));
  return { root, stateDir };
}

// One shared preload: logs every request (method, url, idempotency-key header, body) to a
// file and answers with a minimal success payload for each of the four room routes plus the
// heartbeat every activeClient() call makes first.
async function preloadLogging(root, logFile) {
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const headers = { 'content-type': 'application/json' };
      appendFileSync('${logFile}', JSON.stringify({
        method: init.method || 'GET',
        url: u,
        idempotencyKey: init.headers?.['idempotency-key'] || null,
        body: init.body || null
      }) + '\\n');
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers });
      }
      if (init.method === 'POST' && u.endsWith('/v1/rooms')) {
        return new Response(JSON.stringify({ data: { room_id: 'rom_new_1', title: 'Title' } }), { status: 201, headers });
      }
      if (init.method === 'POST' && u.endsWith('/members')) {
        return new Response(JSON.stringify({ data: { room_id: 'rom_1', agent_id: 'agt_1', joined_at: '2026-09-21T00:00:00.000Z' } }), { headers });
      }
      if (init.method === 'DELETE' && u.endsWith('/members/me')) {
        return new Response(JSON.stringify({ data: { room_id: 'rom_1', agent_id: 'agt_1', left: true } }), { headers });
      }
      if (init.method === 'PATCH' && /\\/v1\\/rooms\\/[^/]+$/.test(u)) {
        return new Response(JSON.stringify({ data: { room_id: 'rom_1', goal: 'Ship it', goal_status: 'open' } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'unexpected request: ' + u } }), { status: 404, headers });
    };
  `);
  return preloadPath;
}

async function readLog(logFile) {
  try {
    const text = await readFile(logFile, 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

test('room new sends POST /v1/rooms with title, description, goal, criteria and an idempotency key', async () => {
  const { root } = await seededRoot('olimpyx-room-new-');
  const logFile = join(root, 'calls.log');
  const preloadPath = await preloadLogging(root, logFile);

  const res = await run([
    'room', 'new',
    '--title', 'War room',
    '--description', 'Coordinate the launch',
    '--goal', 'Ship the release',
    '--criteria', '["tests green","docs updated"]',
    '--caller-id', 'call_1'
  ], { cwd: root, preload: preloadPath });

  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).data.room_id, 'rom_new_1');

  const log = await readLog(logFile);
  const createCall = log.find((entry) => entry.method === 'POST' && entry.url.endsWith('/v1/rooms'));
  assert.ok(createCall, 'expected a POST /v1/rooms request');
  assert.ok(createCall.idempotencyKey, 'expected an idempotency-key header');
  const body = JSON.parse(createCall.body);
  assert.deepEqual(body, {
    title: 'War room',
    description: 'Coordinate the launch',
    goal: 'Ship the release',
    success_criteria: ['tests green', 'docs updated']
  });

  await rm(root, { recursive: true, force: true });
});

test('room new requires --title', async () => {
  const { root } = await seededRoot('olimpyx-room-new-notitle-');
  const res = await run(['room', 'new', '--caller-id', 'call_1'], { cwd: root });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--title is required/);
  await rm(root, { recursive: true, force: true });
});

test('room new reads --criteria from an @file argument', async () => {
  const { root } = await seededRoot('olimpyx-room-new-file-');
  const logFile = join(root, 'calls.log');
  const preloadPath = await preloadLogging(root, logFile);
  const criteriaFile = join(root, 'criteria.json');
  await writeFile(criteriaFile, JSON.stringify(['a', 'b']));

  const res = await run([
    'room', 'new',
    '--title', 'War room',
    '--criteria', `@${criteriaFile}`,
    '--caller-id', 'call_1'
  ], { cwd: root, preload: preloadPath });

  assert.equal(res.status, 0, res.stderr);
  const log = await readLog(logFile);
  const createCall = log.find((entry) => entry.method === 'POST' && entry.url.endsWith('/v1/rooms'));
  const body = JSON.parse(createCall.body);
  assert.deepEqual(body.success_criteria, ['a', 'b']);

  await rm(root, { recursive: true, force: true });
});

test('room join sends POST /v1/rooms/:roomId/members with an idempotency key', async () => {
  const { root } = await seededRoot('olimpyx-room-join-');
  const logFile = join(root, 'calls.log');
  const preloadPath = await preloadLogging(root, logFile);

  const res = await run(['room', 'join', '--room', 'rom_1', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).data.room_id, 'rom_1');

  const log = await readLog(logFile);
  const joinCall = log.find((entry) => entry.method === 'POST' && entry.url.endsWith('/v1/rooms/rom_1/members'));
  assert.ok(joinCall, 'expected a POST /v1/rooms/rom_1/members request');
  assert.ok(joinCall.idempotencyKey, 'expected an idempotency-key header');

  await rm(root, { recursive: true, force: true });
});

test('room join requires --room', async () => {
  const { root } = await seededRoot('olimpyx-room-join-noroom-');
  const res = await run(['room', 'join', '--caller-id', 'call_1'], { cwd: root });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--room is required/);
  await rm(root, { recursive: true, force: true });
});

test('room leave sends DELETE /v1/rooms/:roomId/members/me with an idempotency key', async () => {
  const { root } = await seededRoot('olimpyx-room-leave-');
  const logFile = join(root, 'calls.log');
  const preloadPath = await preloadLogging(root, logFile);

  const res = await run(['room', 'leave', '--room', 'rom_1', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).data.left, true);

  const log = await readLog(logFile);
  const leaveCall = log.find((entry) => entry.method === 'DELETE' && entry.url.endsWith('/v1/rooms/rom_1/members/me'));
  assert.ok(leaveCall, 'expected a DELETE /v1/rooms/rom_1/members/me request');
  assert.ok(leaveCall.idempotencyKey, 'expected an idempotency-key header');

  await rm(root, { recursive: true, force: true });
});

test('room goal sends PATCH /v1/rooms/:roomId with only the provided fields and an idempotency key', async () => {
  const { root } = await seededRoot('olimpyx-room-goal-');
  const logFile = join(root, 'calls.log');
  const preloadPath = await preloadLogging(root, logFile);

  const res = await run([
    'room', 'goal',
    '--room', 'rom_1',
    '--set', 'Ship it',
    '--status', 'reached',
    '--caller-id', 'call_1'
  ], { cwd: root, preload: preloadPath });

  assert.equal(res.status, 0, res.stderr);
  const log = await readLog(logFile);
  const patchCall = log.find((entry) => entry.method === 'PATCH' && entry.url.endsWith('/v1/rooms/rom_1'));
  assert.ok(patchCall, 'expected a PATCH /v1/rooms/rom_1 request');
  assert.ok(patchCall.idempotencyKey, 'expected an idempotency-key header');
  assert.deepEqual(JSON.parse(patchCall.body), { goal: 'Ship it', goal_status: 'reached' });

  await rm(root, { recursive: true, force: true });
});

test('room goal with only --criteria sends just success_criteria', async () => {
  const { root } = await seededRoot('olimpyx-room-goal-criteria-');
  const logFile = join(root, 'calls.log');
  const preloadPath = await preloadLogging(root, logFile);

  const res = await run([
    'room', 'goal',
    '--room', 'rom_1',
    '--criteria', '["a","b","c"]',
    '--caller-id', 'call_1'
  ], { cwd: root, preload: preloadPath });

  assert.equal(res.status, 0, res.stderr);
  const log = await readLog(logFile);
  const patchCall = log.find((entry) => entry.method === 'PATCH' && entry.url.endsWith('/v1/rooms/rom_1'));
  assert.deepEqual(JSON.parse(patchCall.body), { success_criteria: ['a', 'b', 'c'] });

  await rm(root, { recursive: true, force: true });
});

test('room goal rejects an unknown --status locally without making a request', async () => {
  const { root } = await seededRoot('olimpyx-room-goal-badstatus-');
  const logFile = join(root, 'calls.log');
  const preloadPath = await preloadLogging(root, logFile);

  const res = await run(['room', 'goal', '--room', 'rom_1', '--status', 'nope', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--status must be one of/);

  const log = await readLog(logFile);
  assert.equal(log.some((entry) => entry.method === 'PATCH'), false, 'no PATCH request should have been sent');

  await rm(root, { recursive: true, force: true });
});

test('room goal with none of --set, --criteria, --status refuses locally without sending an empty body', async () => {
  const { root } = await seededRoot('olimpyx-room-goal-empty-');
  const logFile = join(root, 'calls.log');
  const preloadPath = await preloadLogging(root, logFile);

  const res = await run(['room', 'goal', '--room', 'rom_1', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /at least one of --set, --criteria, --status/);

  const log = await readLog(logFile);
  assert.equal(log.some((entry) => entry.method === 'PATCH'), false, 'no PATCH request should have been sent for an empty goal update');

  await rm(root, { recursive: true, force: true });
});

test('room goal requires --room', async () => {
  const { root } = await seededRoot('olimpyx-room-goal-noroom-');
  const res = await run(['room', 'goal', '--set', 'Ship it', '--caller-id', 'call_1'], { cwd: root });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--room is required/);
  await rm(root, { recursive: true, force: true });
});

test('unknown room action reports the available actions', async () => {
  const { root } = await seededRoot('olimpyx-room-unknown-');
  const res = await run(['room', 'bogus', '--caller-id', 'call_1'], { cwd: root });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /room actions: new/);
  await rm(root, { recursive: true, force: true });
});
