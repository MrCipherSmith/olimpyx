import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CityCameraController } from '../city/CityCanvas';
import { buildCityScene } from '../city/cityScene';
import { screenFor, type Route } from '../../lib/navigation';
import { initialNetworkStatus } from '../../lib/networkStatus';
import { CityHud } from './CityHud';
import { CityShell } from './CityShell';
import { DIVE_TIMINGS } from './diveMachine';
import { DiveOverlay, TargetLock } from './DiveOverlay';
import { ScreenLayer } from './ScreenLayer';
import { useCityRoute } from './useCityRoute';

const buildings = buildCityScene([{ room_id: 'r1', title: 'Signal Lab' }]).buildings;
const { focusMs, diveMs, coverMs, returnMs } = DIVE_TIMINGS;

function fakeCamera(canAnimate = true): CityCameraController {
  return { zoomBy: vi.fn(), panBy: vi.fn(), reset: vi.fn(), canAnimate: () => canAnimate, dive: vi.fn() };
}

const TITLES = { rooms: 'Rooms', room: 'Signal Lab', knowledge: 'Central Library of Knowledge', agents: 'Pantheon of Agents', owner: 'Owner controls' } as const;

/** The shell as App wires it: HUD nav, a building button, screen layers, the dive overlay and target lock. */
function Harness({ camera, normalize, scene = buildings }: { camera: CityCameraController; normalize?: (route: Route) => Route; scene?: typeof buildings }) {
  const cameraRef = useRef<CityCameraController | null>(camera);
  const { route, navigate, close, dive } = useCityRoute({ buildings: scene, camera: cameraRef, normalize });
  const info = screenFor(route);
  return (
    <CityShell
      hud={<CityHud navLabel="Main navigation" eyebrow="Test" network={initialNetworkStatus} activeView={route.view} onNavigate={navigate} stats={[]} account={null}
        items={[{ view: 'overview', label: 'Overview', icon: '◫' }, { view: 'rooms', label: 'Rooms', icon: '#' }, { view: 'knowledge', label: 'Knowledge', icon: '◈' }, { view: 'agents', label: 'Agents', icon: '⦾' }]} />}
      city={<>
        <button type="button" onClick={() => navigate({ view: 'knowledge' })}>Central Library</button>
        <TargetLock target={dive.phase === 'focusing' ? dive.target : null} />
      </>}
      screen={info && <ScreenLayer key={info.key} kind={info.kind} title={TITLES[info.kind]} onBack={close}>
        {info.kind === 'rooms' && <button type="button" onClick={() => navigate({ view: 'rooms', roomId: 'r1' })}>Open Signal Lab</button>}
      </ScreenLayer>}
      screenKey={info?.key ?? null}
      screenView={info ? route.view : null}
      transition={<DiveOverlay dive={dive} />}
      onClose={close}
    />
  );
}

