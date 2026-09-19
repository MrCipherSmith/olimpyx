import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const snapshot = {
  generated_at: '2026-09-12T12:00:00Z',
  counts: { agents: 1, rooms: 1, messages: 1, knowledge_cards: 1 },
  agents: [{ agent_id: 'agent-1', name: 'Ada', role: 'Researcher', bio: 'Tests ideas.', interests: ['reasoning'], capabilities: [], presence: 'online', created_at: '2026-09-01T00:00:00Z' }],
  rooms: [{ room_id: 'room-1', slug: 'public-lab', title: 'Public Lab', description: 'A published discussion.', created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-12T11:00:00Z', message_count: 1 }],
  knowledge_cards: [{ card_id: 'card-1', created_at: '2026-09-11T00:00:00Z', latest: { version_id: 'version-1', version: 1, topic: 'Measured result', summary: 'An observed result.', body: 'Evidence from the published experiment.', sources: [], status: 'confirmed', review_counts: { confirm: 1, refute: 0, comment: 0 }, author: { actor_type: 'agent', agent_id: 'agent-1', display_name: 'Ada' }, reviews: [{ review_id: 'review-1', reviewer: { actor_type: 'agent', agent_id: 'agent-1', display_name: 'Ada' }, verdict: 'confirm', explanation: 'Matches the evidence.', evidence: [], created_at: '2026-09-12T10:00:00Z' }] } }],
  recent_activity: [{ kind: 'knowledge', occurred_at: '2026-09-12T10:00:00Z', actor: { actor_type: 'agent', agent_id: 'agent-1', display_name: 'Ada' }, resource: { kind: 'knowledge_card', id: 'card-1', title: 'Measured result' }, summary: 'Published a measured result.' }],
  relationships: [],
};

describe('public showcase', () => {
  beforeEach(() => {
    cleanup();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('/v1/showcase/rooms/room-1/messages')) return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
      return new Response(JSON.stringify({ data: snapshot }), { status: 200 });
    });
  });

  it('shows network activity even though the visitor has no personal inbox', async () => {
    render(<App />);
    expect(await screen.findByText('Published a measured result.')).toBeInTheDocument();
    expect(screen.queryByText('Pending messages')).not.toBeInTheDocument();
  });

  it('uses readable reviewer links and hides owner and mutation controls from guests', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('link', { name: 'Knowledge' }));
    fireEvent.click(screen.getByRole('link', { name: /Measured result/ }));
    expect((await screen.findAllByRole('link', { name: 'Ada' })).some(link => link.getAttribute('href') === '/?view=agents&agent=agent-1')).toBe(true);
    expect(screen.queryByText('Owner controls')).not.toBeInTheDocument();
    expect(screen.queryByText('Report current version')).not.toBeInTheDocument();
  });

  it('restores selections on browser back and forward navigation', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('link', { name: 'Rooms' }));
    fireEvent.click(screen.getByRole('link', { name: /Public Lab/ }));
    await waitFor(() => expect(window.location.search).toBe('?view=rooms&room=room-1'));
    window.history.pushState(null, '', '/?view=agents&agent=agent-1');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(await screen.findByRole('heading', { name: 'Ada' })).toBeInTheDocument();
  });
});

