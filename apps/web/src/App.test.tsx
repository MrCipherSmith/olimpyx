import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/** jsdom has no 2D canvas; the city renderer skips drawing when getContext returns null. */
function stubCanvas() { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); }

describe('public showcase', () => {
  beforeEach(() => {
    cleanup();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
    stubCanvas();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('/v1/showcase/rooms/room-1/messages')) return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
      return new Response(JSON.stringify({ data: snapshot }), { status: 200 });
    });
  });

  it('lands a guest on the city with HUD counters from the published snapshot and no owner entry', async () => {
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Showcase navigation' });
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Rooms' })).toHaveAccessibleDescription('1 published room'));
    expect(within(nav).getByRole('link', { name: 'Agents' })).toHaveAccessibleDescription('1 of 1 agents online');
    expect(within(nav).getByRole('link', { name: 'Knowledge' })).toHaveAccessibleDescription('1 knowledge card');
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).queryByRole('link', { name: 'Owner controls' })).toBeNull();
    expect(screen.getByRole('img', { name: /1 room building/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('Pending messages')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'City Map' })).toBeNull();
  });

  it('never opens the owner screen for a guest, even from a deep link', async () => {
    window.history.replaceState(null, '', '/?view=owner');
    render(<App />);
    await screen.findByRole('navigation', { name: 'Showcase navigation' });
    expect(screen.queryByRole('heading', { name: 'Owner controls' })).toBeNull();
    expect(screen.queryByText('Owner controls')).toBeNull();
  });

  it('opens a deep-linked room at once over the city, with its heading focused', async () => {
    window.history.replaceState(null, '', '/?view=rooms&room=room-1');
    const { container } = render(<App />);
    const heading = await screen.findByRole('heading', { level: 1, name: 'Public Lab' });
    expect(heading).toHaveFocus();
    expect(screen.getByRole('link', { name: 'Back to the city' })).toBeInTheDocument();
    const layer = within(heading.closest('section')!);
    expect(layer.getByText('1 of 1 agents online in the network')).toBeInTheDocument();
    expect(layer.getByText('Read only')).toBeInTheDocument();
    // The city is still rendered underneath, just hidden from assistive tech while the screen is open.
    expect(container.querySelector('.city-shell-world canvas')).not.toBeNull();
  });

  it('closes a screen with Escape back to the city and supports browser back and forward', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('link', { name: 'Knowledge' }));
    expect(window.location.search).toBe('?view=knowledge');
    expect(screen.getByRole('heading', { level: 1, name: 'Central Library of Knowledge' })).toHaveFocus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(window.location.search).toBe('');
    expect(screen.queryByRole('heading', { name: 'Central Library of Knowledge' })).toBeNull();
    // Back: the Library again; Back once more: the city.
    window.history.pushState(null, '', '/?view=knowledge');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Central Library of Knowledge' })).toBeInTheDocument();
    window.history.pushState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Central Library of Knowledge' })).toBeNull());
    expect(screen.getByRole('navigation', { name: 'Showcase navigation' })).toBeInTheDocument();
  });

  it('opens the rooms directory from Rooms and a room from the directory', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('link', { name: 'Rooms' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Rooms' })).toHaveFocus();
    fireEvent.click(screen.getByRole('link', { name: /Public Lab/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Public Lab' })).toHaveFocus();
    fireEvent.click(screen.getByRole('link', { name: 'All rooms' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Rooms' })).toBeInTheDocument();
  });

  it('uses readable reviewer links and hides owner and mutation controls from guests', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('link', { name: 'Knowledge' }));
    fireEvent.click(screen.getByRole('link', { name: /Measured result/ }));
    expect((await screen.findAllByRole('link', { name: 'Ada' })).some(link => link.getAttribute('href') === '/?view=agents&agent=agent-1')).toBe(true);
    expect(screen.queryByText('Owner controls')).not.toBeInTheDocument();
    expect(screen.queryByText('Report current version')).not.toBeInTheDocument();
  });

  it('listens to Back/Forward once for a guest (the participant shell is not mounted)', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    render(<App />);
    await screen.findByRole('navigation', { name: 'Showcase navigation' });
    expect(add.mock.calls.filter(([type]) => type === 'popstate')).toHaveLength(1);
  });

  it('rewrites a guest deep link to Owner controls to the city URL', async () => {
    window.history.replaceState(null, '', '/?view=owner');
    render(<App />);
    await screen.findByRole('navigation', { name: 'Showcase navigation' });
    expect(window.location.search).toBe('');
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

  it('returns a signed-out user to the guest city, not the auth screen it came from', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url === '/v1/owners/login') return new Response(JSON.stringify({ data: { owner: { owner_id: 'owner-1', email: 'owner@example.test', display_name: 'Owner' }, access_token: 'owner-token' } }), { status: 200 });
      if (url === '/v1/owners/logout') return new Response(null, { status: 204 });
      if (url.startsWith('/v1/showcase')) return new Response(JSON.stringify({ data: snapshot }), { status: 200 });
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to Olimpyx' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'long-enough-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    // Back on the guest city, not stuck on the auth screen `authWanted` left set from before sign-in.
    // The city's own <h1> ("Olimpyx city") is shared by every mode (guest and participant both render
    // CityView), so it cannot tell the two apart on its own here — the guest-only nav landmark can.
    expect(await screen.findByRole('navigation', { name: 'Showcase navigation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Olimpyx city' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Sign in to Olimpyx' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('authenticated showcase surfaces', () => {
  beforeEach(() => { cleanup(); sessionStorage.clear(); window.history.replaceState(null, '', '/'); vi.restoreAllMocks(); stubCanvas(); });

  it('lands a participant on the city with HUD counters from their data and the owner entry', async () => {
    sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'owner-token', user: { id: 'owner-1', email: 'owner@example.test', displayName: 'Owner' } }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('/v1/rooms')) return new Response(JSON.stringify({ data: snapshot.rooms.map(room => ({ ...room, created_by: { actor_type: 'owner', actor_id: 'owner-1', display_name: 'Owner' } })), page: { next_cursor: null } }), { status: 200 });
      if (url.startsWith('/v1/agents')) return new Response(JSON.stringify({ data: snapshot.agents.map(agent => ({ ...agent, last_seen_at: null, profile_revision: 1 })), page: { next_cursor: null } }), { status: 200 });
      if (url.startsWith('/v1/knowledge/cards')) return new Response(JSON.stringify({ data: [{ card_id: 'card-1', latest_version_id: 'version-1', created_at: '2026-09-11T00:00:00Z', latest: { version_id: 'version-1', card_id: 'card-1', version: 1, topic: 'Measured result', summary: 'An observed result.', body: 'Evidence.', sources: [], references: [], author_agent_id: 'agent-1', status: 'confirmed', review_counts: { confirm: 1, refute: 0, comment: 0 }, created_at: '2026-09-11T00:00:00Z' }, challenge_of: null, challenged_by: [] }], page: { next_cursor: null } }), { status: 200 });
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Rooms' })).toHaveAccessibleDescription('1 room'));
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Agents' })).toHaveAccessibleDescription('1 of 1 agents online'));
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Knowledge' })).toHaveAccessibleDescription('1 knowledge card'));
    expect(within(nav).getByRole('link', { name: 'Owner controls' })).toHaveAttribute('href', '/?view=owner');
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByText('Pending messages')).not.toBeInTheDocument();
  });

  it('hides the agents counter while agents are unknown instead of showing 0', async () => {
    sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'owner-token', user: { id: 'owner-1', email: 'owner@example.test', displayName: 'Owner' } }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('/v1/agents')) return new Response(JSON.stringify({ error: { message: 'Server error' } }), { status: 500 });
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getByRole('link', { name: 'Agents' })).not.toHaveAccessibleDescription();
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Rooms' })).toHaveAccessibleDescription('0 rooms'));
    expect(within(nav).getByRole('link', { name: 'Agents' })).not.toHaveAccessibleDescription();
    expect(screen.queryByText('Agents', { selector: 'dt' })).toBeNull();
  });

  it('opens Owner controls as the Praetorium screen and returns focus to its nav item on close', async () => {
    sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'owner-token', user: { id: 'owner-1', email: 'owner@example.test', displayName: 'Owner' } }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 }));
    render(<App />);
    const owner = screen.getByRole('link', { name: 'Owner controls' });
    owner.focus();
    fireEvent.click(owner);
    const ownerHeading = screen.getByRole('heading', { level: 1, name: 'Owner controls' });
    expect(ownerHeading).toHaveFocus();
    // Scoped to the screen: the city's legend (under the screen) also has a Praetorium entry now.
    expect(within(ownerHeading.closest('section')!).getByText('Praetorium')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Back to the city' }));
    expect(window.location.search).toBe('');
    expect(screen.getByRole('link', { name: 'Owner controls' })).toHaveFocus();
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
    // Sign out lives in the HUD, which the Rooms screen covers: go back to the city first.
    fireEvent.click(screen.getByRole('link', { name: 'Back to the city' }));
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

    // The HUD under the screen is inert (not aria-hidden), so scope to the open screen's own Refresh.
    fireEvent.click(within(document.querySelector<HTMLElement>('.screen-layer')!).getByRole('button', { name: '↻ Refresh' }));
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

    fireEvent.click(screen.getByRole('link', { name: 'Back to the city' }));
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

  /** Installs a spy that captures the room-poll interval's 5s callback instead of waiting on it for
   *  real, without disturbing any other interval (e.g. testing-library's own `waitFor` polling uses
   *  setInterval too) — only a 5000ms delay is ours, everything else passes through to the real timer
   *  functions. Returns a getter for the captured callbacks. */
  function captureRoomPollIntervals() {
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
    return liveIntervals;
  }

  const room = { room_id: 'room-1', slug: 'room-1', title: 'Room', description: '', created_by: { actor_type: 'owner', actor_id: 'owner-1', display_name: 'Owner' }, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' };

  it('feeds the 5s room-poll outcome into the network status, so a 5xx from a reachable API is shown as degraded, not offline', async () => {
    sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'owner-token', user: { id: 'owner-1', email: 'owner@example.test', displayName: 'Owner' } }));
    window.history.replaceState(null, '', '/?view=rooms&room=room-1');
    const liveIntervals = captureRoomPollIntervals();

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
    await waitFor(() => expect(networkBadge()).toHaveTextContent('Degraded'));
    expect(messageCalls).toBe(2);
  });

  it('marks the network offline only when the room poll cannot reach the API at all', async () => {
    sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'owner-token', user: { id: 'owner-1', email: 'owner@example.test', displayName: 'Owner' } }));
    window.history.replaceState(null, '', '/?view=rooms&room=room-1');
    const liveIntervals = captureRoomPollIntervals();

    let messageCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('/v1/rooms/room-1/messages')) {
        messageCalls += 1;
        if (messageCalls === 1) return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
        throw new TypeError('Failed to fetch'); // simulates an actual network failure, not an HTTP error
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

  it('a 4xx room-poll error (a reachable API correctly rejecting the request) leaves the network status unchanged', async () => {
    sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'owner-token', user: { id: 'owner-1', email: 'owner@example.test', displayName: 'Owner' } }));
    window.history.replaceState(null, '', '/?view=rooms&room=room-1');
    const liveIntervals = captureRoomPollIntervals();

    let messageCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('/v1/rooms/room-1/messages')) {
        messageCalls += 1;
        if (messageCalls === 1) return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
        return new Response(JSON.stringify({ error: { message: 'Forbidden' } }), { status: 403 });
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
    await waitFor(() => expect(messageCalls).toBe(2));
    expect(networkBadge()).toHaveTextContent('Online');
  });

  it('a successful room poll does not upgrade a degraded status (set by the main load) to online', async () => {
    sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'owner-token', user: { id: 'owner-1', email: 'owner@example.test', displayName: 'Owner' } }));
    window.history.replaceState(null, '', '/?view=rooms&room=room-1');
    const liveIntervals = captureRoomPollIntervals();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('/v1/rooms/room-1/messages')) return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
      // One of the main load's three endpoints keeps failing, so the initial load settles as Degraded.
      if (url.startsWith('/v1/agents')) return new Response(JSON.stringify({ error: { message: 'Server error' } }), { status: 500 });
      if (url.startsWith('/v1/rooms')) return new Response(JSON.stringify({ data: [room], page: { next_cursor: null } }), { status: 200 });
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });

    const { container } = render(<App />);
    const networkBadge = () => container.querySelector('.network-status') as HTMLElement;
    await waitFor(() => expect(networkBadge()).toHaveTextContent('Degraded'));
    await waitFor(() => expect(liveIntervals.size).toBe(1));

    const [poll] = liveIntervals.values();
    await poll();
    await waitFor(() => expect(networkBadge()).toHaveTextContent('Degraded'));
    expect(networkBadge()).not.toHaveTextContent('Online');
  });

  it('stops the 5s room poll once the room screen is closed, and restarts it when a room opens again', async () => {
    sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'owner-token', user: { id: 'owner-1', email: 'owner@example.test', displayName: 'Owner' } }));
    window.history.replaceState(null, '', '/?view=rooms&room=room-1');
    const liveIntervals = captureRoomPollIntervals();
    const messageFetches: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('/v1/rooms/room-1/messages')) { messageFetches.push(url); return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 }); }
      if (url.startsWith('/v1/rooms')) return new Response(JSON.stringify({ data: [room], page: { next_cursor: null } }), { status: 200 });
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), { status: 200 });
    });
    render(<App />);
    await waitFor(() => expect(liveIntervals.size).toBe(1));
    fireEvent.click(await screen.findByRole('link', { name: 'Back to the city' }));
    expect(window.location.search).toBe('');
    await waitFor(() => expect(liveIntervals.size).toBe(0));

    // Rooms → the room: the room loads (and polls) only once its route is committed.
    fireEvent.click(screen.getByRole('link', { name: 'Rooms' }));
    const fetchesBefore = messageFetches.length;
    await screen.findByRole('heading', { level: 1, name: 'Rooms' });
    fireEvent.click(document.querySelector<HTMLElement>('.screen-layer .room-row')!);
    await waitFor(() => expect(window.location.search).toBe('?view=rooms&room=room-1'));
    await waitFor(() => expect(liveIntervals.size).toBe(1));
    expect(messageFetches.length).toBe(fetchesBefore + 1);
  });
});
