// Opt-in live integration check for Q-016 (resource limits, stop behavior, contribution
// counters) against a REAL server, exercising the client/server contract end to end.
// Mirrors the existing live-smoke.js pattern (see test/live-smoke.js): OLIMPYX_URL points
// at an already-running server; this script never starts one itself.
import assert from 'node:assert/strict';
import { OlimpyxClient, OlimpyxHttpError } from '../src/client.js';
import { isOwnTaskRoom } from '../src/budget.js';

const serverUrl = process.env.OLIMPYX_URL;
if (!serverUrl) {
  process.stderr.write('OLIMPYX_URL is required for the opt-in live Q-016 check.\n');
  process.exit(2);
}

const suffix = crypto.randomUUID();
const password = `Live-q016-${crypto.randomUUID()}!`;
const publicClient = new OlimpyxClient({ serverUrl, token: null });
const activeSessions = [];

async function startSession(agentToken, installationId) {
  const client = new OlimpyxClient({ serverUrl, token: agentToken });
  const result = await client.request('POST', '/v1/sessions', { installation_id: installationId, host: { kind: 'other', version: 'live-q016' }, persona_revision: 1 });
  client.token = result.data.session_token;
  activeSessions.push({ client, id: result.data.session_id });
  return { client, session: result.data };
}

async function endSession(active, reason = 'agent_ended') {
  if (!active) return;
  try {
    await active.client.request('POST', `/v1/sessions/${active.session.session_id}/end`, { reason });
  } catch {
    // best-effort
  }
  const index = activeSessions.findIndex((item) => item.id === active.session.session_id);
  if (index >= 0) activeSessions.splice(index, 1);
}

async function enroll(owner, name) {
  const tokenRes = await owner.request('POST', '/v1/owners/me/enrollment-tokens', { label: `live-q016-${name}` });
  const installationId = crypto.randomUUID();
  const result = await publicClient.request('POST', '/v1/agents/enroll', {
    enrollment_token: tokenRes.data.enrollment_token,
    installation_id: installationId,
    profile: { name, role: 'live q016 agent', bio: 'Temporary integration test identity', interests: ['testing'], capabilities: ['messaging'] }
  });
  return { agentId: result.data.agent.agent_id, agentToken: result.data.agent_token, installationId };
}

async function expectHttpError(promise) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OlimpyxHttpError) return error;
    throw error;
  }
  throw new Error('Expected request to fail, but it succeeded');
}

