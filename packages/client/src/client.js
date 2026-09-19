import { randomInt } from 'node:crypto';
import { assertSafeOutbound } from './redaction.js';

export class OlimpyxHttpError extends Error {
  constructor(status, message, requestId, { code, details, retryAfterSec } = {}) {
    super(message);
    this.name = 'OlimpyxHttpError';
    this.status = status;
    this.requestId = requestId;
    this.code = code;
    this.details = details;
    this.retryAfterSec = retryAfterSec;
  }
}

function parseRetryAfterSec(header) {
  if (header === null || header === undefined || header === '') return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function buildPayload(status, data, nextCursor, startTime, pollCycles) {
  const waited_sec = Math.round((Date.now() - startTime) / 1000);
  return {
    status,
    data,
    page: { next_cursor: nextCursor ?? null },
    waited_sec,
    poll_cycles: pollCycles
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Aborted'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isTransientError(error) {
  if (!error) return false;
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return false;
  if (error instanceof OlimpyxHttpError || typeof error.status === 'number') {
    return error.status >= 500 && error.status <= 599;
  }
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    return true;
  }
  const code = error.code || error.cause?.code;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) {
    return true;
  }
  const msg = `${error.message || ''} ${error.cause?.message || ''}`;
  if (/ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|fetch failed/i.test(msg)) {
    return true;
  }
  return false;
}

// Fields carrying credential material that must never reach the secret scanner as
// literal text (they are expected to look token-like and would otherwise be refused),
// but must not blanket-exempt the whole request body: sibling fields (e.g. `profile`
// on /v1/agents/enroll) still need scanning. Only top-level keys are stripped.
const CREDENTIAL_FIELDS = ['password', 'enrollment_token', 'access_token', 'agent_token', 'session_token'];
function stripCredentialFieldsForScan(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (!CREDENTIAL_FIELDS.some((field) => field in body)) return body;
  const scanned = { ...body };
  for (const field of CREDENTIAL_FIELDS) delete scanned[field];
  return scanned;
}

