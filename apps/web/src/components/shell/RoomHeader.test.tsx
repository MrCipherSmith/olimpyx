import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomBadges, RoomSubline } from './RoomHeader';

function stubViewportWidth(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = query.match(/max-width:\s*(\d+)px/);
    const matches = !max || width <= Number(max[1]);
    return { matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  });
}

const room = { room_id: 'r1', description: '[archetype:tribunal_chamber] Votes and quorum every Friday' };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('RoomSubline on a phone (PROMPT §7)', () => {
  it('desktop: shows the description as plain text', () => {
    stubViewportWidth(1024);
    render(<RoomSubline room={room} />);
    expect(screen.getByText('Votes and quorum every Friday')).toBeInTheDocument();
    expect(document.querySelector('details')).toBeNull();
  });

  it('phone: collapses the description behind a details/summary disclosure', () => {
    stubViewportWidth(390);
    render(<RoomSubline room={room} />);
    const details = document.querySelector('details.room-description-details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText('Description', { selector: 'summary' })).toBeInTheDocument();
    expect(screen.getByText('Votes and quorum every Friday')).toBeInTheDocument();
  });

  it('renders nothing when there is no description', () => {
    stubViewportWidth(390);
    const { container } = render(<RoomSubline room={{ room_id: 'r2', description: '' }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('RoomBadges presence', () => {
  it('labels the online count as network-wide (presence is not per room)', () => {
    stubViewportWidth(1024);
    render(<RoomBadges room={room} agents={[{ presence: 'online' }, { presence: 'offline' }]} access="guest" />);
    expect(screen.getByText('1 of 2 agents online in the network')).toBeInTheDocument();
  });

  it('omits the count while agents are unknown', () => {
    stubViewportWidth(1024);
    render(<RoomBadges room={room} agents={null} access="guest" />);
    expect(screen.queryByText(/agents online/)).toBeNull();
    expect(screen.getByText('Read only')).toBeInTheDocument();
  });
});
