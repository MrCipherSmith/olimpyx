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
      env: { ...process.env, OLIMPYX_HOME: join(cwd, '.olimpyx'), ...env },
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
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'calls', 'call_1', 'session-credential'), 'secret-session-token\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'calls', 'call_1', 'session.json'), JSON.stringify({
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
  const session = JSON.parse(await readFile(join(stateDir, 'calls', 'call_1', 'session.json'), 'utf8'));
  assert.equal(session.inbox_cursor, 'c_received');
  await rm(root, { recursive: true, force: true });
});

test('listen outputs idle_timeout when deadline expires', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'calls', 'call_1', 'session-credential'), 'secret-session-token\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'calls', 'call_1', 'session.json'), JSON.stringify({
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
        return new Response(JSON.stringify({ data: [], page: { next_cursor: 'c_advanced_empty' } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    };
  `);

  // Max wait ~120ms, poll timeout 50ms (enabled via OLIMPYX_TEST_FAST_TIMEOUT)
  const res = await run(['listen', '--caller-id', 'call_1', '--max-wait-min', '0.002', '--poll-timeout-sec', '0.05'], { cwd: root, env: { OLIMPYX_TEST_FAST_TIMEOUT: '1' }, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, 'idle_timeout');
  assert.deepEqual(parsed.data, []);
  assert.equal(parsed.page.next_cursor, 'c_advanced_empty');

  // Verify cursor persistence to session.json even on idle_timeout with empty data (Blocker 1 fix)
  const session = JSON.parse(await readFile(join(stateDir, 'calls', 'call_1', 'session.json'), 'utf8'));
  assert.equal(session.inbox_cursor, 'c_advanced_empty');

  await rm(root, { recursive: true, force: true });
});

test('listen rejects out-of-bounds --max-wait-min and --poll-timeout-sec without silent clamping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-bounds-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'calls', 'call_1', 'session-credential'), 'secret\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'calls', 'call_1', 'session.json'), JSON.stringify({
    session_id: 'ses_1',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString()
  }));

  const tooLowMax = await run(['listen', '--caller-id', 'call_1', '--max-wait-min', '0'], { cwd: root });
  assert.equal(tooLowMax.status, 1);
  assert.match(tooLowMax.stderr, /--max-wait-min must be a number between 1 and 60/);

  const tooHighMax = await run(['listen', '--caller-id', 'call_1', '--max-wait-min', '61'], { cwd: root });
  assert.equal(tooHighMax.status, 1);
  assert.match(tooHighMax.stderr, /--max-wait-min must be a number between 1 and 60/);

  const notNumberMax = await run(['listen', '--caller-id', 'call_1', '--max-wait-min', 'abc'], { cwd: root });
  assert.equal(notNumberMax.status, 1);
  assert.match(notNumberMax.stderr, /--max-wait-min must be a number between 1 and 60/);

  const tooLowPoll = await run(['listen', '--caller-id', 'call_1', '--poll-timeout-sec', '4'], { cwd: root });
  assert.equal(tooLowPoll.status, 1);
  assert.match(tooLowPoll.stderr, /--poll-timeout-sec must be a number between 5 and 30/);

  const tooHighPoll = await run(['listen', '--caller-id', 'call_1', '--poll-timeout-sec', '31'], { cwd: root });
  assert.equal(tooHighPoll.status, 1);
  assert.match(tooHighPoll.stderr, /--poll-timeout-sec must be a number between 5 and 30/);

  await rm(root, { recursive: true, force: true });
});

test('listen handles unrecoverable error like HTTP 401 with status error payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'calls', 'call_1', 'session-credential'), 'secret-session-token\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'calls', 'call_1', 'session.json'), JSON.stringify({
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

// ---------------------------------------------------------------------------
// Q-016: typed session-failure mapping, best-effort inbox cursor ack, and the
// local session_minutes budget ending listen with BUDGET_EXHAUSTED.
// ---------------------------------------------------------------------------

function baseSessionFiles(stateDir) {
  return Promise.all([
    writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' })),
    writeFile(join(stateDir, 'calls', 'call_1', 'session-credential'), 'secret-session-token\n', { mode: 0o600 }),
    writeFile(join(stateDir, 'calls', 'call_1', 'session.json'), JSON.stringify({
      session_id: 'ses_1',
      caller_id: 'call_1',
      caller_deadline: new Date(Date.now() + 60000).toISOString(),
      inbox_cursor: 'c0'
    }))
  ]);
}

for (const [heartbeatCode, heartbeatStatus, expectedCliCode] of [
  ['session_stopped', 401, 'STOP_REQUESTED'],
  ['session_superseded', 401, 'SESSION_SUPERSEDED'],
  ['agent_revoked', 401, 'AGENT_REVOKED'],
  ['restricted', 403, 'RESTRICTED'],
  ['session_expired', 401, 'SESSION_EXPIRED']
]) {
  test(`listen maps ${heartbeatCode} (HTTP ${heartbeatStatus}) to ${expectedCliCode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
    const stateDir = join(root, '.olimpyx');
    await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
    await baseSessionFiles(stateDir);

    const preloadPath = join(root, 'mock.mjs');
    await writeFile(preloadPath, `
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/heartbeat')) {
          return new Response(JSON.stringify({ error: { message: 'blocked', code: '${heartbeatCode}' } }), {
            status: ${heartbeatStatus},
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
    assert.equal(parsed.error.code, expectedCliCode);
    await rm(root, { recursive: true, force: true });
  });
}

test('listen sends a best-effort POST /v1/inbox/cursors after persisting the received cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await baseSessionFiles(stateDir);

  const logFile = join(root, 'cursor-calls.log');
  const preloadPath = join(root, 'mock.mjs');
  await writeFile(preloadPath, `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/inbox/cursors')) {
        appendFileSync('${logFile}', init.method + ' ' + u + ' body=' + (init.body || '') + '\\n');
        return new Response(JSON.stringify({ data: {} }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/inbox/events')) {
        return new Response(JSON.stringify({ data: [{ event_id: 'evt_1', cursor: 'c_received', type: 'message.created' }], page: { next_cursor: 'c_received' } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    };
  `);

  const res = await run(['listen', '--caller-id', 'call_1', '--max-wait-min', '1'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);

  const logs = await readFile(logFile, 'utf8');
  assert.match(logs, /POST https:\/\/mock\.test\/v1\/inbox\/cursors body=\{"cursor":"c_received"\}/);
  await rm(root, { recursive: true, force: true });
});

test('listen ignores a failing inbox-cursor ack and still succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await baseSessionFiles(stateDir);

  const preloadPath = join(root, 'mock.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/inbox/cursors')) {
        return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/inbox/events')) {
        return new Response(JSON.stringify({ data: [{ event_id: 'evt_1', cursor: 'c_received', type: 'message.created' }], page: { next_cursor: 'c_received' } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    };
  `);

  const res = await run(['listen', '--caller-id', 'call_1', '--max-wait-min', '1'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, 'received');
  await rm(root, { recursive: true, force: true });
});

test('listen ends with BUDGET_EXHAUSTED once the local session_minutes budget has elapsed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await baseSessionFiles(stateDir);
  await writeFile(join(stateDir, 'budget.json'), JSON.stringify({ help: 'on', contacts: [], session_minutes: 1 }));
  // Pre-seed the ledger so the session already started well over a minute ago.
  await writeFile(join(stateDir, 'budget-ledger.json'), JSON.stringify({ session_id: 'ses_1', session_started_at: Date.now() - (2 * 60_000) }));

  const preloadPath = join(root, 'mock.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ data: [], page: { next_cursor: 'c0' } }), { headers: { 'content-type': 'application/json' } });
    };
  `);

  const res = await run(['listen', '--caller-id', 'call_1', '--max-wait-min', '1'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 1);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, 'error');
  assert.equal(parsed.error.code, 'BUDGET_EXHAUSTED');
  await rm(root, { recursive: true, force: true });
});

test('listen without a budget.json is unaffected by session_minutes logic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await baseSessionFiles(stateDir);

  const preloadPath = join(root, 'mock.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/inbox/events')) {
        return new Response(JSON.stringify({ data: [{ event_id: 'evt_1', cursor: 'c1', type: 'message.created' }], page: { next_cursor: 'c1' } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    };
  `);

  const res = await run(['listen', '--caller-id', 'call_1', '--max-wait-min', '1'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, 'received');
  await rm(root, { recursive: true, force: true });
});

test('listen traps SIGINT, ends session, clears session state, and exits 130', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'calls', 'call_1', 'session-credential'), 'secret-session-token\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'calls', 'call_1', 'session.json'), JSON.stringify({
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
    env: { ...process.env, OLIMPYX_HOME: join(root, '.olimpyx') },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const closed = new Promise((resolve) => child.once('close', resolve));

  // Allow heartbeat to be sent and wait to start
  await new Promise((r) => setTimeout(r, 300));
  child.kill('SIGINT');

  const status = await closed;
  assert.equal(status, 130);

  const logs = await readFile(logFile, 'utf8');
  assert.match(logs, /POST https:\/\/mock\.test\/v1\/sessions\/ses_1\/heartbeat/);
  assert.match(logs, /POST https:\/\/mock\.test\/v1\/sessions\/ses_1\/end body=\{"reason":"agent_ended"\}/);

  const sessionExists = await stat(join(stateDir, 'calls', 'call_1', 'session.json')).then(() => true).catch(() => false);
  assert.equal(sessionExists, false, 'session.json should be deleted after SIGINT');
  await rm(root, { recursive: true, force: true });
});

test('listen traps SIGTERM, ends session, clears session state, and exits 143', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-listen-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'calls', 'call_1', 'session-credential'), 'secret-session-token\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'calls', 'call_1', 'session.json'), JSON.stringify({
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
    env: { ...process.env, OLIMPYX_HOME: join(root, '.olimpyx') },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const closed = new Promise((resolve) => child.once('close', resolve));
  await new Promise((r) => setTimeout(r, 300));
  child.kill('SIGTERM');

  const status = await closed;
  assert.equal(status, 143);

  const logs = await readFile(logFile, 'utf8');
  assert.match(logs, /POST https:\/\/mock\.test\/v1\/sessions\/ses_1\/heartbeat/);
  assert.match(logs, /POST https:\/\/mock\.test\/v1\/sessions\/ses_1\/end body=\{"reason":"agent_ended"\}/);

  const sessionExists = await stat(join(stateDir, 'calls', 'call_1', 'session.json')).then(() => true).catch(() => false);
  assert.equal(sessionExists, false, 'session.json should be deleted after SIGTERM');
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// `wait` (single-cycle poll): must map typed session-failure codes the same way
// `listen` does (PRD §3.2.5), instead of leaking the raw server error.code/name to
// stderr via the generic top-level error handler.
// ---------------------------------------------------------------------------

test('wait receives inbox events and persists cursor like listen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-wait-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await baseSessionFiles(stateDir);

  const preloadPath = join(root, 'mock.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/inbox/events')) {
        return new Response(JSON.stringify({ data: [{ event_id: 'evt_1', cursor: 'c_received', type: 'message.created' }], page: { next_cursor: 'c_received' } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    };
  `);

  const res = await run(['wait', '--caller-id', 'call_1', '--timeout-ms', '1000'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.data[0].event_id, 'evt_1');

  const session = JSON.parse(await readFile(join(stateDir, 'calls', 'call_1', 'session.json'), 'utf8'));
  assert.equal(session.inbox_cursor, 'c_received');
  await rm(root, { recursive: true, force: true });
});

for (const [heartbeatCode, heartbeatStatus, expectedCliCode] of [
  ['session_stopped', 401, 'STOP_REQUESTED'],
  ['session_superseded', 401, 'SESSION_SUPERSEDED'],
  ['agent_revoked', 401, 'AGENT_REVOKED'],
  ['restricted', 403, 'RESTRICTED'],
  ['session_expired', 401, 'SESSION_EXPIRED']
]) {
  test(`wait maps ${heartbeatCode} (HTTP ${heartbeatStatus}) to ${expectedCliCode} instead of printing the raw server code`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'olimpyx-wait-cli-'));
    const stateDir = join(root, '.olimpyx');
    await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
    await baseSessionFiles(stateDir);

    const preloadPath = join(root, 'mock.mjs');
    await writeFile(preloadPath, `
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/heartbeat')) {
          return new Response(JSON.stringify({ error: { message: 'blocked', code: '${heartbeatCode}' } }), {
            status: ${heartbeatStatus},
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      };
    `);

    const res = await run(['wait', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
    assert.equal(res.status, 1);
    // The bug this guards against: the raw server code/name leaking to stderr via the
    // generic top-level error handler instead of the typed JSON payload on stdout.
    assert.equal(res.stdout.includes(heartbeatCode), false, `raw server code ${heartbeatCode} must not leak to stdout`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.status, 'error');
    assert.equal(parsed.error.code, expectedCliCode);
    await rm(root, { recursive: true, force: true });
  });
}

test('wait keeps ordinary local validation errors (no --caller-id) on the plain stderr path, not the typed JSON payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-wait-cli-'));
  const res = await run(['wait'], { cwd: root });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--caller-id is required/);
  await rm(root, { recursive: true, force: true });
});

// Q-016 review finding: a session tracked only via `wait` (never `listen`) lost all of its
// elapsed time toward session_minutes, because only `listen` touched the budget ledger. `wait`
// must also update the ledger's last-seen tracking for the active session.
test('wait touches the local session_minutes ledger so a wait-only session is not silently lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-wait-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await baseSessionFiles(stateDir);
  await writeFile(join(stateDir, 'budget.json'), JSON.stringify({ help: 'on', contacts: [], session_minutes: 60 }));

  const preloadPath = join(root, 'mock.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/inbox/events')) {
        return new Response(JSON.stringify({ data: [], page: { next_cursor: 'c0' } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    };
  `);

  const res = await run(['wait', '--caller-id', 'call_1', '--timeout-ms', '10'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);

  const ledger = JSON.parse(await readFile(join(stateDir, 'budget-ledger.json'), 'utf8'));
  assert.equal(ledger.session_id, 'ses_1');
  assert.ok(ledger.session_started_at, 'wait must start tracking session_started_at for the active session');
  assert.ok(ledger.last_seen_at, 'wait must record last_seen_at so the session\'s elapsed time is not lost');
  await rm(root, { recursive: true, force: true });
});
