import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { OlimpyxClient } from '../src/client.js';

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

test('client SDK getRoomThreads formats query parameters correctly', async () => {
  let requestedUrl = '';
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const res = await client.getRoomThreads('rom_123', { limit: 10, before_cursor: 'msg_99' });
  assert.deepEqual(res.data, []);
  assert.equal(requestedUrl, 'https://mock.test/v1/rooms/rom_123/messages?root_only=true&limit=10&before_cursor=msg_99');
});

test('client SDK getRoomMessages formats query parameters correctly', async () => {
  let requestedUrl = '';
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const res = await client.getRoomMessages('rom_123', { limit: 20, before_cursor: 'msg_50' });
  assert.deepEqual(res.data, []);
  assert.equal(requestedUrl, 'https://mock.test/v1/rooms/rom_123/messages?limit=20&before_cursor=msg_50');
});

test('client SDK getThreadMessages formats query parameters correctly and accepts after_cursor', async () => {
  let requestedUrl = '';
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const res = await client.getThreadMessages('rom_123', 'msg_root_1', { limit: 25, after_cursor: 'msg_reply_1' });
  assert.deepEqual(res.data, []);
  assert.equal(requestedUrl, 'https://mock.test/v1/rooms/rom_123/messages?thread_id=msg_root_1&limit=25&before_cursor=msg_reply_1');
});

test('CLI threads command requires --room and queries root messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-threads-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'calls', 'call_1', 'session-credential'), 'secret\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'calls', 'call_1', 'session.json'), JSON.stringify({
    session_id: 'ses_1',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString()
  }));

  // Missing --room
  const missingRoom = await run(['threads', '--caller-id', 'call_1'], { cwd: root });
  assert.equal(missingRoom.status, 1);
  assert.match(missingRoom.stderr, /--room is required/);

  // Success with mock fetch
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('root_only=true')) {
        return new Response(JSON.stringify({
          data: [
            {
              message_id: 'msg_root_1',
              room_id: 'rom_1',
              sender: { actor_type: 'agent', actor_id: 'agt_1', display_name: 'Ada' },
              reply_to_message_id: null,
              root_message_id: null,
              reply_count: 3,
              last_reply_at: '2026-09-17T22:00:00.000Z',
              body: 'Thread root topic',
              created_at: '2026-09-17T21:00:00.000Z'
            }
          ],
          page: { next_cursor: null }
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
  `);

  const res = await run(['threads', '--room', 'rom_1', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.data.length, 1);
  assert.equal(parsed.data[0].message_id, 'msg_root_1');
  assert.equal(parsed.data[0].reply_count, 3);

  await rm(root, { recursive: true, force: true });
});

test('CLI read command supports --room and --thread options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-read-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'calls', 'call_1', 'session-credential'), 'secret\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'calls', 'call_1', 'session.json'), JSON.stringify({
    session_id: 'ses_1',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString()
  }));

  // Missing --room
  const missingRoom = await run(['read', '--caller-id', 'call_1'], { cwd: root });
  assert.equal(missingRoom.status, 1);
  assert.match(missingRoom.stderr, /--room is required/);

  // Success with mock fetch
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('thread_id=msg_root_1')) {
        return new Response(JSON.stringify({
          data: [
            { message_id: 'msg_root_1', root_message_id: null, body: 'Root' },
            { message_id: 'msg_reply_1', root_message_id: 'msg_root_1', body: 'Reply 1' }
          ],
          page: { next_cursor: null }
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { headers: { 'content-type': 'application/json' } });
    };
  `);

  const res = await run(['read', '--room', 'rom_1', '--thread', 'msg_root_1', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.data.length, 2);
  assert.equal(parsed.data[0].message_id, 'msg_root_1');
  assert.equal(parsed.data[1].message_id, 'msg_reply_1');

  // Also verify --after flag works as cursor alias
  const afterRes = await run(['read', '--room', 'rom_1', '--thread', 'msg_root_1', '--after', 'msg_root_1', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(afterRes.status, 0, afterRes.stderr);

  await rm(root, { recursive: true, force: true });
});

test('CLI message command sends --reply-to in payload and handles nonexistent parent error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-reply-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'calls', 'call_1', 'session-credential'), 'secret\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'calls', 'call_1', 'session.json'), JSON.stringify({
    session_id: 'ses_1',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString()
  }));

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (opts?.method === 'POST' && u.includes('/messages')) {
        const body = JSON.parse(opts.body);
        if (body.reply_to_message_id === 'msg_missing') {
          return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Parent message not found' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({
          data: {
            message_id: 'msg_new_1',
            room_id: 'rom_1',
            reply_to_message_id: body.reply_to_message_id,
            root_message_id: body.reply_to_message_id,
            body: body.body
          }
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
  `);

  // Success with reply-to
  const okRes = await run(['message', '--room', 'rom_1', '--body', 'Thread reply text', '--reply-to', 'msg_root_1', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(okRes.status, 0, okRes.stderr);
  const okParsed = JSON.parse(okRes.stdout);
  assert.equal(okParsed.data.reply_to_message_id, 'msg_root_1');

  // Error case (Test 12b): Nonexistent parent returns status 1
  const errRes = await run(['message', '--room', 'rom_1', '--body', 'Orphan reply', '--reply-to', 'msg_missing', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(errRes.status, 1);
  assert.match(errRes.stderr, /Parent message not found/);

  await rm(root, { recursive: true, force: true });
});
