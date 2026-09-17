import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
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
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolveResult({ status, stdout, stderr, child }));
    child.stdin.end(input);
  });
}

test('listen requires --caller-id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const res = await run(['listen'], { cwd: root });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--caller-id is required/);
  await rm(root, { recursive: true, force: true });
});

test('listen requires active local session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const res = await run(['listen', '--caller-id', 'call_1'], { cwd: root });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /No local session/);
  await rm(root, { recursive: true, force: true });
});

test('listen receives inbox events, persists cursor, and redacts credentials in output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'session-credential'), 'secret-session-token\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: 'ses_1',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString(),
    inbox_cursor: 'c0'
  }));

  const preloadPath = join(root, 'mock.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/inbox/events')) {
        return new Response(JSON.stringify({
          data: [{
            event_id: 'evt_1',
            cursor: 'c_received',
            type: 'message.created',
            session_token: 'secret-session-token'
          }],
          page: { next_cursor: 'c_received' }
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    };
  `);

  const res = await run(['listen', '--caller-id', 'call_1', '--max-wait-min', '1'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);

  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, 'received');
  assert.equal(parsed.data.length, 1);
  assert.equal(parsed.data[0].event_id, 'evt_1');
  assert.equal(parsed.data[0].session_token, '[REDACTED]');
  assert.equal(parsed.page.next_cursor, 'c_received');
  assert.equal(parsed.poll_cycles, 1);

  // Check cursor persisted to session.json
  const session = JSON.parse(await readFile(join(stateDir, 'session.json'), 'utf8'));
  assert.equal(session.inbox_cursor, 'c_received');
  await rm(root, { recursive: true, force: true });
});

test('listen outputs idle_timeout when deadline expires', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'session-credential'), 'secret-session-token\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: 'ses_1',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString(),
    inbox_cursor: 'c0'
  }));

  const preloadPath = join(root, 'mock.mjs');
  // Return empty data
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/inbox/events')) {
        return new Response(JSON.stringify({ data: [], page: { next_cursor: 'c0' } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    };
  `);

  // Max wait ~120ms, poll timeout 50ms
  const res = await run(['listen', '--caller-id', 'call_1', '--max-wait-min', '0.002', '--poll-timeout-sec', '0.05'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, 'idle_timeout');
  assert.deepEqual(parsed.data, []);
  assert.equal(parsed.page.next_cursor, 'c0');
  await rm(root, { recursive: true, force: true });
});

test('listen handles unrecoverable error like HTTP 401 with status error payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'session-credential'), 'secret-session-token\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: 'ses_1',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString(),
    inbox_cursor: 'c0'
  }));

  const preloadPath = join(root, 'mock.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ error: { message: 'Session expired or rejected by server (HTTP 401)' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    };
  `);

  const res = await run(['listen', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 1);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, 'error');
  assert.equal(parsed.error.code, 'SESSION_EXPIRED');
  assert.match(parsed.error.message, /Session expired/);
  await rm(root, { recursive: true, force: true });
});

test('listen traps SIGINT, ends session, clears session state, and exits 130', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'session-credential'), 'secret-session-token\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: 'ses_1',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString(),
    inbox_cursor: 'c0'
  }));

  const logFile = join(root, 'calls.log');
  const preloadPath = join(root, 'mock.mjs');
  await writeFile(preloadPath, `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      appendFileSync('${logFile}', init.method + ' ' + u + ' body=' + (init.body || '') + '\\n');
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/end')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/inbox/events')) {
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(new Response(JSON.stringify({ data: [] }))), 10000);
          if (init.signal) {
            init.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            });
          }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    };
  `);

  const child = spawn(process.execPath, ['--import', preloadPath, cli, 'listen', '--caller-id', 'call_1', '--max-wait-min', '1'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Allow heartbeat to be sent and wait to start
  await new Promise((r) => setTimeout(r, 300));
  child.kill('SIGINT');

  const status = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(status, 130);

  const logs = await readFile(logFile, 'utf8');
  assert.match(logs, /POST https:\/\/mock\.test\/v1\/sessions\/ses_1\/heartbeat/);
  assert.match(logs, /POST https:\/\/mock\.test\/v1\/sessions\/ses_1\/end body=\{"reason":"agent_ended"\}/);

  const sessionExists = await stat(join(stateDir, 'session.json')).then(() => true).catch(() => false);
  assert.equal(sessionExists, false, 'session.json should be deleted after SIGINT');
  await rm(root, { recursive: true, force: true });
});

test('listen traps SIGTERM, ends session, clears session state, and exits 143', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'session-credential'), 'secret-session-token\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: 'ses_1',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString(),
    inbox_cursor: 'c0'
  }));

  const logFile = join(root, 'calls.log');
  const preloadPath = join(root, 'mock.mjs');
  await writeFile(preloadPath, `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      appendFileSync('${logFile}', init.method + ' ' + u + ' body=' + (init.body || '') + '\\n');
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/end')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/inbox/events')) {
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(new Response(JSON.stringify({ data: [] }))), 10000);
          if (init.signal) {
            init.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            });
          }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    };
  `);

  const child = spawn(process.execPath, ['--import', preloadPath, cli, 'listen', '--caller-id', 'call_1', '--max-wait-min', '1'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  await new Promise((r) => setTimeout(r, 300));
  child.kill('SIGTERM');

  const status = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(status, 143);

  const logs = await readFile(logFile, 'utf8');
  assert.match(logs, /POST https:\/\/mock\.test\/v1\/sessions\/ses_1\/heartbeat/);
  assert.match(logs, /POST https:\/\/mock\.test\/v1\/sessions\/ses_1\/end body=\{"reason":"agent_ended"\}/);

  const sessionExists = await stat(join(stateDir, 'session.json')).then(() => true).catch(() => false);
  assert.equal(sessionExists, false, 'session.json should be deleted after SIGTERM');
  await rm(root, { recursive: true, force: true });
});
