import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadBudget,
  saveBudget,
  checkMessagesPerHour,
  recordSend,
  isOwnTaskRoom,
  resolveThreadAuthor,
  evaluateHelpPolicy,
  enforceSendBudget,
  checkSessionBudget,
  OlimpyxBudgetExceededError,
  OlimpyxHelpPolicyBlockedError
} from '../src/budget.js';

async function tempRoot(prefix = 'olimpyx-budget-') {
  return mkdtemp(join(tmpdir(), prefix));
}

test('loadBudget returns null when budget.json does not exist', async () => {
  const root = await tempRoot();
  assert.equal(await loadBudget(root), null);
  await rm(root, { recursive: true, force: true });
});

test('loadBudget normalizes an invalid help value to "on"', async () => {
  const root = await tempRoot();
  await writeFile(join(root, 'budget.json'), JSON.stringify({ help: 'bogus', contacts: ['agt_1'] }));
  const budget = await loadBudget(root);
  assert.equal(budget.help, 'on');
  assert.deepEqual(budget.contacts, ['agt_1']);
  await rm(root, { recursive: true, force: true });
});

test('saveBudget merges a partial patch onto an existing budget', async () => {
  const root = await tempRoot();
  await saveBudget(root, { help: 'contacts', contacts: ['agt_1'], messages_per_hour: 10 });
  const updated = await saveBudget(root, { session_minutes: 60 });
  assert.equal(updated.help, 'contacts');
  assert.deepEqual(updated.contacts, ['agt_1']);
  assert.equal(updated.messages_per_hour, 10);
  assert.equal(updated.session_minutes, 60);
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// messages_per_hour
// ---------------------------------------------------------------------------

test('checkMessagesPerHour is a no-op without a budget.json', async () => {
  const root = await tempRoot();
  await assert.doesNotReject(checkMessagesPerHour(root));
  await rm(root, { recursive: true, force: true });
});

test('checkMessagesPerHour throws OlimpyxBudgetExceededError once the hourly limit is reached, with limit and reset time', async () => {
  const root = await tempRoot();
  await saveBudget(root, { messages_per_hour: 2 });
  const now = Date.now();
  await recordSend(root, { now: now - 1000 });
  await recordSend(root, { now });
  await assert.rejects(checkMessagesPerHour(root, { now }), (err) => {
    assert.ok(err instanceof OlimpyxBudgetExceededError);
    assert.equal(err.code, 'OLIMPYX_BUDGET_EXCEEDED');
    assert.equal(err.limit, 2);
    assert.ok(err.resetAt);
    return true;
  });
  await rm(root, { recursive: true, force: true });
});

test('checkMessagesPerHour ignores sends older than the sliding one-hour window', async () => {
  const root = await tempRoot();
  await saveBudget(root, { messages_per_hour: 1 });
  const now = Date.now();
  await recordSend(root, { now: now - (61 * 60 * 1000) });
  await assert.doesNotReject(checkMessagesPerHour(root, { now }));
  await rm(root, { recursive: true, force: true });
});

test('checkMessagesPerHour makes no network call (enforceSendBudget refuses before touching the client)', async () => {
  const root = await tempRoot();
  await saveBudget(root, { messages_per_hour: 1, help: 'off' });
  const now = Date.now();
  await recordSend(root, { now });
  let called = false;
  const client = { request: async () => { called = true; return { data: [] }; } };
  await assert.rejects(
    enforceSendBudget(client, root, { agentId: 'agt_me', kind: 'reply', roomId: 'rom_1', replyToMessageId: 'msg_1' }, { now }),
    (err) => err instanceof OlimpyxBudgetExceededError
  );
  assert.equal(called, false, 'no network call should be made when messages_per_hour is exceeded');
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// own task rooms / thread author
// ---------------------------------------------------------------------------

test('isOwnTaskRoom is true when a non-terminal task in the room is assigned to this agent', async () => {
  const client = {
    request: async (method, path) => {
      assert.equal(method, 'GET');
      assert.equal(path, '/v1/rooms/rom_1/tasks');
      // Real shape from GET /v1/rooms/:roomId/tasks (apps/server/src/app.ts taskFrom): the
      // creator is nested as `creator: { actor_type, actor_id }`, with no flat duplicates.
      return { data: [{ status: 'in_progress', assigned_agent_id: 'agt_me', creator: { actor_type: 'agent', actor_id: 'agt_other' } }] };
    }
  };
  assert.equal(await isOwnTaskRoom(client, 'rom_1', { agentId: 'agt_me' }), true);
});

test('isOwnTaskRoom is true when a non-terminal task was created by the owner (real nested creator shape)', async () => {
  const client = { request: async () => ({ data: [{ status: 'proposed', assigned_agent_id: 'agt_other', creator: { actor_type: 'owner', actor_id: 'own_1' } }] }) };
  assert.equal(await isOwnTaskRoom(client, 'rom_1', { agentId: 'agt_me' }), true);
});

test('isOwnTaskRoom is true when a non-terminal task was created by this agent itself (real nested creator shape)', async () => {
  const client = { request: async () => ({ data: [{ status: 'accepted', assigned_agent_id: 'agt_other', creator: { actor_type: 'agent', actor_id: 'agt_me' } }] }) };
  assert.equal(await isOwnTaskRoom(client, 'rom_1', { agentId: 'agt_me' }), true);
});

test('isOwnTaskRoom is false when the only matching task is terminal', async () => {
  const client = { request: async () => ({ data: [{ status: 'completed', assigned_agent_id: 'agt_me', creator: { actor_type: 'agent', actor_id: 'agt_me' } }] }) };
  assert.equal(await isOwnTaskRoom(client, 'rom_1', { agentId: 'agt_me' }), false);
});

test('isOwnTaskRoom fails safe to false on a network error', async () => {
  const client = { request: async () => { throw new Error('network down'); } };
  assert.equal(await isOwnTaskRoom(client, 'rom_1', { agentId: 'agt_me' }), false);
});

test('resolveThreadAuthor reads the root message sender via GET /v1/messages/:id', async () => {
  const client = {
    request: async (method, path) => {
      assert.equal(method, 'GET');
      assert.equal(path, '/v1/messages/msg_root');
      return { data: { message_id: 'msg_root', sender_id: 'agt_author' } };
    }
  };
  assert.equal(await resolveThreadAuthor(client, 'msg_root'), 'agt_author');
});

test('resolveThreadAuthor returns null on a network error', async () => {
  const client = { request: async () => { throw new Error('gone'); } };
  assert.equal(await resolveThreadAuthor(client, 'msg_root'), null);
});

// ---------------------------------------------------------------------------
// help policy
// ---------------------------------------------------------------------------

test('evaluateHelpPolicy allows everything when help is "on"', () => {
  const verdict = evaluateHelpPolicy({ help: 'on', contacts: [] }, { kind: 'reply', targetAgentId: 'agt_stranger' });
  assert.equal(verdict.allowed, true);
});

test('evaluateHelpPolicy allows activity inside the owner\'s own task room regardless of mode', () => {
  const verdict = evaluateHelpPolicy({ help: 'off', contacts: [] }, { kind: 'reply', targetAgentId: 'agt_stranger', isOwnTaskRoom: true });
  assert.equal(verdict.allowed, true);
});

test('evaluateHelpPolicy with help:off blocks a reply to a non-contact', () => {
  const verdict = evaluateHelpPolicy({ help: 'off', contacts: ['agt_friend'] }, { kind: 'reply', targetAgentId: 'agt_stranger' });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /replies/);
});

test('evaluateHelpPolicy with help:off blocks a direct message to a non-contact', () => {
  const verdict = evaluateHelpPolicy({ help: 'off', contacts: ['agt_friend'] }, { kind: 'direct_message', targetAgentId: 'agt_stranger' });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /direct messages/);
});

test('evaluateHelpPolicy with help:off allows a direct message to a contact', () => {
  const verdict = evaluateHelpPolicy({ help: 'off', contacts: ['agt_friend'] }, { kind: 'direct_message', targetAgentId: 'agt_friend' });
  assert.equal(verdict.allowed, true);
});

test('evaluateHelpPolicy with help:off blocks a new forum (help-seeking) post', () => {
  const verdict = evaluateHelpPolicy({ help: 'off', contacts: [] }, { kind: 'forum_post' });
  assert.equal(verdict.allowed, false);
});

test('evaluateHelpPolicy with help:contacts allows a forum post but still gates replies/DMs by contact', () => {
  assert.equal(evaluateHelpPolicy({ help: 'contacts', contacts: [] }, { kind: 'forum_post' }).allowed, true);
  assert.equal(evaluateHelpPolicy({ help: 'contacts', contacts: [] }, { kind: 'reply', targetAgentId: 'agt_stranger' }).allowed, false);
  assert.equal(evaluateHelpPolicy({ help: 'contacts', contacts: ['agt_friend'] }, { kind: 'reply', targetAgentId: 'agt_friend' }).allowed, true);
});

// ---------------------------------------------------------------------------
// enforceSendBudget (orchestration)
// ---------------------------------------------------------------------------

test('enforceSendBudget is a full no-op without a budget.json', async () => {
  const root = await tempRoot();
  let called = false;
  const client = { request: async () => { called = true; return { data: [] }; } };
  const result = await enforceSendBudget(client, root, { agentId: 'agt_me', kind: 'reply', roomId: 'rom_1', replyToMessageId: 'msg_1' });
  assert.equal(result.budget, null);
  assert.equal(called, false, 'no own-task-room lookup should happen without a budget.json');
  await rm(root, { recursive: true, force: true });
});

test('enforceSendBudget allows a reply inside the owner\'s own task room even under help:off', async () => {
  const root = await tempRoot();
  await saveBudget(root, { help: 'off', contacts: [] });
  const client = { request: async () => ({ data: [{ status: 'in_progress', assigned_agent_id: 'agt_me', creator: { actor_type: 'agent', actor_id: 'agt_me' } }] }) };
  await assert.doesNotReject(enforceSendBudget(client, root, { agentId: 'agt_me', kind: 'reply', roomId: 'rom_1', replyToMessageId: 'msg_1' }));
  await rm(root, { recursive: true, force: true });
});

test('enforceSendBudget blocks a reply outside the owner\'s own task room under help:off, resolving the thread author first', async () => {
  const root = await tempRoot();
  await saveBudget(root, { help: 'off', contacts: [] });
  const calls = [];
  const client = {
    request: async (method, path) => {
      calls.push(path);
      if (path.endsWith('/tasks')) return { data: [] };
      if (path.startsWith('/v1/messages/')) return { data: { sender_id: 'agt_stranger' } };
      throw new Error(`unexpected path ${path}`);
    }
  };
  await assert.rejects(
    enforceSendBudget(client, root, { agentId: 'agt_me', kind: 'reply', roomId: 'rom_1', replyToMessageId: 'msg_1' }),
    (err) => err instanceof OlimpyxHelpPolicyBlockedError
  );
  assert.ok(calls.some((p) => p === '/v1/messages/msg_1'), 'should resolve the thread author to check the contact list');
  await rm(root, { recursive: true, force: true });
});

test('enforceSendBudget never gates a plain room message by help mode', async () => {
  const root = await tempRoot();
  await saveBudget(root, { help: 'off', contacts: [] });
  let called = false;
  const client = { request: async () => { called = true; return { data: [] }; } };
  await assert.doesNotReject(enforceSendBudget(client, root, { agentId: 'agt_me', kind: 'message', roomId: 'rom_1' }));
  assert.equal(called, false, 'a plain message is not a help-seeking action and needs no lookup');
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// session_minutes
// ---------------------------------------------------------------------------

test('checkSessionBudget reports not exhausted without a budget.json', async () => {
  const root = await tempRoot();
  const result = await checkSessionBudget(root, 'ses_1');
  assert.equal(result.exhausted, false);
  await rm(root, { recursive: true, force: true });
});

test('checkSessionBudget tracks elapsed minutes since first observed and reports exhausted past the limit', async () => {
  const root = await tempRoot();
  await saveBudget(root, { session_minutes: 10 });
  const start = Date.now();
  const first = await checkSessionBudget(root, 'ses_1', { now: start });
  assert.equal(first.exhausted, false);
  const later = await checkSessionBudget(root, 'ses_1', { now: start + 11 * 60_000 });
  assert.equal(later.exhausted, true);
  await rm(root, { recursive: true, force: true });
});

test('checkSessionBudget resets the clock when the session id changes', async () => {
  const root = await tempRoot();
  await saveBudget(root, { session_minutes: 10 });
  const start = Date.now();
  await checkSessionBudget(root, 'ses_1', { now: start });
  const afterExpiry = await checkSessionBudget(root, 'ses_1', { now: start + 11 * 60_000 });
  assert.equal(afterExpiry.exhausted, true);
  const freshSession = await checkSessionBudget(root, 'ses_2', { now: start + 11 * 60_000 });
  assert.equal(freshSession.exhausted, false);
  await rm(root, { recursive: true, force: true });
});
