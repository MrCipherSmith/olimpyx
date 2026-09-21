import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
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

test('client SDK listForumThreads formats query parameters correctly', async () => {
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

  const res = await client.listForumThreads({
    tag: 'postgres',
    category: 'question',
    status: 'open',
    roomId: 'rom_123',
    limit: 20,
    cursor: 'msg_cur_1'
  });
  assert.deepEqual(res.data, []);
  assert.equal(
    requestedUrl,
    'https://mock.test/v1/forum/threads?tag=postgres&category=question&status=open&room_id=rom_123&limit=20&cursor=msg_cur_1'
  );
});

test('client SDK createHelpThread formats POST request correctly', async () => {
  let requestedUrl = '';
  let requestedMethod = '';
  let requestedBody = null;

  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      requestedMethod = init.method;
      requestedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: { message_id: 'msg_help_1' } }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const res = await client.createHelpThread({
    roomId: 'rom_abc',
    body: 'How to index jsonb?',
    category: 'question',
    tags: ['postgres', 'indexing']
  });
  assert.equal(res.data.message_id, 'msg_help_1');
  assert.equal(requestedUrl, 'https://mock.test/v1/rooms/rom_abc/messages');
  assert.equal(requestedMethod, 'POST');
  assert.deepEqual(requestedBody, {
    body: 'How to index jsonb?',
    category: 'question',
    tags: ['postgres', 'indexing']
  });
});

test('client SDK setThreadStatus formats PATCH request correctly', async () => {
  let requestedUrl = '';
  let requestedMethod = '';
  let requestedBody = null;

  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      requestedMethod = init.method;
      requestedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: { status: 'resolved' } }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const res = await client.setThreadStatus('rom_abc', 'msg_123', 'resolved');
  assert.equal(res.data.status, 'resolved');
  assert.equal(requestedUrl, 'https://mock.test/v1/rooms/rom_abc/messages/msg_123/status');
  assert.equal(requestedMethod, 'PATCH');
  assert.deepEqual(requestedBody, { status: 'resolved' });
});

test('client SDK subscriptions methods format GET, PUT, DELETE correctly', async () => {
  const calls = [];
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ data: {} }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await client.getAgentSubscriptions();
  await client.setAgentSubscriptions(['postgres', 'raft']);
  await client.deleteAgentSubscription('postgres');

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://mock.test/v1/agents/me/subscriptions');
  assert.equal(calls[0].method, 'GET');

  assert.equal(calls[1].url, 'https://mock.test/v1/agents/me/subscriptions');
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual(calls[1].body, { tags: ['postgres', 'raft'] });

  assert.equal(calls[2].url, 'https://mock.test/v1/agents/me/subscriptions/postgres');
  assert.equal(calls[2].method, 'DELETE');
});

test('client SDK getRecommendations formats GET request with kind=threads correctly', async () => {
  let requestedUrl = '';
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ data: [] }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const res = await client.getRecommendations({ limit: 5 });
  assert.deepEqual(res.data, []);
  assert.equal(requestedUrl, 'https://mock.test/v1/recommendations?kind=threads&limit=5');
});

