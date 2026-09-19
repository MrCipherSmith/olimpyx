import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CityView } from './CityView';
import { buildCityScene } from './cityScene';
import { deterministicArchetype } from './roomArchetypes';

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
const agents = [{ presence: 'online' as const }, { presence: 'offline' as const }, { presence: 'online' as const }];

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
    render(<CityView rooms={rooms} agents={agents} cardCount={4} mode="participant" onNavigate={vi.fn()} />);
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

  it('opens a room card from the keyboard-focusable list and enters the existing room route', () => {
    const onNavigate = vi.fn();
    render(<CityView rooms={rooms} agents={agents} cardCount={4} mode="participant" onNavigate={onNavigate} />);
    const item = screen.getByRole('button', { name: /Consensus Hall/ });
    item.focus();
    expect(item).toHaveFocus();
    fireEvent.click(item); // Enter/Space on a native <button> dispatches click
    expect(item).toHaveAttribute('aria-pressed', 'true');
    const card = screen.getByRole('region', { name: 'Consensus Hall' });
    expect(card).toHaveFocus();
    expect(card).toHaveTextContent('Трибунал & Консенсус');
    expect(card).toHaveTextContent('Agora');
    expect(card).toHaveTextContent('Messages12');
    expect(card).toHaveTextContent('Votes and quorum');
    expect(card).not.toHaveTextContent('[archetype:');
    fireEvent.click(within(card).getByRole('button', { name: 'Enter room' }));
    expect(onNavigate).toHaveBeenCalledWith({ view: 'rooms', roomId: 'rom_a' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Consensus Hall' })).toBeNull();
    expect(item).toHaveFocus(); // focus returns to the list entry
  });

  it('omits the message count when the API does not provide one, and routes landmarks to their screens', () => {
    const onNavigate = vi.fn();
    render(<CityView rooms={rooms} agents={agents} cardCount={4} mode="participant" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /^Observatory/ }));
    expect(screen.getByRole('region', { name: 'Observatory' })).not.toHaveTextContent('Messages');
    fireEvent.click(screen.getByRole('button', { name: /Central Library/ }));
    const library = screen.getByRole('region', { name: 'Центральная Библиотека' });
    expect(library).toHaveTextContent('Knowledge cards4');
    fireEvent.click(within(library).getByRole('button', { name: 'Open knowledge' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ view: 'knowledge' });
  });

  it('shows online agents from presence and filters buildings by category', () => {
    render(<CityView rooms={rooms} agents={agents} cardCount={0} mode="participant" onNavigate={vi.fn()} />);
    expect(screen.getByText(/of 3 agents online/)).toHaveTextContent('2 of 3 agents online');
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
  });

  it('guest mode marks rooms as published and read only', () => {
    render(<CityView rooms={rooms.slice(0, 1)} agents={[]} cardCount={0} mode="guest" onNavigate={vi.fn()} />);
    expect(screen.getByText('No agents visible')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Consensus Hall/ }));
    const card = screen.getByRole('region', { name: 'Consensus Hall' });
    expect(card).toHaveTextContent('Published messages12');
    expect(card).toHaveTextContent('Guest access is read only.');
  });

  it('cancels the animation frame and observers on unmount', () => {
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const removeListener = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(<CityView rooms={rooms} agents={agents} cardCount={0} mode="participant" onNavigate={vi.fn()} />);
    unmount();
    expect(cancel).toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});

describe('buildCityScene', () => {
  it('places the Library at y = −80, the Pantheon at y = +80 and rooms on rings', () => {
    const scene = buildCityScene(Array.from({ length: 31 }, (_, index) => ({ room_id: `rom_${index}`, title: `Room ${index}` })));
    expect(scene.buildings.find(building => building.kind === 'library')).toMatchObject({ x: 0, y: -80 });
    expect(scene.buildings.find(building => building.kind === 'pantheon')).toMatchObject({ x: 0, y: 80 });
    expect(scene.buildings.filter(building => building.kind === 'room')).toHaveLength(31);
    expect(scene.rings).toEqual([520, 780, 1040, 1300]);
    expect(buildCityScene([]).rings).toEqual([520]);
  });
});
