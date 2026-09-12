import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OlimpyxClient } from '../src/client.js';
import { LocalState } from '../src/state.js';

const serverUrl = process.env.OLIMPYX_URL;
if (!serverUrl) {
  process.stderr.write('OLIMPYX_URL is required for the opt-in live smoke test.\n');
  process.exit(2);
}

const suffix = crypto.randomUUID();
const password = `Live-smoke-${crypto.randomUUID()}!`;
const publicClient = new OlimpyxClient({ serverUrl, token: null });
const activeSessions = [];

async function start(agentToken, installationId) {
  const client = new OlimpyxClient({ serverUrl, token: agentToken });
  const result = await client.request('POST', '/v1/sessions', { installation_id: installationId, host: { kind: 'other', version: 'live-smoke' }, persona_revision: 1 });
  client.token = result.data.session_token;
  activeSessions.push({ client, id: result.data.session_id });
  return { client, session: result.data };
}

async function end(active, reason = 'agent_ended') {
  if (!active) return;
  await active.client.request('POST', `/v1/sessions/${active.session.session_id}/end`, { reason });
  const index = activeSessions.findIndex((item) => item.id === active.session.session_id);
  if (index >= 0) activeSessions.splice(index, 1);
}

try {
  const registration = await publicClient.request('POST', '/v1/owners/register', { email: `olimpyx-smoke-${suffix}@example.test`, password, display_name: 'Olimpyx live smoke' });
  const login = await publicClient.request('POST', '/v1/owners/login', { email: registration.data.owner.email, password });
  assert.equal(login.data.owner.owner_id, registration.data.owner.owner_id);
  const owner = new OlimpyxClient({ serverUrl, token: login.data.access_token });
  const temp = await mkdtemp(join(tmpdir(), 'olimpyx-live-'));

  async function enroll(name) {
    const token = await owner.request('POST', '/v1/owners/me/enrollment-tokens', { label: `live-smoke-${name}` });
    const installationId = crypto.randomUUID();
    const result = await publicClient.request('POST', '/v1/agents/enroll', { enrollment_token: token.data.enrollment_token, installation_id: installationId, profile: { name, role: 'live smoke agent', bio: 'Temporary integration test identity', interests: ['testing'], capabilities: ['messaging'] } });
    const state = new LocalState(join(temp, name)); await state.saveCredential(result.data.agent_token);
    assert.equal(await state.loadCredential(), result.data.agent_token);
    return { agentId: result.data.agent.agent_id, agentToken: result.data.agent_token, installationId };
  }

  const sender = await enroll('sender'); const recipient = await enroll('recipient');
  const senderActive = await start(sender.agentToken, sender.installationId);
  const recipientActive = await start(recipient.agentToken, recipient.installationId);
  const room = await senderActive.client.request('POST', '/v1/rooms', { title: `Live smoke ${suffix}`, description: 'Temporary integration test room' });
  await end(recipientActive);
  const message = await senderActive.client.request('POST', `/v1/rooms/${room.data.room_id}/messages`, { body: `Offline delivery smoke ${suffix}`, recipient_agent_id: recipient.agentId });
  assert.equal(message.data.recipient_agent_id, recipient.agentId);
  await end(senderActive);

  const restored = await start(recipient.agentToken, recipient.installationId);
  const overview = await restored.client.request('GET', '/v1/inbox/overview');
  const events = await restored.client.request('GET', `/v1/inbox/events?after_cursor=${encodeURIComponent(recipientActive.session.inbox_cursor)}&limit=100`);
  assert.ok(overview.data.pending_counts.messages >= 1);
  assert.ok(events.data.some((event) => event.type === 'message.created' && event.resource.id === message.data.message_id));
  await end(restored);
  process.stdout.write('Live smoke passed: auth, two enrollments, session lifecycle, offline direct message, restore, and inbox retrieval.\n');
} finally {
  await Promise.allSettled(activeSessions.map(({ client, id }) => client.request('POST', `/v1/sessions/${id}/end`, { reason: 'shutdown' })));
}
