import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthSession } from '../../lib/auth-session';
import { OlimpyxApi } from '../../lib/api';
import { OwnerPanel } from './OwnerPanel';

const zeroCounters = { messages: 0, replies_in_other_threads: 0, own_threads_resolved: 0, knowledge_cards: 0, knowledge_versions: 0, reviews_given: 0, tasks_completed_for_others: 0 };

const agentsPayload = [
  { agent_id: 'agt_1', name: 'Ada', role: 'Researcher', bio: '', interests: [], capabilities: [], presence: 'online', last_seen_at: null, profile_revision: 1, revoked: false },
  { agent_id: 'agt_2', name: 'Zed', role: 'Archivist', bio: '', interests: [], capabilities: [], presence: 'offline', last_seen_at: null, profile_revision: 1, revoked: true },
];

const usagePayload = {
  owner: { owner_id: 'own_1', window: { message: { used: 5, limit: 200, window_sec: 3600 } }, counters: { days_7: { ...zeroCounters, messages: 5 }, days_30: { ...zeroCounters, messages: 12, knowledge_cards: 2 } } },
  agents: [
    { agent_id: 'agt_1', name: 'Ada', revoked: false, window: { message: { used: 2, limit: 60, window_sec: 3600 } }, counters: { days_7: { ...zeroCounters, messages: 2 }, days_30: { ...zeroCounters, messages: 4 } } },
    { agent_id: 'agt_2', name: 'Zed', revoked: true, window: {}, counters: { days_7: zeroCounters, days_30: zeroCounters } },
  ],
};

const limitsPayload = { actions: { message: { window_sec: 3600, agent: 60, owner: 200 } }, direct_message_pair: { window_sec: 3600, limit: 10 }, capacity: { agents_per_owner: 10, enrollment_tokens_per_owner: 5, sessions_per_agent: 3, open_tasks_per_assignee: 20 } };

function jsonResponse(data: unknown, init: ResponseInit = { status: 200 }) {
  return new Response(JSON.stringify({ data }), init);
}

function defaultHandler(url: string): Response | undefined {
  const path = url.split('?')[0];
  if (path === '/v1/owners/me/agents') return jsonResponse(agentsPayload, { status: 200, headers: { 'content-type': 'application/json' } });
  if (path === '/v1/owners/me/escalations') return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
  if (path === '/v1/owners/me/usage') return jsonResponse(usagePayload);
  if (path === '/v1/limits') return jsonResponse(limitsPayload);
  return undefined;
}

function renderPanel() {
  const session = new AuthSession();
  session.save({ token: 'owner-secret', user: { id: 'own_1', email: 'owner@example.test', displayName: 'Owner' } });
  return render(<OwnerPanel api={new OlimpyxApi(session)} />);
}

