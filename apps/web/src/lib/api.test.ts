import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthSession } from './auth-session';
import { OlimpyxApi } from './api';

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
});