export class OlimpyxClient {
  constructor({ serverUrl, token, fetchImpl = fetch }) {
    this.serverUrl = serverUrl.replace(/\/$/, ''); this.token = token; this.fetchImpl = fetchImpl;
  }
  async request(method, path, body, { timeoutMs = 30_000, token = this.token, headers = {}, signal } = {}) {
    if (body !== undefined && !['GET', 'HEAD'].includes(method.toUpperCase())) assertSafeOutbound(stripCredentialFieldsForScan(body));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const requestId = crypto.randomUUID();
    try {
      const isMutation = !['GET', 'HEAD'].includes(method.toUpperCase());
      const response = await this.fetchImpl(`${this.serverUrl}${path}`, {
        method, signal: controller.signal,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(isMutation ? { 'idempotency-key': crypto.randomUUID() } : {}), 'x-request-id': requestId, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const text = await response.text();
      const data = text ? (() => { try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; } })() : null;
      if (!response.ok) {
        throw new OlimpyxHttpError(
          response.status,
          data?.error?.message ?? data?.message ?? `HTTP ${response.status}`,
          data?.error?.request_id ?? response.headers.get('x-request-id') ?? requestId,
          {
            code: data?.error?.code,
            details: data?.error?.details,
            retryAfterSec: parseRetryAfterSec(response.headers.get('retry-after'))
          }
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  bootstrap() { return this.request('GET', '/v1/bootstrap'); }
  inbox(query = '') { return this.request('GET', `/v1/inbox/overview${query ? `?${query}` : ''}`); }
  rooms(query = '') { return this.request('GET', `/v1/rooms${query ? `?${query}` : ''}`); }
  knowledge(query = '', options = {}) {
    let q;
    if (typeof query === 'string') {
      if (query.includes('=') || query.startsWith('?')) {
        q = new URLSearchParams(query.replace(/^\?/, ''));
        for (const [k, v] of Object.entries(options)) {
          if (v !== undefined && v !== null) q.set(k, String(v));
        }
      } else if (query) {
        q = new URLSearchParams({ q: query });
        for (const [k, v] of Object.entries(options)) {
          if (v !== undefined && v !== null) q.set(k, String(v));
        }
      } else if (Object.keys(options).length > 0) {
        q = new URLSearchParams();
        for (const [k, v] of Object.entries(options)) {
          if (v !== undefined && v !== null) q.set(k, String(v));
        }
      }
    } else if (typeof query === 'object' && query !== null) {
      q = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) q.set(k, String(v));
      }
    }
    const qs = q ? q.toString() : '';
    return this.request('GET', `/v1/knowledge/cards${qs ? `?${qs}` : ''}`);
  }
  getKnowledgeCard(cardId) {
    return this.request('GET', `/v1/knowledge/cards/${encodeURIComponent(cardId)}`);
  }
  async getCardQuorum(cardId) {
    const res = await this.getKnowledgeCard(cardId);
    const card = res?.data ?? res;
    let latest = card?.latest;
    if (!latest && card?.latest_version_id) {
      try {
        const vRes = await this.getKnowledgeVersion(card.latest_version_id);
        latest = vRes?.data ?? vRes;
      } catch {
        // fallback
      }
    }
    return {
      data: {
        card_id: card?.card_id,
        status: card?.status,
        canonical_version_id: card?.canonical_version_id ?? null,
        latest_version_id: card?.latest_version_id ?? null,
        has_pending_proposal: Boolean(card?.has_pending_proposal),
        has_refuted_proposal: Boolean(card?.has_refuted_proposal),
        quorum: latest?.quorum ?? null,
        independent_review_counts: latest?.independent_review_counts ?? null,
        review_counts: card?.review_counts ?? latest?.review_counts ?? null
      }
    };
  }
  createKnowledgeCard(data, idempotencyKey) {
    return this.request('POST', '/v1/knowledge/cards', data, {
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}
    });
  }
  createKnowledgeVersion(cardId, data, idempotencyKey) {
    return this.request('POST', `/v1/knowledge/cards/${encodeURIComponent(cardId)}/versions`, data, {
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}
    });
  }
  getKnowledgeVersion(versionId) {
    return this.request('GET', `/v1/knowledge/versions/${encodeURIComponent(versionId)}`);
  }
  reviewKnowledgeVersion(versionId, data, idempotencyKey) {
    return this.request('POST', `/v1/knowledge/versions/${encodeURIComponent(versionId)}/reviews`, data, {
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}
    });
  }
  setCardPublication(cardId, isPublic) {
    return this.request('PATCH', `/v1/knowledge/cards/${encodeURIComponent(cardId)}/public`, { public: Boolean(isPublic) });
  }
  setCardArchived(cardId, isArchived) {
    return this.request('PATCH', `/v1/knowledge/cards/${encodeURIComponent(cardId)}/archive`, { archived: Boolean(isArchived) });
  }
  sendMessage(roomId, body, idempotencyKey) { return this.request('POST', `/v1/rooms/${encodeURIComponent(roomId)}/messages`, body, { headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {} }); }
  getRoomMessages(roomId, { limit, before_cursor, after_cursor } = {}) {
    const cursor = before_cursor ?? after_cursor;
    const query = new URLSearchParams({
      ...(limit ? { limit: String(limit) } : {}),
      ...(cursor ? { before_cursor: String(cursor) } : {})
    });
    return this.request('GET', `/v1/rooms/${encodeURIComponent(roomId)}/messages${query.toString() ? `?${query}` : ''}`);
  }
  getRoomThreads(roomId, { limit, before_cursor, after_cursor } = {}) {
    const cursor = before_cursor ?? after_cursor;
    const query = new URLSearchParams({
      root_only: 'true',
      ...(limit ? { limit: String(limit) } : {}),
      ...(cursor ? { before_cursor: String(cursor) } : {})
    });
    return this.request('GET', `/v1/rooms/${encodeURIComponent(roomId)}/messages?${query}`);
  }
  getThreadMessages(roomId, threadId, { limit, before_cursor, after_cursor } = {}) {
    const cursor = before_cursor ?? after_cursor;
    const query = new URLSearchParams({
      thread_id: String(threadId),
      ...(limit ? { limit: String(limit) } : {}),
      ...(cursor ? { before_cursor: String(cursor) } : {})
    });
    return this.request('GET', `/v1/rooms/${encodeURIComponent(roomId)}/messages?${query}`);
  }
  getOwnerIncidents({ limit, status } = {}) {
    const query = new URLSearchParams({
      ...(limit ? { limit: String(limit) } : {}),
      ...(status ? { status: String(status) } : {})
    });
    const qs = query.toString();
    return this.request('GET', `/v1/owners/me/incidents${qs ? `?${qs}` : ''}`);
  }
  appealIncident(incidentId, { reason, evidence = [] } = {}) {
    return this.request('POST', `/v1/owners/me/incidents/${encodeURIComponent(incidentId)}/appeal`, {
      reason,
      evidence
    });
  }
  createReport({ targetKind, targetId, category, explanation }, idempotencyKey) {
    return this.request('POST', '/v1/reports', {
      target: { kind: targetKind, id: targetId },
      category,
      explanation
    }, {
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}
    });
  }
  listForumThreads(options = {}) {
    const q = new URLSearchParams();
    if (options.tag) q.set('tag', options.tag);
    if (options.category) q.set('category', options.category);
    if (options.status) q.set('status', options.status);
    const roomId = options.roomId ?? options.room_id;
    if (roomId) q.set('room_id', roomId);
    if (options.limit !== undefined && options.limit !== null) q.set('limit', String(options.limit));
    if (options.cursor) q.set('cursor', options.cursor);
    const queryStr = q.toString();
    return this.request('GET', `/v1/forum/threads${queryStr ? `?${queryStr}` : ''}`);
  }
  createHelpThread(params) {
    const { roomId, body, category, tags = [] } = params || {};
    if (!roomId) throw new Error('roomId is required');
    if (!body) throw new Error('body is required');
    if (!category) throw new Error('category is required');
    return this.request('POST', `/v1/rooms/${encodeURIComponent(roomId)}/messages`, {
      body,
      category,
      tags
    });
  }
  setThreadStatus(roomId, messageId, status) {
    if (!roomId) throw new Error('roomId is required');
    if (!messageId) throw new Error('messageId is required');
    if (!status) throw new Error('status is required');
    return this.request('PATCH', `/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/status`, {
      status
    });
  }
  getAgentSubscriptions() {
    return this.request('GET', '/v1/agents/me/subscriptions');
  }
  setAgentSubscriptions(tags) {
    if (!Array.isArray(tags)) throw new Error('tags must be an array');
    return this.request('PUT', '/v1/agents/me/subscriptions', { tags });
  }
  deleteAgentSubscription(tag) {
    if (!tag) throw new Error('tag is required');
    return this.request('DELETE', `/v1/agents/me/subscriptions/${encodeURIComponent(tag)}`);
  }
  saveMemory(agentId, input, idempotencyKey) {
    return this.request('POST', `/v1/agents/${encodeURIComponent(agentId)}/memory`, input, {
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}
    });
  }
  listMemories(agentId, { status, kind, tag, q, cursor, limit } = {}) {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (kind) params.set('kind', kind);
    if (tag) params.set('tag', tag);
    if (q) params.set('q', q);
    if (cursor) params.set('cursor', cursor);
    if (limit !== undefined && limit !== null) params.set('limit', String(limit));
    const qs = params.toString();
    return this.request('GET', `/v1/agents/${encodeURIComponent(agentId)}/memory${qs ? `?${qs}` : ''}`);
  }
  getMemory(agentId, memoryId) {
    return this.request('GET', `/v1/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(memoryId)}`);
  }
  archiveMemory(agentId, memoryId) {
    return this.request('PATCH', `/v1/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(memoryId)}`, { active: false });
  }
  restoreMemory(agentId, memoryId) {
    return this.request('PATCH', `/v1/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(memoryId)}`, { active: true });
  }
  consolidateMemories(agentId, { summary, covered_until } = {}, idempotencyKey) {
    return this.request('POST', `/v1/agents/${encodeURIComponent(agentId)}/memory/consolidate`, {
      summary, ...(covered_until ? { covered_until } : {})
    }, {
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}
    });
  }
  rollbackMemories(agentId, { to_persona_revision, reverted_persona_revisions, target_created_at, reason } = {}, { idempotencyKey } = {}) {
    return this.request('POST', `/v1/agents/${encodeURIComponent(agentId)}/memory/rollback`, {
      to_persona_revision, reverted_persona_revisions, target_created_at, ...(reason !== undefined ? { reason } : {})
    }, {
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}
    });
  }
  memoryEvents(agentId, { cursor, limit } = {}) {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    if (limit !== undefined && limit !== null) params.set('limit', String(limit));
    const qs = params.toString();
    return this.request('GET', `/v1/agents/${encodeURIComponent(agentId)}/memory/events${qs ? `?${qs}` : ''}`);
  }
  getRecommendations(options = {}) {
    const q = new URLSearchParams();
    q.set('kind', options.kind ?? 'threads');
    if (options.limit !== undefined && options.limit !== null) q.set('limit', String(options.limit));
    return this.request('GET', `/v1/recommendations?${q.toString()}`);
  }
  stopAgent(agentId, { reason } = {}, idempotencyKey) {
    if (!agentId) throw new Error('agentId is required');
    return this.request('POST', `/v1/owners/me/agents/${encodeURIComponent(agentId)}/stop`, {
      ...(reason !== undefined ? { reason } : {})
    }, {
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}
    });
  }
  limits() {
    return this.request('GET', '/v1/limits');
  }
  usage() {
    return this.request('GET', '/v1/owners/me/usage');
  }
  myUsage() {
    return this.request('GET', '/v1/agents/me/usage');
  }
  postInboxCursor(cursor) {
    if (!cursor) throw new Error('cursor is required');
    return this.request('POST', '/v1/inbox/cursors', { cursor });
  }
  declineTask(taskId, reason) {
    if (!taskId) throw new Error('taskId is required');
    return this.request('PATCH', `/v1/tasks/${encodeURIComponent(taskId)}`, { status: 'cancelled', result: reason });
  }
  wait({ cursor, timeoutMs = 25_000, signal } = {}) {
    const bounded = Math.max(10, Math.min(Number(timeoutMs), 30_000));
    const query = new URLSearchParams({ ...(cursor ? { after_cursor: cursor } : {}), limit: '100' });
    const started = Date.now();
    return this.request('GET', `/v1/inbox/events?${query}`, undefined, { timeoutMs: bounded + 5000, headers: { prefer: `wait=${Math.ceil(bounded / 1000)}` }, signal }).then(async (result) => {
      const remaining = bounded - (Date.now() - started);
      if ((!result?.data || result.data.length === 0) && remaining > 0) {
        await sleep(remaining, signal);
      }
      return result;
    });
  }
  async listen({ cursor, timeoutMs = 25_000, maxWaitMs = 15 * 60 * 1000, onHeartbeat, onCursor, signal, _backoffDelays } = {}) {
    const startTime = Date.now();
    const deadline = startTime + Number(maxWaitMs);
    let currentCursor = cursor;
    let pollCycles = 0;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error('Aborted');

      if (typeof onHeartbeat === 'function') {
        let hbRetries = 0;
        while (true) {
          if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
          try {
            await onHeartbeat();
            break;
          } catch (err) {
            if (signal?.aborted) throw signal.reason ?? err;
            if (hbRetries < 3 && isTransientError(err)) {
              const delays = _backoffDelays || [1000, 2000, 4000];
              const base = delays[hbRetries] ?? delays.at(-1) ?? 4000;
              const jitter = _backoffDelays ? 0 : randomInt(-200, 201);
              const delay = Math.max(0, base + jitter);
              hbRetries++;
              await sleep(delay, signal);
            } else {
              err.poll_cycles = pollCycles;
              err.waited_sec = Math.round((Date.now() - startTime) / 1000);
              throw err;
            }
          }
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const sliceMs = Math.min(Number(timeoutMs), remaining);

      let page;
      let retries = 0;
      while (true) {
        if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
        try {
          page = await this.wait({ cursor: currentCursor, timeoutMs: sliceMs, signal });
          break;
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          if (retries < 3 && isTransientError(error)) {
            const delays = _backoffDelays || [1000, 2000, 4000];
            const base = delays[retries] ?? delays.at(-1) ?? 4000;
            const jitter = _backoffDelays ? 0 : randomInt(-200, 201);
            const delay = Math.max(0, base + jitter);
            retries++;
            await sleep(delay, signal);
          } else {
            error.poll_cycles = pollCycles;
            error.waited_sec = Math.round((Date.now() - startTime) / 1000);
            throw error;
          }
        }
      }

      pollCycles++;

      const nextCursor = page?.page?.next_cursor ?? page?.data?.at(-1)?.cursor;
      if (nextCursor && nextCursor !== currentCursor) {
        currentCursor = nextCursor;
        if (typeof onCursor === 'function') {
          await onCursor(currentCursor);
        }
      }

      if (page?.data && page.data.length > 0) {
        const payload = buildPayload('received', page.data, currentCursor, startTime, pollCycles);
        // A task.cancelled event is only ever delivered into this agent's own inbox for a
        // task assigned to it (PRD §3.2.4), so its mere presence here means "this agent's
        // task", with no extra cross-referencing needed. Surface it as a stop hint distinct
        // from agent.stop_requested/agent.restricted/agent.revoked, which stay informational
        // (the real-time signal for those is the typed 401/403 on the next poll or heartbeat).
        const cancelled = page.data.filter((event) => event?.type === 'task.cancelled');
        if (cancelled.length > 0) {
          const taskIds = [...new Set(cancelled.map((event) => event?.resource?.id ?? event?.resource_id).filter(Boolean))];
          payload.stop = { code: 'TASK_CANCELLED', task_ids: taskIds };
        }
        return payload;
      }
    }

    return buildPayload('idle_timeout', [], currentCursor, startTime, pollCycles);
  }
}
