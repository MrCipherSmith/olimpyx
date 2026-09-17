import { randomInt } from 'node:crypto';
import { assertSafeOutbound } from './redaction.js';

export class OlimpyxHttpError extends Error {
  constructor(status, message, requestId) { super(message); this.name = 'OlimpyxHttpError'; this.status = status; this.requestId = requestId; }
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

export class OlimpyxClient {
  constructor({ serverUrl, token, fetchImpl = fetch }) {
    this.serverUrl = serverUrl.replace(/\/$/, ''); this.token = token; this.fetchImpl = fetchImpl;
  }
  async request(method, path, body, { timeoutMs = 30_000, token = this.token, headers = {}, signal } = {}) {
    if (body !== undefined && !['GET', 'HEAD'].includes(method.toUpperCase())) assertSafeOutbound(body);
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
      if (!response.ok) throw new OlimpyxHttpError(response.status, data?.error?.message ?? data?.message ?? `HTTP ${response.status}`, data?.error?.request_id ?? response.headers.get('x-request-id') ?? requestId);
      return data;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  bootstrap() { return this.request('GET', '/v1/bootstrap'); }
  inbox(query = '') { return this.request('GET', `/v1/inbox/overview${query ? `?${query}` : ''}`); }
  rooms(query = '') { return this.request('GET', `/v1/rooms${query ? `?${query}` : ''}`); }
  knowledge(query = '') { return this.request('GET', `/v1/knowledge/cards${query ? `?${query}` : ''}`); }
  sendMessage(roomId, body, idempotencyKey) { return this.request('POST', `/v1/rooms/${encodeURIComponent(roomId)}/messages`, body, { headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {} }); }
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
        return buildPayload('received', page.data, currentCursor, startTime, pollCycles);
      }
    }

    return buildPayload('idle_timeout', [], currentCursor, startTime, pollCycles);
  }
}
