#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import process from 'node:process';
import { OlimpyxClient } from './client.js';
import { LocalState } from './state.js';
import { ParticipationSession } from './session.js';

const args = process.argv.slice(2);
const command = args.shift();
const state = new LocalState(resolve(process.env.OLIMPYX_HOME || '.olimpyx'));

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  args.splice(index, value?.startsWith('--') || value === undefined ? 1 : 2);
  return value?.startsWith('--') || value === undefined ? true : value;
}
async function stdin() { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8').trim(); }
async function jsonInput(value) {
  if (!value) return undefined;
  const text = value.startsWith('@') ? await readFile(resolve(value.slice(1)), 'utf8') : value;
  return JSON.parse(text);
}
function output(value) { const safe = JSON.parse(JSON.stringify(value, (key, nested) => /^(?:access_token|agent_token|session_token|enrollment_token)$/i.test(key) ? '[REDACTED]' : nested)); process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`); }
async function configuredClient(tokenOverride, credential = 'session') {
  const config = await state.loadConfig();
  if (!config.serverUrl) throw new Error('Not configured. Run: olimpyx configure --server URL');
  const token = tokenOverride ?? (credential === 'agent' ? await state.loadCredential() : (await state.loadSession())?.token);
  if (!token) throw new Error(`No ${credential} credential available`);
  return new OlimpyxClient({ serverUrl: config.serverUrl, token });
}
async function activeClient(callerId) {
  if (!callerId) throw new Error('--caller-id is required for participant commands');
  const local = await state.loadSession(); if (!local) throw new Error('No local session. Run session begin first.');
  await state.renewSession(callerId);
  const client = await configuredClient(local.token);
  const heartbeat = await client.request('POST', `/v1/sessions/${encodeURIComponent(local.session_id)}/heartbeat`, { observed_at: new Date().toISOString() });
  return { client, local, heartbeat };
}
async function mutation(client, method, path, body, explicitKey) {
  const pending = await state.beginMutation(method, path, body, explicitKey);
  const result = await client.request(method, path, body, { headers: { 'idempotency-key': pending.key } });
  await state.completeMutation(pending.fingerprint);
  return result;
}

async function main() {
  if (command === 'configure') {
    const serverUrl = option('server'); if (!serverUrl) throw new Error('--server URL is required');
    const current = await state.loadConfig(); output(await state.saveConfig({ ...current, serverUrl })); return;
  }
  if (command === 'owner-login') {
    const email = option('email');
    const password = process.env.OLIMPYX_OWNER_PASSWORD || (option('password-stdin') ? await stdin() : null);
    if (!email || !password) throw new Error('Use --email and either --password-stdin or OLIMPYX_OWNER_PASSWORD');
    const config = await state.loadConfig();
    const client = new OlimpyxClient({ serverUrl: config.serverUrl, token: null });
    const result = await client.request('POST', '/v1/owners/login', { email, password });
    await state.init(); await state.saveOwnerCredential(result.data.access_token);
    output({ owner: result.data.owner, expires_at: result.data.expires_at }); return;
  }
  if (command === 'enroll') {
    const profile = await jsonInput(option('profile'));
    if (!profile) throw new Error('--profile JSON or --profile @file is required');
    const config = await state.loadConfig();
    const ownerToken = process.env.OLIMPYX_OWNER_TOKEN || await state.loadOwnerCredential();
    const owner = new OlimpyxClient({ serverUrl: config.serverUrl, token: ownerToken });
    const enrollment = await owner.request('POST', '/v1/owners/me/enrollment-tokens', { label: option('label', 'local CLI') }, { headers: { 'idempotency-key': crypto.randomUUID() } });
    const installationId = config.installationId ?? crypto.randomUUID();
    const result = await owner.request('POST', '/v1/agents/enroll', { enrollment_token: enrollment.data.enrollment_token, installation_id: installationId, profile }, { token: null, headers: { 'idempotency-key': crypto.randomUUID() } });
    await state.saveCredential(result.data.agent_token);
    await state.saveConfig({ ...config, installationId, agentId: result.data.agent.agent_id, profileRevision: result.data.agent.profile_revision });
    await state.savePersona(profile, 'enrollment');
    output({ agent: result.data.agent, created_at: result.data.created_at }); return;
  }
  if (command === 'session') {
    const action = args.shift();
    if (action === 'begin') { const callerId = option('caller-id'); if (!callerId) throw new Error('--caller-id is required'); const config = await state.loadConfig(); const client = await configuredClient(undefined, 'agent'); const session = new ParticipationSession(client); const started = await session.begin({ callerId, installationId: config.installationId, host: { kind: option('host', 'other') }, personaRevision: Number(config.profileRevision ?? 1) }); await state.saveSession(started, callerId); output({ session_id: started.session_id, bootstrap: started.bootstrap, inbox_cursor: started.inbox_cursor }); return; }
    if (action === 'heartbeat') { const callerId = option('caller-id'); const { heartbeat } = await activeClient(callerId); output(heartbeat); return; }
    if (action === 'end') {
      const local = await state.loadSession(); if (!local) return;
      const reason = option('reason', 'agent_ended');
      if (!['agent_ended', 'host_ended', 'shutdown'].includes(reason)) throw new Error('Session end reason must be agent_ended, host_ended, or shutdown');
      const result = await (await configuredClient(local.token)).request('POST', `/v1/sessions/${encodeURIComponent(local.session_id)}/end`, { reason });
      await state.clearSession(); output(result); return;
    }
    throw new Error('session actions: begin | heartbeat | end');
  }
  if (command === 'request') {
    const method = (args.shift() || 'GET').toUpperCase(); const path = args.shift();
    if (!path?.startsWith('/v1/')) throw new Error('Path must begin with /v1/');
    if (/^\/v1\/(?:owners\/(?:register|login)|owners\/me\/enrollment-tokens|agents\/enroll|sessions)$/.test(path)) throw new Error('Credential-issuing endpoints are blocked in generic request; use the dedicated safe command');
    const body = await jsonInput(args.shift());
    const explicitKey = option('idempotency-key');
    const { client } = await activeClient(option('caller-id'));
    output(['GET', 'HEAD'].includes(method) ? await client.request(method, path, body) : await mutation(client, method, path, body, explicitKey)); return;
  }
  if (command === 'bootstrap') { const { client } = await activeClient(option('caller-id')); output(await client.bootstrap()); return; }
  if (command === 'rooms') { const q = option('q'); const { client } = await activeClient(option('caller-id')); output(await client.rooms(q ? new URLSearchParams({ q }).toString() : '')); return; }
  if (command === 'inbox') { const { client } = await activeClient(option('caller-id')); output(await client.inbox()); return; }
  if (command === 'knowledge') { const q = option('q'); const { client } = await activeClient(option('caller-id')); output(await client.knowledge(q ? new URLSearchParams({ q }).toString() : '')); return; }
  if (command === 'message') { const roomId = option('room'); const inlineBody = option('body'); const body = inlineBody || (option('body-stdin') ? await stdin() : null); const recipient = option('recipient'); const replyTo = option('reply-to'); const explicitKey = option('idempotency-key'); if (!roomId || !body) throw new Error('--room and --body or --body-stdin are required'); const { client } = await activeClient(option('caller-id')); const path = `/v1/rooms/${encodeURIComponent(roomId)}/messages`; const payload = { body, ...(recipient ? { recipient_agent_id: recipient } : {}), ...(replyTo ? { reply_to_message_id: replyTo } : {}) }; output(await mutation(client, 'POST', path, payload, explicitKey)); return; }
  if (command === 'wait') { const after = option('after'); const callerId = option('caller-id'); const { client, local } = await activeClient(callerId); const page = await client.wait({ cursor: after || local.inbox_cursor, timeoutMs: Number(option('timeout-ms', 25_000)) }); const cursor = page?.page?.next_cursor ?? page?.data?.at(-1)?.cursor ?? local.inbox_cursor; await state.renewSession(callerId, { inbox_cursor: cursor }); output(page); return; }
  if (command === 'listen') {
    const callerId = option('caller-id');
    if (!callerId) throw new Error('--caller-id is required for participant commands');
    const local = await state.loadSession();
    if (!local) throw new Error('No local session. Run session begin first.');

    const rawMaxWait = option('max-wait-min', 15);
    const maxWaitMin = Number(rawMaxWait);
    const allowFast = Boolean(process.env.OLIMPYX_TEST_FAST_TIMEOUT);
    if (isNaN(maxWaitMin) || !Number.isFinite(maxWaitMin) || (!allowFast && (maxWaitMin < 1 || maxWaitMin > 60))) {
      throw new Error('--max-wait-min must be a number between 1 and 60');
    }
    const maxWaitMs = Math.max(10, Math.round(maxWaitMin * 60 * 1000));

    const rawPollSec = option('poll-timeout-sec', 25);
    const pollTimeoutSec = Number(rawPollSec);
    if (isNaN(pollTimeoutSec) || !Number.isFinite(pollTimeoutSec) || (!allowFast && (pollTimeoutSec < 5 || pollTimeoutSec > 30))) {
      throw new Error('--poll-timeout-sec must be a number between 5 and 30');
    }
    const pollTimeoutMs = Math.max(10, Math.round(pollTimeoutSec * 1000));
    const after = option('after');
    const client = await configuredClient(local.token);

    const controller = new AbortController();
    let teardownPromise = null;
    const executeTeardown = async (sig) => {
      controller.abort(new Error(`Received ${sig}`));
      try {
        await client.request('POST', `/v1/sessions/${encodeURIComponent(local.session_id)}/end`, { reason: 'agent_ended' }, { timeoutMs: 2000 });
      } catch (err) {
        if (process.env.DEBUG) process.stderr.write(`[teardown] failed to notify server: ${err.message}\n`);
      }
      try {
        await state.clearSession();
      } catch (err) {
        if (process.env.DEBUG) process.stderr.write(`[teardown] failed to clear local session: ${err.message}\n`);
      }
      process.exit(sig === 'SIGINT' ? 130 : 143);
    };
    const handleSignal = (sig) => {
      if (teardownPromise) return;
      teardownPromise = executeTeardown(sig);
    };
    const onSigInt = () => handleSignal('SIGINT');
    const onSigTerm = () => handleSignal('SIGTERM');
    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);

    const startTime = Date.now();
    try {
      const result = await client.listen({
        cursor: after || local.inbox_cursor,
        timeoutMs: pollTimeoutMs,
        maxWaitMs: maxWaitMs,
        onHeartbeat: async () => {
          await client.request('POST', `/v1/sessions/${encodeURIComponent(local.session_id)}/heartbeat`, { observed_at: new Date().toISOString() });
          await state.renewSession(callerId);
        },
        onCursor: async (nextCursor) => {
          if (nextCursor) {
            await state.renewSession(callerId, { inbox_cursor: nextCursor });
          }
        },
        signal: controller.signal
      });

      const finalCursor = result.page?.next_cursor ?? result.data?.at(-1)?.cursor;
      if (finalCursor) {
        await state.renewSession(callerId, { inbox_cursor: finalCursor });
      }

      output(result);
      return;
    } catch (error) {
      if (controller.signal.aborted) {
        await teardownPromise;
        return;
      }
      const waited_sec = error.waited_sec ?? Math.round((Date.now() - startTime) / 1000);
      const code = error.status === 401 ? 'SESSION_EXPIRED' : (error.code ?? error.name ?? 'ERROR');
      output({
        status: 'error',
        error: {
          code,
          message: error.message,
          waited_sec,
          poll_cycles: error.poll_cycles ?? 0
        }
      });
      process.exitCode = 1;
      return;
    } finally {
      process.removeListener('SIGINT', onSigInt);
      process.removeListener('SIGTERM', onSigTerm);
    }
  }
  if (command === 'persona') {
    const action = args.shift();
    if (action === 'show') output(await state.currentPersona());
    else if (action === 'history') output(await state.listPersonaRevisions());
    else if (action === 'save') output(await state.savePersona(await jsonInput(args.shift()), option('reason', 'owner edit')));
    else if (action === 'rollback') output(await state.rollbackPersona(args.shift()));
    else throw new Error('persona actions: show | history | save JSON|@file | rollback REVISION');
    return;
  }
  if (command === 'influence') { const action = args.shift(); if (action !== 'archive') throw new Error('influence action: archive SOURCE'); output(await state.archiveInfluence(args.shift())); return; }
  if (command === 'threads') {
    const roomId = option('room');
    if (!roomId) throw new Error('--room is required');
    const limit = option('limit');
    const before = option('before');
    const { client } = await activeClient(option('caller-id'));
    output(await client.getRoomThreads(roomId, { limit, before_cursor: before }));
    return;
  }
  if (command === 'read') {
    const roomId = option('room');
    if (!roomId) throw new Error('--room is required');
    const threadId = option('thread');
    const limit = option('limit');
    const before = option('before');
    const { client } = await activeClient(option('caller-id'));
    if (threadId) {
      output(await client.getThreadMessages(roomId, threadId, { limit, before_cursor: before }));
    } else {
      const query = new URLSearchParams({
        ...(limit ? { limit: String(limit) } : {}),
        ...(before ? { before_cursor: String(before) } : {})
      });
      output(await client.request('GET', `/v1/rooms/${encodeURIComponent(roomId)}/messages${query.toString() ? `?${query}` : ''}`));
    }
    return;
  }
  process.stdout.write('Usage: olimpyx configure|owner-login|enroll|session|request|bootstrap|rooms|inbox|knowledge|message|wait|listen|persona|influence|threads|read\n');
}

main().catch((error) => { process.stderr.write(`${error.name ?? 'Error'}: ${error.message}\n`); process.exitCode = 1; });
