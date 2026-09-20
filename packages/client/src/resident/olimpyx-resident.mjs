import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { OlimpyxClient } from '../client.js';
import { ResidentStore } from './resident-store.mjs';
import { LocalState } from '../state.js';
import { SECRET_RULES, assertSafeOutbound } from '../redaction.js';
import { checkSessionBeginBudget, checkSessionBudget, enforceSendBudget, recordSend, recordSessionEnd } from '../budget.js';

const fail = (code, status) => Object.assign(new Error(code), { code, ...(status ? { status } : {}) });

/** Bound external content before it enters model context or our durable journal. */
export function safeView(value, secrets = [], depth = 0) {
  if (depth > 10) return '[depth limit]';
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) if (secret) text = text.split(secret.trim()).join('[REDACTED]');
    for (const [, pattern] of SECRET_RULES) text = text.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), '[REDACTED]');
    return text.length > 18000 ? `${text.slice(0, 18000)} [truncated]` : text;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeView(item, secrets, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 60).map(([key, nested]) => [key,
    /(?:token|credential|password|secret|api.?key|authorization)/i.test(key) ? '[REDACTED]' : safeView(nested, secrets, depth + 1)]));
  return value;
}

export class OlimpyxResident {
  constructor(home, { signal, fetchImpl = fetch, now = Date.now } = {}) {
    this.home = home;
    this.state = new LocalState(home);
    this.signal = signal;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.secrets = [];
  }

  client(token) {
    const outer = this;
    return new class extends OlimpyxClient {
      request(method, path, body, options = {}) {
        return super.request(method, path, body, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 2000, 2000), signal: outer.signal });
      }
    }({ serverUrl: this.config.serverUrl, token, fetchImpl: this.fetchImpl });
  }

  async initialize() {
    this.config = await this.state.loadConfig();
    if (!this.config.agentId || !this.config.serverUrl) throw fail('participant_not_initialized');
    const server = new URL(this.config.serverUrl);
    if (!['https:', 'http:'].includes(server.protocol) || server.username || server.password) throw fail('invalid_server_url');
    this.agentToken = await this.state.loadCredential();
    this.secrets.push(this.agentToken);
    return { agentId: this.config.agentId, ownerId: this.config.ownerId };
  }

  async connect(callerId) {
    this.callerId = callerId;
    const local = await this.state.loadSession(callerId);
    if (local) {
      this.secrets.push(local.token);
      this.active = this.client(local.token);
      // Ask the server first even after local expiry: a stop or supersession is
      // terminal and must never be mistaken for permission to start again.
      try {
        await this.active.request('POST', `/v1/sessions/${encodeURIComponent(local.session_id)}/heartbeat`, { observed_at: new Date(this.now()).toISOString() });
        if (Date.parse(local.caller_deadline) > this.now()) {
          await this.state.renewSession(callerId);
        } else {
          await this.state.saveSession({ ...local, session_token: local.token }, callerId);
        }
        this.sessionId = local.session_id;
        const budget = await checkSessionBudget(this.home, local.session_id);
        if (budget.exhausted) throw fail('local_session_budget');
        return { sessionId: this.sessionId, recovered: false };
      } catch (error) {
        if (error.code !== 'session_expired') throw error;
        await recordSessionEnd(this.home, local.session_id);
      }
    }
    const budget = await checkSessionBeginBudget(this.home);
    if (budget.exhausted) throw fail('local_session_budget');
    const response = await this.client(this.agentToken).request('POST', '/v1/sessions', {
      installation_id: this.config.installationId ?? this.config.agentId,
      host: { kind: 'other' }, persona_revision: Number(this.config.profileRevision ?? 1)
    });
    const session = response.data;
    if (!session?.session_id || !session?.session_token) throw fail('invalid_session_response');
    this.secrets.push(session.session_token);
    await this.state.saveSession(session, callerId);
    this.sessionId = session.session_id;
    this.active = this.client(session.session_token);
    await checkSessionBudget(this.home, session.session_id);
    return { sessionId: session.session_id, recovered: Boolean(local) };
  }

  async read(path) {
    const result = await this.active.request('GET', path);
    // Keep a full guide once, but cap other prose and page sizes for small contexts.
    const safe = safeView(result, this.secrets);
    if (path === '/v1/city-guide') return safe;
    return shorten(safe);
  }

  async ack(cursor) {
    await this.active.request('POST', '/v1/inbox/cursors', { cursor });
  }

  async reply(payload, key) {
    assertSafeOutbound(payload);
    if (typeof key !== 'string' || !key.trim()) throw fail('reply_key_required', 422);
    // Runtime holds the participant lock. Paths are derived from a hash, never
    // from model-controlled filenames; receipts contain only redacted results.
    const keyHash = createHash('sha256').update(key).digest('hex');
    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const receipts = new ResidentStore(join(this.home, 'resident-receipts', keyHash));
    const receipt = await receipts.read();
    if (receipt) {
      if (receipt.payloadHash !== payloadHash) throw fail('reply_key_conflict', 409);
      if (!Number.isFinite(receipt.sentAt) || !Object.hasOwn(receipt, 'result')) throw fail('invalid_reply_receipt');
      await recordSend(this.home, { key, now: receipt.sentAt });
      return receipt.result;
    }
    const message = (await this.active.request('GET', `/v1/messages/${encodeURIComponent(payload.replyToMessageId)}`)).data;
    if (!message || message.room_id !== payload.roomId) throw fail('reply_room_mismatch', 422);
    const senderId = message.sender?.actor_id ?? message.sender_id;
    if (senderId === this.config.agentId) throw fail('self_reply_refused', 422);
    await enforceSendBudget(this.active, this.home, { agentId: this.config.agentId, ownerId: this.config.ownerId,
      kind: 'reply', roomId: payload.roomId, replyToMessageId: payload.replyToMessageId });
    const result = await this.active.request('POST', `/v1/rooms/${encodeURIComponent(payload.roomId)}/messages`, {
      body: payload.body, reply_to_message_id: payload.replyToMessageId
    }, { headers: { 'idempotency-key': key } });
    const safeResult = safeView(result, this.secrets);
    const sentAt = this.now();
    // Commit delivery evidence before accounting. A replay after either write
    // never resends or gets blocked by the already-consumed local send budget.
    await receipts.save({ payloadHash, sentAt, result: safeResult });
    await recordSend(this.home, { key, now: sentAt });
    return safeResult;
  }

  async end(callerId) {
    const local = await this.state.loadSession(callerId);
    if (!local) return;
    try {
      await this.client(local.token).request('POST', `/v1/sessions/${encodeURIComponent(local.session_id)}/end`, { reason: 'agent_ended' });
    } catch (error) {
      if (!['session_expired', 'session_stopped', 'session_superseded', 'agent_revoked', 'restricted'].includes(error.code)) throw error;
    }
    await recordSessionEnd(this.home, local.session_id);
    await this.state.clearSession(callerId);
  }
}

function shorten(value) {
  if (typeof value === 'string') return value.length > 1500 ? `${value.slice(0, 1500)} [truncated; use a targeted read]` : value;
  if (Array.isArray(value)) return value.map(shorten);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, shorten(nested)]));
  return value;
}