try {
  // --- Owner registers, enrolls an agent, begins a session ---
  const registration = await publicClient.request('POST', '/v1/owners/register', { email: `olimpyx-q016-${suffix}@example.test`, password, display_name: 'Olimpyx Q-016 live check' });
  const login = await publicClient.request('POST', '/v1/owners/login', { email: registration.data.owner.email, password });
  const owner = new OlimpyxClient({ serverUrl, token: login.data.access_token });

  const agent = await enroll(owner, 'agent');
  const active = await startSession(agent.agentToken, agent.installationId);

  const room = await active.client.request('POST', '/v1/rooms', { title: `Live Q-016 ${suffix}`, description: 'Temporary integration test room' });
  const roomId = room.data.room_id;

  // --- limits() returns the effective actions table (PRD §3.1, GET /v1/limits) ---
  const limits = await active.client.limits();
  assert.ok(limits.data.actions.help_thread, 'limits().data.actions.help_thread should exist');
  assert.equal(typeof limits.data.actions.help_thread.agent, 'number');
  assert.equal(typeof limits.data.actions.help_thread.window_sec, 'number');
  assert.ok(limits.data.capacity, 'limits().data.capacity should exist');
  const helpThreadAgentLimit = limits.data.actions.help_thread.agent;

  // --- Exceed the help_thread agent quota: N+1th help thread -> 429 quota_exceeded ---
  for (let i = 0; i < helpThreadAgentLimit; i++) {
    await active.client.createHelpThread({ roomId, body: `Help thread ${i} ${suffix}`, category: 'question', tags: ['q016'] });
  }
  const quotaError = await expectHttpError(active.client.createHelpThread({ roomId, body: `Help thread overflow ${suffix}`, category: 'question', tags: ['q016'] }));
  assert.equal(quotaError.status, 429, `expected 429, got ${quotaError.status}: ${quotaError.message}`);
  assert.equal(quotaError.code, 'quota_exceeded', `expected code quota_exceeded, got ${quotaError.code}`);
  assert.equal(quotaError.details?.action, 'help_thread');
  assert.equal(quotaError.details?.scope, 'agent');
  assert.ok(typeof quotaError.details?.retry_after_sec === 'number', 'details.retry_after_sec should be a number');
  assert.ok(typeof quotaError.retryAfterSec === 'number', 'retryAfterSec (from Retry-After header) should be a number');
  process.stdout.write(`OK: help_thread quota exceeded after ${helpThreadAgentLimit} -> 429 quota_exceeded, retry_after_sec=${quotaError.details.retry_after_sec}\n`);

  // --- Owner stop: agent's next request surfaces STOP_REQUESTED via listen() ---
  await owner.stopAgent(agent.agentId, { reason: 'live q016 stop test' });
  let stopSeen = false;
  try {
    await active.client.listen({ cursor: null, timeoutMs: 2000, maxWaitMs: 4000 });
  } catch (error) {
    assert.ok(error instanceof OlimpyxHttpError, `expected OlimpyxHttpError, got ${error}`);
    assert.equal(error.status, 401, `expected 401 session_stopped, got ${error.status}: ${error.message}`);
    assert.equal(error.code, 'session_stopped');
    stopSeen = true;
  }
  assert.ok(stopSeen, 'expected the stopped session to surface session_stopped on the next listen poll');
  activeSessions.splice(activeSessions.findIndex((item) => item.id === active.session.session_id), 1); // server already ended it
  process.stdout.write('OK: owner stop -> next listen surfaces 401 session_stopped (CLI maps this to STOP_REQUESTED)\n');

  // Agent can start a new session after a stop (not a revoke).
  const restarted = await startSession(agent.agentToken, agent.installationId);
  process.stdout.write('OK: agent can start a new session after owner stop (not revoked)\n');

  // --- Task create -> cancel -> assignee listen returns a TASK_CANCELLED stop hint ---
  const assignee = await enroll(owner, 'assignee');
  const assigneeActive = await startSession(assignee.agentToken, assignee.installationId);
  const taskRoom = await restarted.client.request('POST', '/v1/rooms', { title: `Live Q-016 tasks ${suffix}`, description: 'Task room' });
  const task = await restarted.client.request('POST', `/v1/rooms/${taskRoom.data.room_id}/tasks`, { assigned_agent_id: assignee.agentId, title: 'Do the thing', description: 'For the live check' });
  const taskId = task.data.task_id ?? task.data.id;
  assert.ok(taskId, `expected a task id in ${JSON.stringify(task.data)}`);

  await restarted.client.request('POST', `/v1/tasks/${taskId}/cancel`, {});

  const listenResult = await assigneeActive.client.listen({ cursor: null, timeoutMs: 3000, maxWaitMs: 6000 });
  assert.equal(listenResult.status, 'received', `expected 'received', got ${listenResult.status}`);
  assert.ok(listenResult.stop, `expected a stop hint in listen() result: ${JSON.stringify(listenResult)}`);
  assert.equal(listenResult.stop.code, 'TASK_CANCELLED');
  assert.ok(Array.isArray(listenResult.stop.task_ids) && listenResult.stop.task_ids.includes(taskId), `expected stop.task_ids to include ${taskId}, got ${JSON.stringify(listenResult.stop)}`);
  process.stdout.write('OK: task create -> cancel -> assignee listen() returns TASK_CANCELLED stop hint with matching task_ids\n');

  // --- Task decline works (assignee declines from 'proposed') ---
  const secondTask = await restarted.client.request('POST', `/v1/rooms/${taskRoom.data.room_id}/tasks`, { assigned_agent_id: assignee.agentId, title: 'Decline me', description: 'For the live check' });
  const secondTaskId = secondTask.data.task_id ?? secondTask.data.id;
  const declined = await assigneeActive.client.declineTask(secondTaskId, 'not the right agent for this');
  assert.equal(declined.data.status, 'cancelled', `expected declined task status 'cancelled', got ${JSON.stringify(declined.data)}`);
  process.stdout.write('OK: declineTask() -> task status cancelled\n');

  // --- usage() (owner) and myUsage() (agent) return counters ---
  const ownerUsage = await owner.usage();
  assert.ok(ownerUsage.data.owner, `expected owner usage data, got ${JSON.stringify(ownerUsage.data)}`);
  assert.ok(ownerUsage.data.owner.window, 'expected owner.window usage');
  assert.ok(Array.isArray(ownerUsage.data.agents), 'expected agents array in owner usage');

  const agentUsageRes = await assigneeActive.client.myUsage();
  assert.ok(agentUsageRes.data.window, `expected agent usage window, got ${JSON.stringify(agentUsageRes.data)}`);
  assert.ok(agentUsageRes.data.counters, 'expected agent usage counters');
  process.stdout.write('OK: usage() and myUsage() return window usage and counters\n');

  // --- GET /v1/messages/:id (used by budget.js resolveThreadAuthor) ---
  const rootMsg = await restarted.client.sendMessage(taskRoom.data.room_id, { body: `Root message ${suffix}` });
  const rootMsgId = rootMsg.data.message_id ?? rootMsg.data.id;
  const fetched = await restarted.client.request('GET', `/v1/messages/${rootMsgId}`);
  assert.equal(fetched.data.sender_id, agent.agentId, `expected sender_id ${agent.agentId}, got ${JSON.stringify(fetched.data)}`);
  process.stdout.write('OK: GET /v1/messages/:id returns sender_id (budget.js resolveThreadAuthor contract)\n');

  // --- isOwnTaskRoom() (budget.js) against the real GET /v1/rooms/:roomId/tasks shape,
  // which nests the creator as `creator: { actor_type, actor_id }` (no flat creator_type/
  // creator_id fields) ---
  const thirdTask = await restarted.client.request('POST', `/v1/rooms/${taskRoom.data.room_id}/tasks`, { assigned_agent_id: assignee.agentId, title: 'Still open', description: 'For the live check' });
  assert.ok(thirdTask.data.task_id ?? thirdTask.data.id, `expected a task id in ${JSON.stringify(thirdTask.data)}`);
  const ownByAssignment = await isOwnTaskRoom(assigneeActive.client, taskRoom.data.room_id, { agentId: assignee.agentId });
  assert.equal(ownByAssignment, true, 'isOwnTaskRoom should be true: a fresh non-terminal task in the room is assigned to this agent');

  const bystanderRoom = await restarted.client.request('POST', '/v1/rooms', { title: `Live Q-016 bystander ${suffix}`, description: 'No tasks for the assignee here' });
  const notOwn = await isOwnTaskRoom(assigneeActive.client, bystanderRoom.data.room_id, { agentId: assignee.agentId });
  assert.equal(notOwn, false, 'isOwnTaskRoom should be false for a room with no tasks involving this agent');

  // A third agent under the same owner, used below so the assigned_agent_id branch cannot
  // accidentally make these assertions pass -- only the creator.actor_type/actor_id fields can.
  const bystander = await enroll(owner, 'bystander');

  const ownerCreatedTaskRoom = await restarted.client.request('POST', '/v1/rooms', { title: `Live Q-016 owner task ${suffix}`, description: 'Owner-created task room' });
  // Assigned to `bystander`, not `assignee`: this isolates the creator.actor_type === 'owner'
  // branch (assignee is not the assignee here, so only the creator check can make this true).
  await owner.request('POST', `/v1/rooms/${ownerCreatedTaskRoom.data.room_id}/tasks`, { assigned_agent_id: bystander.agentId, title: 'Owner-created task', description: 'For the live check' }, { headers: { 'idempotency-key': crypto.randomUUID() } });
  const ownByOwnerCreator = await isOwnTaskRoom(assigneeActive.client, ownerCreatedTaskRoom.data.room_id, { agentId: assignee.agentId });
  assert.equal(ownByOwnerCreator, true, 'isOwnTaskRoom should be true (via creator.actor_type===owner) even when this agent is not the assignee');

  const agentCreatedTaskRoom = await restarted.client.request('POST', '/v1/rooms', { title: `Live Q-016 agent-created task ${suffix}`, description: 'Agent-created task room' });
  // `assignee` creates a task assigned to `bystander`: isolates creator.actor_type === 'agent'
  // && creator.actor_id === assignee.agentId (assignee is again not the assignee itself).
  await assigneeActive.client.request('POST', `/v1/rooms/${agentCreatedTaskRoom.data.room_id}/tasks`, { assigned_agent_id: bystander.agentId, title: 'Agent-created task', description: 'For the live check' });
  const ownByAgentCreator = await isOwnTaskRoom(assigneeActive.client, agentCreatedTaskRoom.data.room_id, { agentId: assignee.agentId });
  assert.equal(ownByAgentCreator, true, 'isOwnTaskRoom should be true (via creator.actor_type===agent/actor_id) when this agent created the task itself');
  process.stdout.write('OK: isOwnTaskRoom() correctly reads the real nested creator.actor_type/actor_id shape\n');

  // --- postInboxCursor round-trips ---
  const cursorAck = await assigneeActive.client.postInboxCursor(listenResult.page.next_cursor ?? listenResult.data.at(-1).cursor);
  assert.ok(cursorAck.data.cursor, 'expected postInboxCursor to echo back a cursor');
  process.stdout.write('OK: postInboxCursor() round-trips\n');

  await endSession(restarted);
  await endSession(assigneeActive);

  process.stdout.write('\nLive Q-016 check passed: limits/quota_exceeded contract, owner stop -> STOP_REQUESTED, task cancel -> TASK_CANCELLED stop hint, task decline, usage/myUsage, messages/:id, inbox cursor ack.\n');
} finally {
  await Promise.allSettled(activeSessions.map(({ client, id }) => client.request('POST', `/v1/sessions/${id}/end`, { reason: 'shutdown' }).catch(() => {})));
}
