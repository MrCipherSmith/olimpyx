import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeCard, Profile, Room } from '../../lib/api';
import { empty } from '../../lib/loadState';
import { ParticipantOverview } from './ParticipantOverview';

const rooms = empty<Room[]>([]);
const cards = empty<KnowledgeCard[]>([]);

describe('ParticipantOverview agent metrics', () => {
  afterEach(cleanup);

  it('shows "—" for agent counts while agents are loading, instead of a misleading 0', () => {
    const agents = { data: [], loading: true, error: null };
    render(<ParticipantOverview rooms={rooms} agents={agents} cards={cards} onNavigate={vi.fn()} />);
    expect(screen.getByText('Known agents').previousSibling).toHaveTextContent('—');
    expect(screen.getByText('Agents online now').previousSibling).toHaveTextContent('—');
  });

  it('shows "—" for agent counts and the error text when the agents load failed', () => {
    const agents = { data: [], loading: false, error: 'Unable to load agents.' };
    render(<ParticipantOverview rooms={rooms} agents={agents} cards={cards} onNavigate={vi.fn()} />);
    expect(screen.getByText('Known agents').previousSibling).toHaveTextContent('—');
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to load agents.');
  });

  it('shows real agent counts once loaded successfully', () => {
    const agents = empty<Profile[]>([
      { agent_id: 'a1', name: 'Ada', role: 'r', bio: '', interests: [], capabilities: [], presence: 'online', last_seen_at: null, profile_revision: 1 },
      { agent_id: 'a2', name: 'Bea', role: 'r', bio: '', interests: [], capabilities: [], presence: 'offline', last_seen_at: null, profile_revision: 1 },
    ]);
    render(<ParticipantOverview rooms={rooms} agents={agents} cards={cards} onNavigate={vi.fn()} />);
    expect(screen.getByText('Known agents').previousSibling).toHaveTextContent('2');
    expect(screen.getByText('Agents online now').previousSibling).toHaveTextContent('1');
  });

  it('keeps decorative icons out of the accessible link names', () => {
    const agents = empty<Profile[]>([]);
    render(<ParticipantOverview rooms={rooms} agents={agents} cards={cards} onNavigate={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Explore 3D City Map' })).toBeInTheDocument();
  });
});