test('CLI forum commands: list, ask, resolve and secret redaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-forum-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(stateDir, 'calls', 'call_1'), { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'calls', 'call_1', 'session-credential'), 'secret_token_123\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'calls', 'call_1', 'session.json'), JSON.stringify({
    session_id: 'ses_forum_1',
    token: 'secret_token_123',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString()
  }));

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method || 'GET';
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { ok: true } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/v1/forum/threads')) {
        return new Response(JSON.stringify({
          data: [
            {
              thread_id: 'msg_01J8Y30B1C4',
              category: 'question',
              status: 'open',
              reply_count: 3,
              tags: ['postgres', 'indexing'],
              author: { name: 'DBArchitect' },
              body: 'How should we structure GIN indexes on jsonb arrays?'
            }
          ],
          page: { next_cursor: null }
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/v1/rooms/') && m === 'POST') {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({
          data: {
            message_id: 'msg_created_1',
            room_id: 'rom_123',
            category: body.category,
            tags: body.tags,
            status: 'open',
            body: body.body
          }
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/status') && m === 'PATCH') {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({
          data: {
            message_id: 'msg_created_1',
            status: body.status,
            resolved_at: new Date().toISOString()
          }
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
  `);

  // 1. forum list tabular output
  const listRes = await run(['forum', 'list', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(listRes.status, 0);
  assert.match(listRes.stdout, /ID\s+CATEGORY\s+STATUS\s+REPLIES/);
  assert.match(listRes.stdout, /msg_01J8Y30B1C4/);
  assert.match(listRes.stdout, /DBArchitect/);
  assert.equal(listRes.stdout.includes('secret_token_123'), false, "Credentials must be redacted");

  // 2. forum list --json output
  const listJson = await run(['forum', 'list', '--caller-id', 'call_1', '--json'], { cwd: root, preload: preloadPath });
  assert.equal(listJson.status, 0);
  const parsed = JSON.parse(listJson.stdout);
  assert.equal(parsed.data[0].thread_id, 'msg_01J8Y30B1C4');

  // 3. forum ask
  const askRes = await run([
    'forum', 'ask',
    '--room', 'rom_123',
    '--body', 'Need help with indexing',
    '--category', 'question',
    '--tags', 'postgres,indexing',
    '--caller-id', 'call_1'
  ], { cwd: root, preload: preloadPath });
  assert.equal(askRes.status, 0);
  assert.match(askRes.stdout, /Thread created: msg_created_1/);

  // 4. forum resolve
  const resolveRes = await run([
    'forum', 'resolve',
    '--room', 'rom_123',
    '--message', 'msg_created_1',
    '--caller-id', 'call_1'
  ], { cwd: root, preload: preloadPath });
  assert.equal(resolveRes.status, 0);
  assert.match(resolveRes.stdout, /Thread msg_created_1 status updated to resolved/);
});

test('CLI subscribe and recommendations commands format outputs and redact credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-subs-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(stateDir, 'calls', 'call_2'), { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'calls', 'call_2', 'session-credential'), 'secret_token_456\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'calls', 'call_2', 'session.json'), JSON.stringify({
    session_id: 'ses_sub_1',
    token: 'secret_token_456',
    caller_id: 'call_2',
    caller_deadline: new Date(Date.now() + 60000).toISOString()
  }));

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method || 'GET';
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { ok: true } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/v1/agents/me/subscriptions')) {
        if (m === 'GET') {
          return new Response(JSON.stringify({ data: { agent_id: 'agt_1', tags: ['postgres', 'raft'] } }), { headers: { 'content-type': 'application/json' } });
        }
        if (m === 'PUT') {
          const body = JSON.parse(init.body);
          return new Response(JSON.stringify({ data: { agent_id: 'agt_1', tags: body.tags } }), { headers: { 'content-type': 'application/json' } });
        }
        if (m === 'DELETE') {
          const tag = u.split('/').pop();
          return new Response(JSON.stringify({ data: { removed: true, tag } }), { headers: { 'content-type': 'application/json' } });
        }
      }
      if (u.includes('/v1/recommendations')) {
        return new Response(JSON.stringify({
          data: [
            {
              kind: 'thread',
              thread_id: 'msg_rec_1',
              room_id: 'rom_rec',
              author: { name: 'DBArchitect' },
              category: 'question',
              tags: ['postgres', 'indexing'],
              score: 7.42,
              reply_count: 0,
              match_reasons: ['Subscribed tag match: postgres (+3.0)', 'Unanswered inquiry bonus (+2.0)']
            }
          ]
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
  `);

  // 1. subscribe --list
  const listSubs = await run(['subscribe', '--list', '--caller-id', 'call_2'], { cwd: root, preload: preloadPath });
  assert.equal(listSubs.status, 0);
  assert.match(listSubs.stdout, /Subscribed tags: postgres, raft/);

  // 2. subscribe --tags
  const updateSubs = await run(['subscribe', '--tags', 'raft,vector-search', '--caller-id', 'call_2'], { cwd: root, preload: preloadPath });
  assert.equal(updateSubs.status, 0);
  assert.match(updateSubs.stdout, /Subscriptions updated: raft, vector-search/);

  // 3. subscribe --remove
  const removeSub = await run(['subscribe', '--remove', 'raft', '--caller-id', 'call_2'], { cwd: root, preload: preloadPath });
  assert.equal(removeSub.status, 0);
  assert.match(removeSub.stdout, /Subscription removed: raft/);

  // 4. recommendations table output
  const recsTable = await run(['recommendations', '--limit', '5', '--caller-id', 'call_2'], { cwd: root, preload: preloadPath });
  assert.equal(recsTable.status, 0);
  assert.match(recsTable.stdout, /SCORE\s+CATEGORY\s+REPLIES/);
  assert.match(recsTable.stdout, /7.42/);
  assert.match(recsTable.stdout, /DBArchitect/);
  assert.equal(recsTable.stdout.includes('secret_token_456'), false, "Credentials must be redacted in output");

  // 5. recommendations --json output
  const recsJson = await run(['recommendations', '--limit', '5', '--caller-id', 'call_2', '--json'], { cwd: root, preload: preloadPath });
  assert.equal(recsJson.status, 0);
  const parsedRecs = JSON.parse(recsJson.stdout);
  assert.equal(parsedRecs.data[0].thread_id, 'msg_rec_1');
  assert.equal(parsedRecs.data[0].score, 7.42);
});
