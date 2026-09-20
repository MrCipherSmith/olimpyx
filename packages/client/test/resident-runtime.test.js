import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResidentStore } from '../src/resident/resident-store.mjs';
import { ResidentRuntime } from '../src/resident/resident-runtime.mjs';

const decision = (actionId, plan = 'explore', payload = { target: 'rooms' }) => ({ actionId, plan, payload, compress: 'Checked one city resource.', nextStep: 'Study memory.' });

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'archi-runtime-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let clock = 1000000;
  const store = new ResidentStore(home);
  const calls = [];
  const transport = {
    initialize: async () => ({ agentId: 'agt_archi', ownerId: 'own_test' }),
    connect: async (callerId) => { calls.push(['connect', callerId]); return { sessionId: 'ses_test', recovered: false }; },
    read: async (path) => {
      calls.push(['read', path]);
      if (path.startsWith('/v1/inbox/events')) return { data: [], page: { next_cursor: null } };
      if (path === '/v1/city-guide') return { data: { revision: 'r1', body: '# Guide' } };
      return { data: [] };
    },
    ack: async (cursor) => { calls.push(['ack', cursor]); },
    reply: async (payload, key) => { calls.push(['reply', payload, key]); return { data: { message_id: 'msg_sent' } }; },
    end: async () => { calls.push(['end']); }
  };
  const runtime = new ResidentRuntime({ store, transport, now: () => clock });
  return { store, transport, runtime, calls, advance: (ms) => { clock += ms; } };
}

test('start/restart preserves identity, deadline, and memory from turn one', async (t) => {
  const f = await fixture(t);
  await f.runtime.run('start');
  const first = await f.store.read();
  await f.runtime.run('act', decision('a1'));
  f.advance(10000);
  await f.runtime.run('start');
  const restored = await f.store.read();
  assert.equal(restored.experimentId, first.experimentId);
  assert.equal(restored.deadlineAt, first.deadlineAt);
  assert.equal(restored.memory.summary, 'Checked one city resource.');
  assert.ok((await f.store.readRecent()).length);
});

test('events are durable before ack and survive a new runtime instance', async (t) => {
  const f = await fixture(t);
  await f.runtime.run('start');
  f.transport.read = async () => ({ data: [{ event_id: 'evt_1', cursor: 'MQ==', type: 'message.created', resource: { kind: 'message', id: 'msg_1' } }], page: { next_cursor: 'MQ==' } });
  f.transport.ack = async () => {
    assert.equal((await f.store.read()).pendingEvents[0].event_id, 'evt_1');
    throw Object.assign(new Error('offline'), { code: 'ECONNRESET' });
  };
  await assert.rejects(f.runtime.run('observe'));
  assert.equal((await f.store.read()).pendingEvents.length, 1);
  const restarted = new ResidentRuntime({ store: f.store, transport: f.transport });
  const status = await restarted.run('status');
  assert.equal(status.pendingEvents[0].event_id, 'evt_1');
});

test('ambiguous reply persists intent and retries the same key without spending twice', async (t) => {
  const f = await fixture(t);
  await f.runtime.run('start');
  const d = decision('reply1', 'reply', { roomId: 'rom_1', replyToMessageId: 'msg_1', body: 'A focused reply.' });
  let firstKey;
  f.transport.reply = async (_payload, key) => { firstKey = key; throw Object.assign(new Error('lost response'), { code: 'ECONNRESET' }); };
  await assert.rejects(f.runtime.run('act', d));
  assert.equal((await f.store.read()).pendingAction.key, firstKey);
  assert.equal((await f.store.read()).messagesSent, 1);
  f.transport.reply = async (_payload, key) => { assert.equal(key, firstKey); return { data: { message_id: 'msg_sent' } }; };
  await f.runtime.run('act', d);
  await f.runtime.run('act', d);
  assert.equal((await f.store.read()).messagesSent, 1);
  assert.equal((await f.store.read()).pendingAction, null);
});

test('no-op has a minimum delay; budget survives resume and terminates the session', async (t) => {
  const f = await fixture(t);
  await f.runtime.run('start');
  await f.runtime.run('act', decision('rest1', 'rest', { reason: 'No relevant events.', revisitAfterSeconds: 300 }));
  await assert.rejects(f.runtime.run('act', decision('again')), /not_due/);
  f.advance(30 * 60 * 1000);
  const ended = await f.runtime.run('observe');
  assert.equal(ended.stopReason, 'time_budget');
  assert.ok(f.calls.some(([name]) => name === 'end'));
  await f.runtime.run('start');
  assert.equal((await f.store.read()).stopReason, 'time_budget');
});

test('terminal auth failure is persisted and never silently reopens participation', async (t) => {
  const f = await fixture(t);
  await f.runtime.run('start');
  f.transport.connect = async () => { throw Object.assign(new Error('stopped'), { code: 'session_stopped', status: 401 }); };
  await assert.rejects(f.runtime.run('observe'));
  assert.equal((await f.store.read()).stopReason, 'session_stopped');
  const status = await f.runtime.run('start');
  assert.equal(status.stopReason, 'session_stopped');
});

test('definitive reply refusals preserve events and allow another decision', async (t) => {
  for (const error of [Object.assign(new Error('rejected'), { code: 'invalid_reply', status: 422 }), Object.assign(new Error('policy'), { code: 'OLIMPYX_HELP_POLICY_BLOCKED' }), Object.assign(new Error('budget'), { code: 'OLIMPYX_BUDGET_EXCEEDED' })]) {
    const f = await fixture(t);
    await f.runtime.run('start');
    const state = await f.store.read();
    state.pendingEvents = [{ event_id: 'evt_waiting' }];
    await f.store.save(state);
    f.transport.reply = async () => { throw error; };
    const result = await f.runtime.run('act', decision('refused', 'reply', { roomId: 'rom_1', replyToMessageId: 'msg_1', body: 'Reply' }));
    assert.equal(result.pendingEventCount, 1);
    assert.equal(result.pendingAction, null);
    assert.equal(result.remainingMessages, 3);
    await f.runtime.run('act', decision('alternative', 'note', { title: 'Observation', body: 'Reply refused.' }));
  }
});

test('invalid decisions are journaled without persisting their raw content', async (t) => {
  const f = await fixture(t);
  await f.runtime.run('start');
  await assert.rejects(f.runtime.run('act', { arbitrary: 'private-invalid-content' }));
  const journal = await f.store.readRecent();
  assert.ok(journal.some((record) => record.type === 'error'));
  assert.ok(!JSON.stringify(journal).includes('private-invalid-content'));
});