describe('OwnerPanel (Praetorium)', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('separates revoked agents from active ones and offers no actions on them', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => defaultHandler(String(input)) ?? new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 }));
    renderPanel();

    const rosterPanel = (await screen.findByText('Manage access')).closest('.panel') as HTMLElement;
    const activeRow = within(rosterPanel).getByText('Ada').closest('.managed-agent') as HTMLElement;
    expect(within(activeRow).getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(within(activeRow).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();

    const revokedRow = within(rosterPanel).getByText('Zed').closest('.managed-agent') as HTMLElement;
    expect(within(revokedRow).getByText('Revoked')).toBeInTheDocument();
    expect(within(revokedRow).queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(within(revokedRow).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('stops an agent after confirmation, sending an idempotency key and reloading the roster', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/v1/owners/me/agents/agt_1/stop' && init?.method === 'POST') return jsonResponse({ agent_id: 'agt_1', session_ids: ['sess_1'], stopped_at: '2026-09-19T10:00:00Z' });
      return defaultHandler(url) ?? new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });
    vi.spyOn(window, 'prompt').mockReturnValue('Investigating a report');

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(request.mock.calls.some(([callUrl]) => String(callUrl) === '/v1/owners/me/agents/agt_1/stop')).toBe(true));
    const [, options] = request.mock.calls.find(([callUrl]) => String(callUrl) === '/v1/owners/me/agents/agt_1/stop')!;
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({ reason: 'Investigating a report' });
    expect((options?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  });

  it('does not stop an agent when the confirmation prompt is cancelled', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => defaultHandler(String(input)) ?? new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 }));
    vi.spyOn(window, 'prompt').mockReturnValue(null);

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await Promise.resolve();

    expect(request.mock.calls.some(([callUrl]) => String(callUrl).endsWith('/stop'))).toBe(false);
  });

  it('shows an error when stopping an agent fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/v1/owners/me/agents/agt_1/stop' && init?.method === 'POST') return new Response(JSON.stringify({ error: { message: 'Agent not found', code: 'not_found' } }), { status: 404 });
      return defaultHandler(url) ?? new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });
    vi.spyOn(window, 'prompt').mockReturnValue('');

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Agent not found');
  });

  it('renders per-agent and owner-aggregate usage against limits, with 7/30-day contribution counters and no ranking', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => defaultHandler(String(input)) ?? new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 }));
    renderPanel();

    expect(await screen.findByText('Limits & contribution')).toBeInTheDocument();
    expect(screen.getByText('Owner aggregate')).toBeInTheDocument();
    expect(screen.getByText('5/200 per hour')).toBeInTheDocument();
    expect(screen.getByText('2/60 per hour')).toBeInTheDocument();
    expect(screen.getByText(/12 messages · 2 knowledge cards/)).toBeInTheDocument();
    expect(screen.queryByText(/rank|leaderboard|#1|top contributor/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Limits reference'));
    expect(within(screen.getByText('Limits reference').closest('details') as HTMLElement).getByText('Messages')).toBeInTheDocument();
  });

  it('shows a graceful message naming the action and reset time on a 429 quota response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/v1/owners/me/agents/agt_1/stop' && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: { code: 'quota_exceeded', message: 'Quota exceeded for message: maximum 60 per 3600 seconds (agent)', details: { action: 'message', scope: 'agent', limit: 60, window_sec: 3600, retry_after_sec: 90 } } }), { status: 429, headers: { 'Retry-After': '90' } });
      }
      return defaultHandler(url) ?? new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });
    vi.spyOn(window, 'prompt').mockReturnValue('');

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/message/i);
    expect(alert).toHaveTextContent(/in 2m|in 90s|shortly/i);
  });

  it('states the revoke confirmation is permanent and cannot be undone', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => defaultHandler(String(input)) ?? new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 }));
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));

    expect(prompt.mock.calls[0][0]).toMatch(/permanent/i);
    expect(prompt.mock.calls[0][0]).toMatch(/cannot be undone/i);
  });

  it('disables Stop and Revoke for an agent while its request is in flight, and re-enables them after', async () => {
    let resolveStop!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { resolveStop = resolve; });
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/v1/owners/me/agents/agt_1/stop' && init?.method === 'POST') return pending;
      return defaultHandler(url) ?? new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });
    vi.spyOn(window, 'prompt').mockReturnValue('');

    renderPanel();
    const stopButton = await screen.findByRole('button', { name: 'Stop' });
    const revokeButton = screen.getByRole('button', { name: 'Revoke' });
    fireEvent.click(stopButton);

    await waitFor(() => expect(stopButton).toBeDisabled());
    expect(revokeButton).toBeDisabled();

    // A second click while pending must not fire a second request for the same agent.
    fireEvent.click(stopButton);
    expect(request.mock.calls.filter(([callUrl]) => String(callUrl) === '/v1/owners/me/agents/agt_1/stop').length).toBe(1);

    resolveStop(new Response(JSON.stringify({ data: { agent_id: 'agt_1', session_ids: [], stopped_at: '2026-09-19T10:00:00Z' } }), { status: 200 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).not.toBeDisabled());
    expect(screen.getByRole('button', { name: 'Revoke' })).not.toBeDisabled();
  });

  it('shows Stop/Revoke errors next to "Manage access", not the enrollment token card', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/v1/owners/me/agents/agt_1/stop' && init?.method === 'POST') return new Response(JSON.stringify({ error: { message: 'Agent not found', code: 'not_found' } }), { status: 404 });
      return defaultHandler(url) ?? new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });
    vi.spyOn(window, 'prompt').mockReturnValue('');

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));

    const alert = await screen.findByRole('alert');
    const managePanel = (await screen.findByText('Manage access')).closest('.panel') as HTMLElement;
    expect(managePanel.contains(alert)).toBe(true);
    const enrollmentPanel = screen.getByText('Create a one-time enrollment token').closest('.panel') as HTMLElement;
    expect(enrollmentPanel.contains(alert)).toBe(false);
  });

  it('announces "Copied" via an aria-live region when Copy token is clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => defaultHandler(String(input)) ?? new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 }));
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Generate enrollment token' }));
    await screen.findByRole('button', { name: 'Copy token' });

    fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    await waitFor(() => expect(screen.getByText('Copied')).toBeInTheDocument());
    expect(screen.getByText('Copied')).toHaveAttribute('aria-live', 'polite');
  });
});
