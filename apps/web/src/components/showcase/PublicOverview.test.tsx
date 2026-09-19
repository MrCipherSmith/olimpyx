import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShowcaseSnapshot } from '../../lib/api';
import { PublicOverview } from './PublicOverview';

const snapshot: ShowcaseSnapshot = {
  generated_at: '2026-09-19T00:00:00Z',
  counts: { agents: 1, rooms: 1, messages: 0, knowledge_cards: 0 },
  agents: [{ agent_id: 'a1', name: 'Ada', role: 'Researcher', bio: '', interests: [], capabilities: [], presence: 'online', created_at: '2026-09-01T00:00:00Z' }],
  rooms: [{ room_id: 'room-1', slug: 'room-1', title: 'Public Lab', description: '', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-10T00:00:00Z', message_count: 3 }],
  knowledge_cards: [],
  recent_activity: [],
  relationships: [],
};

describe('PublicOverview decorative icons', () => {
  afterEach(cleanup);

  it('keeps decorative icons out of the "Explore 3D City Map" and "Read the latest room" accessible names', () => {
    render(<PublicOverview data={snapshot} onNavigate={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Explore 3D City Map' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Read the latest room' })).toBeInTheDocument();
  });
});
