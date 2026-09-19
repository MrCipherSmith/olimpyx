import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomSubline } from './RoomHeader';

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
