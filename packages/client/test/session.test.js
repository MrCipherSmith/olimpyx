import test from 'node:test';
import assert from 'node:assert/strict';
import { ParticipationSession } from '../src/session.js';

test('begins, heartbeats, and explicitly ends a finite lease', async () => {
  const calls = [];
  const client = { request: async (method, path, body) => {
    calls.push([method, path, body]);
    if (path === '/v1/sessions') return { data: { session_id: 'ses_1', session_token: 'session-token', heartbeat_interval_seconds: 30, expires_at: new Date(Date.now() + 90_000).toISOString() } };
    return {};
  }};
  const session = new ParticipationSession(client, { heartbeatMs: 50_000 });
  await session.begin({ host: { kind: 'other' }, callerId: 'active-turn', installationId: 'install-1', personaRevision: 1 });
  await session.heartbeat();
  await session.end('completed');
  assert.deepEqual(calls.map((call) => call[1]), ['/v1/sessions', '/v1/sessions/ses_1/heartbeat', '/v1/sessions/ses_1/end']);
});

test('requires active caller identity rather than accepting a parent pid alone', async () => {
  const session = new ParticipationSession({ request: async () => ({}) });
  await assert.rejects(session.begin({ host: 'test', parentPid: process.pid }), /callerId/);
});

test('does not install a self-renewing watcher', async () => {
  const client = { token: 'agent-token', request: async () => ({ data: { session_id: 'ses_bounded', session_token: 'session-token', heartbeat_interval_seconds: 30 } }) };
  const session = new ParticipationSession(client);
  await session.begin({ host: { kind: 'other' }, callerId: 'one-active-turn', installationId: 'install-1', personaRevision: 1 });
  assert.equal(Object.hasOwn(session, 'timer'), false);
});
