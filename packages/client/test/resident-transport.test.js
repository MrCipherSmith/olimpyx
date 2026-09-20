import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OlimpyxResident } from '../src/resident/olimpyx-resident.mjs';
import { saveBudget } from '../src/budget.js';

const payload = { roomId: 'rom_one', replyToMessageId: 'msg_one', body: 'A useful reply.' };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

async function fixture(t, fetchImpl) {
  const home = await mkdtemp(join(tmpdir(), 'resident-transport-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const transport = new OlimpyxResident(home, { fetchImpl });
  await transport.state.saveConfig({ agentId: 'agt_archi', ownerId: 'own_one', serverUrl: 'https://city.example' });
  await transport.state.saveCredential('test-agent-credential');
  await transport.initialize();
  transport.active = transport.client('test-session-credential');
  return { home, transport };
}

function replyResponse(url, options) {
  const path = new URL(url).pathname;
  if (path === '/v1/messages/msg_one') return response({ data: { room_id: 'rom_one', sender_id: 'agt_other' } });
  if (path.endsWith('/tasks')) return response({ data: [] });
  if (path === '/v1/rooms/rom_one/messages' && options.method === 'POST') return response({ data: { message_id: 'msg_reply' } });
  throw new Error(`Unexpected request ${options.method} ${path}`);
}

test('durable reply receipt bypasses repeat delivery and exhausted budget across restart', async (t) => {
  let posts = 0;
  const { home, transport } = await fixture(t, async (url, options) => {
    if (options.method === 'POST') posts += 1;
    return replyResponse(url, options);
  });
  await saveBudget(home, { messages_per_hour: 1 });
  const result = await transport.reply(payload, 'operation-one');
  const restarted = new OlimpyxResident(home, { fetchImpl: async () => { throw new Error('Receipt replay must not use network'); } });
  await restarted.initialize();
  assert.deepEqual(await restarted.reply(payload, 'operation-one'), result);
  assert.equal(posts, 1);
  const ledger = JSON.parse(await readFile(join(home, 'budget-ledger.json'), 'utf8'));
  assert.equal(ledger.sends.length, 1);
  await assert.rejects(restarted.reply({ ...payload, body: 'Changed body' }, 'operation-one'), { code: 'reply_key_conflict' });
});

test('receipt survives accounting failure and safely accounts on recovery', async (t) => {
  let home;
  const setup = await fixture(t, async (url, options) => {
    const result = replyResponse(url, options);
    if (options.method === 'POST') await writeFile(join(home, 'budget-ledger.json'), '{broken');
    return result;
  });
  home = setup.home;
  await assert.rejects(setup.transport.reply(payload, 'operation-two'), SyntaxError);
  await writeFile(join(home, 'budget-ledger.json'), JSON.stringify({ sends: [] }));
  const restarted = new OlimpyxResident(home, { fetchImpl: async () => { throw new Error('Unexpected retry'); } });
  await restarted.initialize();
  assert.deepEqual(await restarted.reply(payload, 'operation-two'), { data: { message_id: 'msg_reply' } });
  assert.equal(JSON.parse(await readFile(join(home, 'budget-ledger.json'), 'utf8')).sends.length, 1);
});

test('connect reuses a live session instead of starting another', async (t) => {
  const requests = [];
  const { transport } = await fixture(t, async (url) => {
    requests.push(new URL(url).pathname);
    return response({ data: {} });
  });
  await transport.state.saveSession({ session_id: 'ses_existing', session_token: 'test-existing' }, 'caller-one');
  assert.deepEqual(await transport.connect('caller-one'), { sessionId: 'ses_existing', recovered: false });
  assert.deepEqual(requests, ['/v1/sessions/ses_existing/heartbeat']);
});

test('connect does not reopen stopped, superseded or revoked sessions', async (t) => {
  for (const code of ['session_stopped', 'session_superseded', 'agent_revoked', 'restricted']) {
    const requests = [];
    const { transport } = await fixture(t, async (url) => {
      requests.push(new URL(url).pathname);
      return response({ error: { code, message: code } }, 401);
    });
    await transport.state.saveSession({ session_id: 'ses_existing', session_token: 'test-existing' }, 'caller-one');
    await assert.rejects(transport.connect('caller-one'), { code });
    assert.deepEqual(requests, ['/v1/sessions/ses_existing/heartbeat']);
  }
});

test('connect reopens only genuinely expired sessions', async (t) => {
  const requests = [];
  const { transport } = await fixture(t, async (url) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path.endsWith('/heartbeat')) return response({ error: { code: 'session_expired' } }, 401);
    return response({ data: { session_id: 'ses_new', session_token: 'test-new-session' } });
  });
  await transport.state.saveSession({ session_id: 'ses_existing', session_token: 'test-existing' }, 'caller-one');
  assert.deepEqual(await transport.connect('caller-one'), { sessionId: 'ses_new', recovered: true });
  assert.deepEqual(requests, ['/v1/sessions/ses_existing/heartbeat', '/v1/sessions']);
});
