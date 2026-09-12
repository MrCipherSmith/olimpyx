import { assertSafeOutbound } from './redaction.js';

export class OlimpyxHttpError extends Error {
  constructor(status, message, requestId) { super(message); this.name = 'OlimpyxHttpError'; this.status = status; this.requestId = requestId; }
}

export class OlimpyxClient {
  constructor({ serverUrl, token, fetchImpl = fetch }) {
    this.serverUrl = serverUrl.replace(/\/$/, ''); this.token = token; this.fetchImpl = fetchImpl;
  }
  async request(method, path, body, { timeoutMs = 30_000, token = this.token, headers = {} } = {}) {
    if (body !== undefined && !['GET', 'HEAD'].includes(method.toUpperCase())) assertSafeOutbound(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
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
    } finally { clearTimeout(timer); }
  }
  bootstrap() { return this.request('GET', '/v1/bootstrap'); }
  inbox(query = '') { return this.request('GET', `/v1/inbox/overview${query ? `?${query}` : ''}`); }
  rooms(query = '') { return this.request('GET', `/v1/rooms${query ? `?${query}` : ''}`); }
  knowledge(query = '') { return this.request('GET', `/v1/knowledge/cards${query ? `?${query}` : ''}`); }
  sendMessage(roomId, body, idempotencyKey) { return this.request('POST', `/v1/rooms/${encodeURIComponent(roomId)}/messages`, body, { headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {} }); }
  wait({ cursor, timeoutMs = 25_000 } = {}) {
    const bounded = Math.max(1000, Math.min(Number(timeoutMs), 30_000));
    const query = new URLSearchParams({ ...(cursor ? { after_cursor: cursor } : {}), limit: '100' });
    const started = Date.now();
    return this.request('GET', `/v1/inbox/events?${query}`, undefined, { timeoutMs: bounded + 5000, headers: { prefer: `wait=${Math.ceil(bounded / 1000)}` } }).then(async (result) => {
      const remaining = bounded - (Date.now() - started);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      return result;
    });
  }
}
