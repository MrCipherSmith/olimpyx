import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CityView } from './CityView';
import { buildCityScene } from './cityScene';
import { deterministicArchetype } from './roomArchetypes';

/** Matches `(max-width: Npx)` / `(min-width: Npx)` queries against a fake viewport width. */
function stubViewportWidth(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = query.match(/max-width:\s*(\d+)px/);
    const min = query.match(/min-width:\s*(\d+)px/);
    const matches = (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
    return { matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  });
}

/** Canvas 2D context stub: records nothing, but lets the real renderer run end-to-end in jsdom. */
function stubContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: vi.fn() };
  return new Proxy({ measureText: () => ({ width: 40 }), createRadialGradient: () => gradient, createLinearGradient: () => gradient } as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : vi.fn()),
    set: (target, key: string, value) => { target[key] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

const rooms = [
  { room_id: 'rom_a', title: 'Consensus Hall', description: '[archetype:tribunal_chamber] Votes and quorum', message_count: 12 },
  { room_id: 'rom_b', title: '<img src=x onerror=alert(1)>', description: 'Plain text', message_count: 0 },
  { room_id: 'rom_c', title: 'Observatory', description: '' },
];
let rafCallbacks: FrameRequestCallback[] = [];
beforeEach(() => {
  rafCallbacks = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => stubContext() as never);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { rafCallbacks.push(callback); return rafCallbacks.length; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 500, top: 0, left: 0, right: 800, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('CityView accessible building list', () => {
  it('describes the canvas and lists every building as a focusable button', () => {
    render(<CityView rooms={rooms} mode="participant" onNavigate={vi.fn()} />);
    const canvas = screen.getByRole('img');
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas).toHaveAccessibleName(/Central Library, the Pantheon of Agents and 3 room buildings on 1 ring/);
    const list = screen.getByRole('navigation', { name: 'City buildings' });
    const buttons = within(list).getAllByRole('button');
    expect(buttons).toHaveLength(5);
    expect(buttons.every(button => button.tagName === 'BUTTON' && !button.hasAttribute('tabindex'))).toBe(true);
    expect(within(list).getByRole('button', { name: /Consensus Hall/ })).toHaveTextContent('Tribunal & Consensus · Agora');
    // Untrusted titles stay text; the archetype prefix is never shown.
    expect(within(list).getByRole('button', { name: /<img src=x onerror=alert\(1\)>/ })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByText(/\[archetype:/)).toBeNull();
    // The render loop ran through the real renderer without throwing.
    act(() => { rafCallbacks.splice(0).forEach(callback => callback(16)); });
  });

  it('opens a room screen from the keyboard-focusable list (no intermediate card)', () => {
    const onNavigate = vi.fn();
    render(<CityView rooms={rooms} mode="participant" onNavigate={onNavigate} />);
    const item = screen.getByRole('button', { name: /Consensus Hall/ });
    item.focus();
    expect(item).toHaveFocus();
    fireEvent.click(item); // Enter/Space on a native <button> dispatches click
    expect(onNavigate).toHaveBeenCalledWith({ view: 'rooms', roomId: 'rom_a' });
    expect(screen.queryByRole('region', { name: 'Consensus Hall' })).toBeNull();
  });

  it('routes the Forum landmarks and the legend to their screens', () => {
    const onNavigate = vi.fn();
    render(<CityView rooms={rooms} mode="participant" onNavigate={onNavigate} />);
    const list = screen.getByRole('navigation', { name: 'City buildings' });
    fireEvent.click(within(list).getByRole('button', { name: /Central Library/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'knowledge' });
    fireEvent.click(within(list).getByRole('button', { name: /Pantheon of Agents/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'agents' });
    const legend = screen.getByRole('group', { name: 'Key buildings' });
    fireEvent.click(within(legend).getByRole('button', { name: 'Library' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'knowledge' });
    fireEvent.click(within(legend).getByRole('button', { name: 'Pantheon' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'agents' });
  });

  it('filters buildings by category and collapses the directory panel', () => {
    render(<CityView rooms={rooms} mode="participant" onNavigate={vi.fn()} />);
    const agora = within(screen.getByRole('group', { name: 'Filter buildings by category' })).getByRole('button', { name: /Agora/ });
    expect(agora).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(agora);
    expect(agora).toHaveAttribute('aria-pressed', 'true');
    const list = screen.getByRole('navigation', { name: 'City buildings' });
    const names = within(list).getAllByRole('button').map(button => button.textContent);
    expect(names.some(name => name?.includes('Consensus Hall'))).toBe(true);
    expect(names.some(name => name?.includes('Central Library'))).toBe(true);
    const expectedRooms = rooms.filter(room => room.room_id === 'rom_a' || deterministicArchetype(room.room_id).category === 'agora').length;
    expect(names).toHaveLength(2 + expectedRooms);
    const toggle = screen.getByRole('button', { name: /Buildings/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'City buildings' })).toBeNull();
  });

  it('says a category is empty for a participant too (the Praetorium is not a room)', () => {
    const agoraOnly = [rooms[0]];
    render(<CityView rooms={agoraOnly} scene={buildCityScene(agoraOnly, { includePraetorium: true })} mode="participant" onNavigate={vi.fn()} />);
    fireEvent.click(within(screen.getByRole('group', { name: 'Filter buildings by category' })).getByRole('button', { name: /Science/ }));
    expect(screen.getByText('No rooms in this category.')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('group', { name: 'Filter buildings by category' })).getByRole('button', { name: /Agora/ }));
    expect(screen.queryByText('No rooms in this category.')).toBeNull();
  });

  it('guest mode says when nothing is published yet', () => {
    render(<CityView rooms={[]} mode="guest" onNavigate={vi.fn()} />);
    expect(screen.getByText('No published rooms yet.')).toBeInTheDocument();
  });

  it('stops the render loop while a screen covers the city and resumes after', () => {
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const { rerender } = render(<CityView rooms={rooms} mode="participant" onNavigate={vi.fn()} />);
    expect(rafCallbacks.length).toBeGreaterThan(0);
    rerender(<CityView rooms={rooms} mode="participant" paused onNavigate={vi.fn()} />);
    expect(cancel).toHaveBeenCalled();
    rafCallbacks = [];
    rerender(<CityView rooms={rooms} mode="participant" paused={false} onNavigate={vi.fn()} />);
    expect(rafCallbacks.length).toBe(1);
  });

  it('cancels the animation frame and observers on unmount', () => {
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const removeListener = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(<CityView rooms={rooms} mode="participant" onNavigate={vi.fn()} />);
    unmount();
    expect(cancel).toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});

describe('CityView phones and tablets (PROMPT §7)', () => {
  it('phone: hides the legend but keeps the Library and Pantheon reachable from the (collapsed) directory', () => {
    stubViewportWidth(390);
    render(<CityView rooms={rooms} mode="participant" onNavigate={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'Key buildings' })).toBeNull();
    const toggle = screen.getByRole('button', { name: /Buildings/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'City buildings' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('navigation', { name: 'City buildings' });
    expect(within(list).getByRole('button', { name: /Central Library/ })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /Pantheon of Agents/ })).toBeInTheDocument();
  });

  it('tablet: keeps the legend, but the directory panel is collapsed by default too', () => {
    stubViewportWidth(768);
    render(<CityView rooms={rooms} mode="participant" onNavigate={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Key buildings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Buildings/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('desktop: the directory panel stays open by default, as before', () => {
    stubViewportWidth(1280);
    render(<CityView rooms={rooms} mode="participant" onNavigate={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Buildings/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('phone: the camera control drops the D-pad, keeping zoom and reset', () => {
    stubViewportWidth(390);
    render(<CityView rooms={rooms} mode="participant" onNavigate={vi.fn()} />);
    const camera = screen.getByRole('group', { name: 'Map camera' });
    expect(within(camera).queryByRole('button', { name: 'Pan up' })).toBeNull();
    expect(within(camera).getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
    expect(within(camera).getByRole('button', { name: 'Reset view' })).toBeInTheDocument();
  });

  it('desktop: the camera control keeps the full D-pad', () => {
    stubViewportWidth(1280);
    render(<CityView rooms={rooms} mode="participant" onNavigate={vi.fn()} />);
    const camera = screen.getByRole('group', { name: 'Map camera' });
    expect(within(camera).getByRole('button', { name: 'Pan up' })).toBeInTheDocument();
  });
});

describe('buildCityScene', () => {
  it('places the Library and the Pantheon side by side on the Forum and rooms on rings', () => {
    const scene = buildCityScene(Array.from({ length: 31 }, (_, index) => ({ room_id: `rom_${index}`, title: `Room ${index}` })));
    expect(scene.buildings.find(building => building.kind === 'library')).toMatchObject({ x: -125, y: 125 });
    expect(scene.buildings.find(building => building.kind === 'pantheon')).toMatchObject({ x: 125, y: -125 });
    expect(scene.buildings.filter(building => building.kind === 'room')).toHaveLength(31);
    expect(scene.rings).toEqual([520, 780, 1040, 1300]);
    expect(buildCityScene([]).rings).toEqual([520]);
  });
});

describe('CityView directory panel across viewport changes', () => {
  /** A viewport whose width can change later, notifying the matchMedia listeners like a real resize. */
  function resizableViewport(initial: number) {
    let width = initial;
    const lists: Array<{ query: string; listeners: Set<() => void>; readonly matches: boolean }> = [];
    const matchesAt = (query: string) => {
      const max = query.match(/max-width:\s*(\d+)px/);
      const min = query.match(/min-width:\s*(\d+)px/);
      return (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
    };
    vi.stubGlobal('matchMedia', (query: string) => {
      const listeners = new Set<() => void>();
      const list = { query, listeners, get matches() { return matchesAt(query); }, media: query, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) };
      lists.push(list);
      return list;
    });
    return (next: number) => act(() => { width = next; lists.forEach(list => list.listeners.forEach(fn => fn())); });
  }

  it('follows the viewport (open on desktop, collapsed when compact) until the user toggles it', () => {
    const resize = resizableViewport(1280);
    render(<CityView rooms={rooms} mode="participant" onNavigate={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: /Buildings/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    resize(768);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    resize(1280);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle); // the user's choice now wins over the viewport
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    resize(768);
    resize(1280);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