describe('authenticated showcase surfaces', () => {
  beforeEach(() => { cleanup(); sessionStorage.clear(); window.history.replaceState(null, '', '/'); vi.restoreAllMocks(); });

  it('uses published network activity instead of the owner inbox on the overview', async () => {
    sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'owner-token', user: { id: 'owner-1', email: 'owner@example.test', displayName: 'Owner' } }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('/v1/rooms')) return new Response(JSON.stringify({ data: snapshot.rooms.map(room => ({ ...room, created_by: { actor_type: 'owner', actor_id: 'owner-1', display_name: 'Owner' } })), page: { next_cursor: null } }), { status: 200 });
      if (url.startsWith('/v1/agents')) return new Response(JSON.stringify({ data: snapshot.agents.map(agent => ({ ...agent, last_seen_at: null, profile_revision: 1 })), page: { next_cursor: null } }), { status: 200 });
      if (url.startsWith('/v1/knowledge/cards')) return new Response(JSON.stringify({ data: [{ card_id: 'card-1', latest_version_id: 'version-1', created_at: '2026-09-11T00:00:00Z', latest: { version_id: 'version-1', card_id: 'card-1', version: 1, topic: 'Measured result', summary: 'An observed result.', body: 'Evidence.', sources: [], references: [], author_agent_id: 'agent-1', status: 'confirmed', review_counts: { confirm: 1, refute: 0, comment: 0 }, created_at: '2026-09-11T00:00:00Z' }, challenge_of: null, challenged_by: [] }], page: { next_cursor: null } }), { status: 200 });
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });
    render(<App />);
    expect((await screen.findAllByText('An observed result.')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Pending messages')).not.toBeInTheDocument();
  });

  it('resolves authenticated review agent IDs to readable linked names', async () => {
    sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'owner-token', user: { id: 'owner-1', email: 'owner@example.test', displayName: 'Owner' } }));
    window.history.replaceState(null, '', '/?view=knowledge&card=card-1');
    const agent = { agent_id: 'agent-1', name: 'Ada', role: 'Researcher', bio: '', interests: [], capabilities: [], presence: 'online', last_seen_at: null, profile_revision: 1 };
    const card = { card_id: 'card-1', latest_version_id: 'version-1', created_at: '2026-09-11T00:00:00Z', latest: { version_id: 'version-1', card_id: 'card-1', version: 1, topic: 'Measured result', summary: 'An observed result.', body: 'Evidence.', sources: [], references: [], author_agent_id: 'agent-1', status: 'confirmed', review_counts: { confirm: 1, refute: 0, comment: 0 }, created_at: '2026-09-11T00:00:00Z' }, challenge_of: null, challenged_by: [] };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('/v1/agents')) return new Response(JSON.stringify({ data: [agent], page: { next_cursor: null } }), { status: 200 });
      if (url.startsWith('/v1/knowledge/cards/card-1/versions')) return new Response(JSON.stringify({ data: [card.latest], page: { next_cursor: null } }), { status: 200 });
      if (url.startsWith('/v1/knowledge/versions/version-1/reviews')) return new Response(JSON.stringify({ data: [{ review_id: 'review-1', version_id: 'version-1', reviewer_agent_id: 'agent-1', verdict: 'confirm', explanation: 'Matches evidence.', evidence: [], created_at: '2026-09-12T00:00:00Z' }], page: { next_cursor: null } }), { status: 200 });
      if (url === '/v1/knowledge/cards/card-1') return new Response(JSON.stringify({ data: card }), { status: 200 });
      if (url.startsWith('/v1/knowledge/cards')) return new Response(JSON.stringify({ data: [card], page: { next_cursor: null } }), { status: 200 });
      if (url.startsWith('/v1/showcase')) return new Response(JSON.stringify({ data: snapshot }), { status: 200 });
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });
    render(<App />);
    const reviewer = await screen.findByRole('link', { name: 'Ada' });
    expect(reviewer).toHaveAttribute('href', '/?view=agents&agent=agent-1');
    expect(screen.queryByText('agent-1')).not.toBeInTheDocument();
  });

  it('ignores a delayed private mutation after logout and a different login', async () => {
    sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'old-token', user: { id: 'owner-1', email: 'old@example.test', displayName: 'Old owner' } }));
    window.history.replaceState(null, '', '/?view=rooms');
    let resolveCreate!: (response: Response) => void;
    const delayedCreate = new Promise<Response>(resolve => { resolveCreate = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = String(input);
      const headers = options?.headers as Record<string, string> | undefined;
      if (url === '/v1/rooms' && options?.method === 'POST') return delayedCreate;
      if (url === '/v1/owners/logout') return new Response(null, { status: 204 });
      if (url === '/v1/owners/login') return new Response(JSON.stringify({ data: { owner: { owner_id: 'owner-2', email: 'new@example.test', display_name: 'New owner' }, access_token: 'new-token' } }), { status: 200 });
      if (url.startsWith('/v1/showcase')) return new Response(JSON.stringify({ data: { generated_at: '2026-09-12T00:00:00Z', counts: { agents: 0, rooms: 0, messages: 0, knowledge_cards: 0 }, agents: [], rooms: [], knowledge_cards: [], recent_activity: [], relationships: [] } }), { status: 200 });
      if (url.startsWith('/v1/rooms')) return new Response(JSON.stringify({ data: headers?.Authorization === 'Bearer new-token' ? [] : [{ room_id: 'old-room', slug: 'old', title: 'Old room', description: '', created_by: { actor_type: 'owner', actor_id: 'owner-1', display_name: 'Old owner' }, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' }], page: { next_cursor: null } }), { status: 200 });
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New room' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Leaked old room' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'new@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'long-enough-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('New owner')).toBeInTheDocument();
    resolveCreate(new Response(JSON.stringify({ data: { room_id: 'leaked-room', slug: 'leaked', title: 'Leaked old room', description: '', created_by: { actor_type: 'owner', actor_id: 'owner-1', display_name: 'Old owner' }, created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:00:00Z' } }), { status: 201 }));
    await Promise.resolve();
    fireEvent.click(screen.getByRole('link', { name: 'Rooms' }));
    await waitFor(() => expect(screen.queryByText('Leaked old room')).not.toBeInTheDocument());
  });

  it('clears a stale semantic-search-unavailable notice when Refresh reloads data', async () => {
    sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'owner-token', user: { id: 'owner-1', email: 'owner@example.test', displayName: 'Owner' } }));
    window.history.replaceState(null, '', '/?view=knowledge');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('/v1/knowledge/cards') && url.includes('search=semantic')) {
        return new Response(JSON.stringify({ error: { message: 'Semantic search backend unavailable', code: 'embedding_unavailable' } }), { status: 503 });
      }
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });
    render(<App />);

    fireEvent.change(await screen.findByLabelText('Search knowledge'), { target: { value: 'entropy' } });
    fireEvent.change(screen.getByLabelText('Search mode'), { target: { value: 'semantic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Semantic search is temporarily unavailable/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '↻ Refresh' }));
    await waitFor(() => expect(screen.queryByText(/Semantic search is temporarily unavailable/)).not.toBeInTheDocument());
  });

  it('clears a stale semantic-search-unavailable notice on sign out, so it cannot leak into the next session', async () => {
    sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'owner-token', user: { id: 'owner-1', email: 'owner@example.test', displayName: 'Owner' } }));
    window.history.replaceState(null, '', '/?view=knowledge');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('/v1/knowledge/cards') && url.includes('search=semantic')) {
        return new Response(JSON.stringify({ error: { message: 'Semantic search backend unavailable', code: 'embedding_unavailable' } }), { status: 503 });
      }
      if (url === '/v1/owners/logout') return new Response(null, { status: 204 });
      if (url === '/v1/owners/login') return new Response(JSON.stringify({ data: { owner: { owner_id: 'owner-2', email: 'new@example.test', display_name: 'New owner' }, access_token: 'new-token' } }), { status: 200 });
      if (url.startsWith('/v1/showcase')) return new Response(JSON.stringify({ data: snapshot }), { status: 200 });
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });
    render(<App />);

    fireEvent.change(await screen.findByLabelText('Search knowledge'), { target: { value: 'entropy' } });
    fireEvent.change(screen.getByLabelText('Search mode'), { target: { value: 'semantic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Semantic search is temporarily unavailable/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    // Sign back in (a different owner) and return to Knowledge: the previous notice must not reappear.
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'new@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'long-enough-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('New owner')).toBeInTheDocument();

    window.history.pushState(null, '', '/?view=knowledge');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(screen.queryByText(/Semantic search is temporarily unavailable/)).not.toBeInTheDocument();
  });

  it('feeds the 5s room-poll outcome into the network status, so an outage while a room is open shows', async () => {
    sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'owner-token', user: { id: 'owner-1', email: 'owner@example.test', displayName: 'Owner' } }));
    window.history.replaceState(null, '', '/?view=rooms&room=room-1');
    const room = { room_id: 'room-1', slug: 'room-1', title: 'Room', description: '', created_by: { actor_type: 'owner', actor_id: 'owner-1', display_name: 'Owner' }, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' };

    // Capture the room-poll interval's callback instead of waiting 5 real seconds for it, without
    // disturbing any other interval (e.g. testing-library's own `waitFor` polling uses setInterval
    // too) — only a 5000ms delay is ours, everything else passes through to the real timer functions.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const realSetInterval = window.setInterval.bind(window) as (...args: any[]) => unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const realClearInterval = window.clearInterval.bind(window) as (id: any) => void;
    const liveIntervals = new Map<unknown, () => void>();
    vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = realSetInterval(handler, timeout, ...args);
      if (timeout === 5000) liveIntervals.set(id, handler as () => void);
      return id;
    }) as unknown as typeof window.setInterval);
    vi.spyOn(window, 'clearInterval').mockImplementation(((id?: unknown) => {
      if (id !== undefined) liveIntervals.delete(id);
      realClearInterval(id);
    }) as typeof window.clearInterval);

    let messageCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('/v1/rooms/room-1/messages')) {
        messageCalls += 1;
        if (messageCalls === 1) return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
        return new Response(JSON.stringify({ error: { message: 'Server error' } }), { status: 500 });
      }
      if (url.startsWith('/v1/rooms')) return new Response(JSON.stringify({ data: [room], page: { next_cursor: null } }), { status: 200 });
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });

    const { container } = render(<App />);
    const networkBadge = () => container.querySelector('.network-status') as HTMLElement;
    await waitFor(() => expect(networkBadge()).toHaveTextContent('Online'));
    await waitFor(() => expect(liveIntervals.size).toBe(1));

    const [poll] = liveIntervals.values();
    await poll();
    await waitFor(() => expect(networkBadge()).toHaveTextContent('Offline'));
    expect(messageCalls).toBe(2);
  });
});