const overlay = () => document.querySelector('.dive-overlay')!;
const heading = (name: string) => screen.queryByRole('heading', { level: 1, name });
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('reduce'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
}

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, '', '/');
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('dive into a building and back to the city', () => {
  it('focuses with a target lock, dives under the overlay, then opens the screen and focuses its heading', () => {
    const camera = fakeCamera();
    const push = vi.spyOn(window.history, 'pushState');
    render(<Harness camera={camera} />);
    const building = screen.getByRole('button', { name: 'Central Library' });
    building.focus();
    fireEvent.click(building);

    // Focusing: the camera glides, the lock frame shows, nothing is routed yet.
    expect(camera.dive).toHaveBeenLastCalledWith({ kind: 'focus', point: expect.objectContaining({ x: buildings[0].x, y: buildings[0].y }), ms: focusMs });
    expect(document.querySelector('.target-lock')).toHaveTextContent('TARGET LOCKED: Central Library of Knowledge');
    expect(document.querySelector('.target-lock')).toHaveAttribute('aria-hidden', 'true');
    expect(overlay()).not.toHaveClass('visible');
    expect(push).not.toHaveBeenCalled();
    expect(heading(TITLES.knowledge)).toBeNull();

    // Diving: full-screen overlay with the building name, decorative only.
    advance(focusMs);
    expect(camera.dive).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'dive', ms: diveMs }));
    expect(overlay()).toHaveClass('visible');
    expect(overlay()).toHaveAttribute('aria-hidden', 'true');
    expect(overlay()).toHaveTextContent('/// INITIATING PACKET DIVE ///');
    expect(overlay()).toHaveTextContent('Central Library of Knowledge');
    expect(document.querySelector('.target-lock')).toBeNull();
    expect(heading(TITLES.knowledge)).toBeNull();

    // Inside: the screen, its heading focused, one history entry.
    advance(diveMs);
    expect(heading(TITLES.knowledge)).toHaveFocus();
    expect(window.location.search).toBe('?view=knowledge');
    expect(push).toHaveBeenCalledTimes(1);
    expect(overlay()).not.toHaveClass('visible');
  });

  it('Back hides the screen behind the overlay, then returns the camera and the focus to the building', () => {
    const camera = fakeCamera();
    render(<Harness camera={camera} />);
    const building = screen.getByRole('button', { name: 'Central Library' });
    building.focus();
    fireEvent.click(building);
    advance(focusMs + diveMs);

    fireEvent.click(screen.getByRole('link', { name: 'Back to the city' }));
    expect(overlay()).toHaveClass('visible');
    expect(heading(TITLES.knowledge)).toBeInTheDocument(); // still under the overlay
    expect(camera.dive).toHaveBeenLastCalledWith({ kind: 'cover', point: expect.objectContaining({ x: buildings[0].x }) });
    fireEvent.keyDown(document.body, { key: 'Escape' }); // a second close during the exit is ignored
    advance(coverMs);
    expect(heading(TITLES.knowledge)).toBeNull();
    expect(window.location.search).toBe('');
    expect(building).toHaveFocus();
    expect(camera.dive).toHaveBeenLastCalledWith({ kind: 'return', ms: returnMs });
    expect(overlay()).not.toHaveClass('visible');
    advance(returnMs);
    // Idle again: a new dive is accepted.
    fireEvent.click(building);
    expect(document.querySelector('.target-lock')).not.toBeNull();
  });

  it('ignores other navigation while a dive runs, and Escape cancels the dive without routing', () => {
    const camera = fakeCamera();
    render(<Harness camera={camera} />);
    fireEvent.click(screen.getByRole('button', { name: 'Central Library' }));
    fireEvent.click(screen.getByRole('link', { name: 'Agents' }));
    expect(document.querySelector('.target-lock')).toHaveTextContent('Central Library of Knowledge');
    advance(200);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(camera.dive).toHaveBeenLastCalledWith({ kind: 'return', ms: returnMs });
    advance(5000);
    expect(heading(TITLES.knowledge)).toBeNull();
    expect(heading(TITLES.agents)).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('dives from a HUD nav item and returns the focus to it', () => {
    render(<Harness camera={fakeCamera()} />);
    const agents = screen.getByRole('link', { name: 'Agents' });
    agents.focus();
    fireEvent.click(agents);
    advance(focusMs + diveMs);
    expect(heading(TITLES.agents)).toHaveFocus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    advance(coverMs);
    expect(agents).toHaveFocus();
  });

  it('opening a room from the directory dives into that room', () => {
    const camera = fakeCamera();
    render(<Harness camera={camera} />);
    fireEvent.click(screen.getByRole('link', { name: 'Rooms' }));
    advance(focusMs + diveMs);
    expect(heading('Rooms')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Open Signal Lab' }));
    expect(heading('Rooms')).toBeNull();
    expect(document.querySelector('.target-lock')).toHaveTextContent('Signal Lab');
    advance(focusMs + diveMs);
    expect(heading('Signal Lab')).toHaveFocus();
    expect(window.location.search).toBe('?view=rooms&room=r1');
  });
});

describe('screens without a dive', () => {
  it('reduced motion: opens and closes at once, with no camera move', () => {
    stubReducedMotion(true);
    const camera = fakeCamera();
    render(<Harness camera={camera} />);
    fireEvent.click(screen.getByRole('button', { name: 'Central Library' }));
    expect(heading(TITLES.knowledge)).toHaveFocus();
    expect(window.location.search).toBe('?view=knowledge');
    fireEvent.click(screen.getByRole('link', { name: 'Back to the city' }));
    expect(heading(TITLES.knowledge)).toBeNull();
    expect(overlay()).not.toHaveClass('visible');
    const kinds = vi.mocked(camera.dive).mock.calls.map(([move]) => move.kind);
    expect(kinds).not.toContain('focus');
    expect(kinds).not.toContain('dive');
    expect(kinds).not.toContain('cover');
  });

  it('a city that is not drawn (no canvas context / zero size) opens screens at once', () => {
    render(<Harness camera={fakeCamera(false)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Central Library' }));
    expect(heading(TITLES.knowledge)).toHaveFocus();
  });

  it('a deep link opens the screen immediately, with the city underneath, and closing zooms out of its building', () => {
    window.history.replaceState(null, '', '/?view=agents');
    const camera = fakeCamera();
    const { container } = render(<Harness camera={camera} />);
    expect(heading(TITLES.agents)).toHaveFocus();
    expect(camera.dive).not.toHaveBeenCalled();
    expect(container.querySelector('.city-shell-world')).toContainElement(screen.getByText('Central Library', { selector: 'button' }));
    fireEvent.click(screen.getByRole('link', { name: 'Back to the city' }));
    expect(camera.dive).toHaveBeenLastCalledWith({ kind: 'cover', point: expect.objectContaining({ x: buildings[1].x, y: buildings[1].y }) });
    advance(coverMs);
    expect(heading(TITLES.agents)).toBeNull();
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveFocus();
  });
});

describe('browser history', () => {
  it('Back and Forward mirror close and open without adding entries', () => {
    const camera = fakeCamera();
    render(<Harness camera={camera} />);
    fireEvent.click(screen.getByRole('button', { name: 'Central Library' }));
    advance(focusMs + diveMs);
    const push = vi.spyOn(window.history, 'pushState');

    // Back (the URL is already the city): the exit runs, then the screen goes.
    window.history.replaceState(null, '', '/');
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(overlay()).toHaveClass('visible');
    advance(coverMs + returnMs);
    expect(heading(TITLES.knowledge)).toBeNull();

    // Forward: the screen opens at once, no dive.
    window.history.replaceState(null, '', '/?view=knowledge');
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(heading(TITLES.knowledge)).toHaveFocus();
    expect(push).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?view=knowledge');
  });

  it('Back/Forward to a screen during a dive opens that screen at once and the dive never lands', () => {
    render(<Harness camera={fakeCamera()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Central Library' }));
    advance(100);
    window.history.replaceState(null, '', '/?view=agents');
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(heading(TITLES.agents)).toHaveFocus();
    advance(5000);
    expect(heading(TITLES.agents)).toBeInTheDocument();
    expect(window.location.search).toBe('?view=agents');
  });
});

describe('history hygiene', () => {
  it('Overview while the city is shown adds no history entry (Back keeps working)', () => {
    const push = vi.spyOn(window.history, 'pushState');
    render(<Harness camera={fakeCamera()} />);
    fireEvent.click(screen.getByRole('link', { name: 'Overview' }));
    fireEvent.click(screen.getByRole('link', { name: 'Overview' }));
    expect(push).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });

  it('a close that lands on the URL already shown does not push it again', () => {
    stubReducedMotion(true);
    render(<Harness camera={fakeCamera()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Central Library' }));
    expect(window.location.search).toBe('?view=knowledge');
    // Browser Back moved the URL; a user close arriving with the same destination must not duplicate it.
    window.history.replaceState(null, '', '/');
    const push = vi.spyOn(window.history, 'pushState');
    fireEvent.click(screen.getByRole('link', { name: 'Back to the city' }));
    expect(heading(TITLES.knowledge)).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it('rewrites a route the viewer may not open in the URL too (guest ?view=owner), on load and on Back/Forward', () => {
    const guest = (route: Route): Route => (route.view === 'owner' ? { view: 'overview' } : route);
    window.history.replaceState(null, '', '/?view=owner');
    render(<Harness camera={fakeCamera()} normalize={guest} />);
    expect(window.location.search).toBe('');
    expect(heading(TITLES.owner)).toBeNull();
    window.history.replaceState(null, '', '/?view=owner');
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(window.location.search).toBe('');
    expect(heading(TITLES.owner)).toBeNull();
  });
});

describe('dive announcements and untrusted names', () => {
  it('announces "Opening <name>…" in a polite status region during the dive, and clears it after', () => {
    render(<Harness camera={fakeCamera()} />);
    const status = screen.getAllByRole('status').find(element => element.classList.contains('dive-status'))!;
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveClass('visually-hidden');
    expect(status).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole('button', { name: 'Central Library' }));
    expect(status).toHaveTextContent('Opening Central Library of Knowledge…');
    advance(focusMs);
    expect(status).toHaveTextContent('Opening Central Library of Knowledge…');
    advance(diveMs);
    expect(status).toBeEmptyDOMElement();
  });

  it('strips bidi controls from room names and isolates them in the overlay and the target lock', () => {
    const spoofed = buildCityScene([{ room_id: 'r1', title: '\u202Egnp.exe\u2066 Lab\u2069' }]).buildings;
    render(<Harness camera={fakeCamera()} scene={spoofed} />);
    fireEvent.click(screen.getByRole('link', { name: 'Rooms' }));
    advance(focusMs + diveMs);
    fireEvent.click(screen.getByRole('button', { name: 'Open Signal Lab' }));
    const lock = document.querySelector('.target-lock-text')!;
    expect(lock.querySelector('bdi')).toHaveTextContent('gnp.exe Lab');
    expect(/[\u202A-\u202E\u2066-\u2069]/.test(lock.textContent!)).toBe(false);
    expect(document.querySelector('.dive-status')).toHaveTextContent('Opening gnp.exe Lab…');
    advance(focusMs);
    const name = overlay().querySelector('.dive-overlay-name')!;
    expect(name.querySelector('bdi')).toHaveTextContent('gnp.exe Lab');
    expect(/[\u202A-\u202E\u2066-\u2069]/.test(overlay().textContent!)).toBe(false);
  });
});
