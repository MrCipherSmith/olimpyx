import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthSession } from './auth-session';
import { OlimpyxApi, QuotaExceededError } from './api';

describe('OlimpyxApi security operations', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });
  it('revokes owner login through the server with authorization and idempotency', async () => {
    const session = new AuthSession(); session.save({ token: 'owner-secret', user: { id: 'own_1', email: 'owner@example.test', displayName: 'Owner' } });
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { revoked: true } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await new OlimpyxApi(session).logout();
    const [, options] = request.mock.calls[0];
    expect(options?.method).toBe('POST');
    expect((options?.headers as Record<string, string>).Authorization).toBe('Bearer owner-secret');
    expect((options?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  });
  it('unwraps report submission so the UI can poll its status', async () => {
    const session = new AuthSession(); session.save({ token: 'owner-secret', user: { id: 'own_1', email: 'owner@example.test', displayName: 'Owner' } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { report_id: 'rpt_1', status: 'escalated' } }), { status: 201 }));
    await expect(new OlimpyxApi(session).report({ target: { kind: 'profile', id: 'agt_1' }, category: 'spam', explanation: 'Repeated posts' })).resolves.toEqual({ report_id: 'rpt_1', status: 'escalated' });
  });
  it('loads every directory page using the returned cursor', async () => {
    const request = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{agent_id:'a'}], page:{next_cursor:'next-agent'} }), {status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{agent_id:'b'}], page:{next_cursor:null} }), {status:200}));
    const result = await new OlimpyxApi(new AuthSession()).agents();
    expect(result.map(agent=>agent.agent_id)).toEqual(['a','b']);
    expect(request.mock.calls[1][0]).toBe('/v1/agents?before_cursor=next-agent');
  });
  it('loads the deliberately shaped public showcase without requiring a session', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { generated_at: '2026-09-12T12:00:00Z', counts: { agents: 0, rooms: 0, messages: 0, knowledge_cards: 0 }, agents: [], rooms: [], knowledge_cards: [], recent_activity: [], relationships: [] } }), { status: 200 }));
    const result = await new OlimpyxApi(new AuthSession()).showcase();
    expect(result.counts.messages).toBe(0);
    expect(request.mock.calls[0][0]).toBe('/v1/showcase?limit=100');
    expect((request.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe('OlimpyxApi Q-016 owner controls', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });
  const ownerSession = () => { const session = new AuthSession(); session.save({ token: 'owner-secret', user: { id: 'own_1', email: 'owner@example.test', displayName: 'Owner' } }); return session; };

  it('stops an agent through the server with authorization, idempotency and an optional reason', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { agent_id: 'agt_1', session_ids: ['sess_1', 'sess_2'], stopped_at: '2026-09-19T10:00:00Z' } }), { status: 200 }));
    const result = await new OlimpyxApi(ownerSession()).stopAgent('agt_1', 'Investigating a report');
    expect(result).toEqual({ agent_id: 'agt_1', session_ids: ['sess_1', 'sess_2'], stopped_at: '2026-09-19T10:00:00Z' });
    const [url, options] = request.mock.calls[0];
    expect(url).toBe('/v1/owners/me/agents/agt_1/stop');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({ reason: 'Investigating a report' });
    expect((options?.headers as Record<string, string>).Authorization).toBe('Bearer owner-secret');
    expect((options?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  });

  it('stops an agent without a reason when none is given', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { agent_id: 'agt_1', session_ids: [], stopped_at: '2026-09-19T10:00:00Z' } }), { status: 200 }));
    await new OlimpyxApi(ownerSession()).stopAgent('agt_1');
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({});
  });

  it('reports the revoked flag on the owner agent list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ agent_id: 'agt_1', name: 'Ada', role: 'Researcher', bio: '', interests: [], capabilities: [], presence: 'offline', last_seen_at: null, profile_revision: 1, revoked: true }], page: { next_cursor: null } }), { status: 200 }));
    const result = await new OlimpyxApi(ownerSession()).ownAgents();
    expect(result[0].revoked).toBe(true);
  });

  it('loads owner usage with per-agent windows and 7/30-day counters', async () => {
    const usagePayload = {
      owner: { owner_id: 'own_1', window: { message: { used: 5, limit: 200, window_sec: 3600 } }, counters: { days_7: { messages: 5, replies_in_other_threads: 0, own_threads_resolved: 0, knowledge_cards: 0, knowledge_versions: 0, reviews_given: 0, tasks_completed_for_others: 0 }, days_30: { messages: 12, replies_in_other_threads: 0, own_threads_resolved: 0, knowledge_cards: 0, knowledge_versions: 0, reviews_given: 0, tasks_completed_for_others: 0 } } },
      agents: [{ agent_id: 'agt_1', name: 'Ada', revoked: false, window: { message: { used: 2, limit: 60, window_sec: 3600 } }, counters: { days_7: { messages: 2, replies_in_other_threads: 0, own_threads_resolved: 0, knowledge_cards: 0, knowledge_versions: 0, reviews_given: 0, tasks_completed_for_others: 0 }, days_30: { messages: 4, replies_in_other_threads: 0, own_threads_resolved: 0, knowledge_cards: 0, knowledge_versions: 0, reviews_given: 0, tasks_completed_for_others: 0 } } }],
    };
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: usagePayload }), { status: 200 }));
    const result = await new OlimpyxApi(ownerSession()).usage();
    expect(result).toEqual(usagePayload);
    expect(request.mock.calls[0][0]).toBe('/v1/owners/me/usage');
  });

  it('loads the limits reference', async () => {
    const limitsPayload = { actions: { message: { window_sec: 3600, agent: 60, owner: 200 } }, direct_message_pair: { window_sec: 3600, limit: 10 }, capacity: { agents_per_owner: 10, enrollment_tokens_per_owner: 5, sessions_per_agent: 3, open_tasks_per_assignee: 20 } };
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: limitsPayload }), { status: 200 }));
    const result = await new OlimpyxApi(ownerSession()).limits();
    expect(result).toEqual(limitsPayload);
    expect(request.mock.calls[0][0]).toBe('/v1/limits');
  });

  it('parses a 429 quota_exceeded response into a typed QuotaExceededError, using the Retry-After header as fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'quota_exceeded', message: 'Quota exceeded for message: maximum 60 per 3600 seconds (agent)', request_id: 'req_1', details: { action: 'message', scope: 'agent', limit: 60, window_sec: 3600 } } }), { status: 429, headers: { 'Retry-After': '42' } }));
    const error = await new OlimpyxApi(ownerSession()).stopAgent('agt_1').catch(e => e);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect((error as QuotaExceededError).status).toBe(429);
    expect((error as QuotaExceededError).quota).toEqual({ action: 'message', scope: 'agent', limit: 60, windowSec: 3600, retryAfterSec: 42 });
  });

  it('prefers details.retry_after_sec over the Retry-After header when both are present', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'quota_exceeded', message: 'Quota exceeded', details: { action: 'room_create', scope: 'owner', limit: 10, window_sec: 86400, retry_after_sec: 900 } } }), { status: 429, headers: { 'Retry-After': '86400' } }));
    const error = await new OlimpyxApi(ownerSession()).stopAgent('agt_1').catch(e => e);
    expect((error as QuotaExceededError).quota.retryAfterSec).toBe(900);
  });

  it('rounds a fractional details.retry_after_sec up to whole seconds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'quota_exceeded', message: 'Quota exceeded', details: { action: 'message', scope: 'agent', limit: 60, window_sec: 3600, retry_after_sec: 41.2 } } }), { status: 429 }));
    const error = await new OlimpyxApi(ownerSession()).stopAgent('agt_1').catch(e => e);
    expect((error as QuotaExceededError).quota.retryAfterSec).toBe(42);
  });

  it('falls back to the Retry-After header when details.retry_after_sec is missing, non-numeric, or negative', async () => {
    const cases: Array<[unknown, Record<string, string>, number]> = [
      [undefined, { 'Retry-After': '90' }, 90],
      ['not-a-number', { 'Retry-After': '61.5' }, 62],
      [-5, { 'Retry-After': '30' }, 30],
      // `null` is the tricky one: Number(null) === 0, which is finite and >= 0, so a naive numeric
      // coercion would treat it as a valid "retry immediately" instead of falling back to the header.
      [null, { 'Retry-After': '30' }, 30],
    ];
    for (const [retryAfterSec, headers, expected] of cases) {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'quota_exceeded', message: 'Quota exceeded', details: { action: 'message', scope: 'agent', limit: 60, window_sec: 3600, retry_after_sec: retryAfterSec } } }), { status: 429, headers }));
      const error = await new OlimpyxApi(ownerSession()).stopAgent('agt_1').catch(e => e);
      expect((error as QuotaExceededError).quota.retryAfterSec).toBe(expected);
    }
  });

  it('defaults retryAfterSec to 0 when neither the body nor the header is a valid non-negative number', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'quota_exceeded', message: 'Quota exceeded', details: { action: 'message', scope: 'agent', limit: 60, window_sec: 3600 } } }), { status: 429, headers: { 'Retry-After': 'not-a-number' } }));
    const error = await new OlimpyxApi(ownerSession()).stopAgent('agt_1').catch(e => e);
    expect((error as QuotaExceededError).quota.retryAfterSec).toBe(0);
  });

  it('marks the limit as invalid (NaN) rather than defaulting to 0 when the body omits it or sends a non-number', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'quota_exceeded', message: 'Quota exceeded', details: { action: 'message', scope: 'agent', window_sec: 3600, retry_after_sec: 5 } } }), { status: 429 }));
    const error = await new OlimpyxApi(ownerSession()).stopAgent('agt_1').catch(e => e);
    expect(Number.isFinite((error as QuotaExceededError).quota.limit)).toBe(false);
  });
});
