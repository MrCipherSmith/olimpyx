import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiveCameraMove } from '../city/cameraMath';
import type { Route } from '../../lib/navigation';
import { DIVE_TIMINGS, DiveController, IDLE, initialDiveState, insideState, reduceDive, type DiveCommit, type DiveTarget } from './diveMachine';

const library: DiveTarget = { key: 'library', name: 'Central Library of Knowledge', subline: 'Entering…', x: -125, y: 125, z: 75 };
const room: DiveTarget = { key: 'room:r1', name: 'Lab', subline: 'Entering…', x: 500, y: 0, z: 48 };
const knowledge: Route = { view: 'knowledge' };
const overview: Route = { view: 'overview' };

function setup(initial = IDLE) {
  const commits: DiveCommit[] = [];
  const moves: DiveCameraMove[] = [];
  const controller = new DiveController(initial, { commit: commit => commits.push(commit), camera: move => moves.push(move) });
  return { controller, commits, moves };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('dive state machine', () => {
  it('dives idle → focusing (650ms) → diving (550ms) → inside and only then commits the route', () => {
    const { controller, commits, moves } = setup();
    controller.send({ type: 'open', route: knowledge, target: library, animate: true, push: true });
    expect(controller.state).toMatchObject({ phase: 'focusing', target: library });
    expect(moves).toEqual([{ kind: 'focus', point: library, ms: DIVE_TIMINGS.focusMs }]);
    expect(commits).toEqual([]);
    vi.advanceTimersByTime(649);
    expect(controller.state.phase).toBe('focusing');
    vi.advanceTimersByTime(1);
    expect(controller.state.phase).toBe('diving');
    expect(moves.at(-1)).toEqual({ kind: 'dive', point: library, ms: DIVE_TIMINGS.diveMs });
    vi.advanceTimersByTime(549);
    expect(commits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(controller.state).toMatchObject({ phase: 'inside', target: library, pending: null });
    expect(commits).toEqual([{ route: knowledge, push: true }]);
  });

  it('exits inside → exiting (covered 300ms, then the city and the camera return 650ms) → idle', () => {
    const { controller, commits, moves } = setup(insideState(library));
    controller.send({ type: 'close', route: overview, animate: true, push: true });
    expect(controller.state).toMatchObject({ phase: 'exiting', covered: true });
    expect(moves).toEqual([{ kind: 'cover', point: library }]);
    expect(commits).toEqual([]); // the screen stays under the overlay
    vi.advanceTimersByTime(DIVE_TIMINGS.coverMs);
    expect(controller.state).toMatchObject({ phase: 'exiting', covered: false });
    expect(commits).toEqual([{ route: overview, push: true }]);
    expect(moves.at(-1)).toEqual({ kind: 'return', ms: DIVE_TIMINGS.returnMs });
    vi.advanceTimersByTime(DIVE_TIMINGS.returnMs);
    expect(controller.state).toEqual(IDLE);
  });

  it('ignores re-entry during a transition', () => {
    const { controller, commits, moves } = setup();
    controller.send({ type: 'open', route: knowledge, target: library, animate: true, push: true });
    controller.send({ type: 'open', route: { view: 'rooms', roomId: 'r1' }, target: room, animate: true, push: true });
    expect(controller.state.target).toBe(library);
    expect(moves).toHaveLength(1);
    vi.advanceTimersByTime(DIVE_TIMINGS.focusMs + DIVE_TIMINGS.diveMs);
    controller.send({ type: 'close', route: overview, animate: true, push: true });
    controller.send({ type: 'close', route: overview, animate: true, push: true }); // double Back
    controller.send({ type: 'open', route: knowledge, target: library, animate: true, push: true });
    vi.advanceTimersByTime(DIVE_TIMINGS.coverMs + DIVE_TIMINGS.returnMs);
    expect(commits).toEqual([{ route: knowledge, push: true }, { route: overview, push: true }]);
    expect(controller.state.phase).toBe('idle');
  });

  it('Escape / Back during the dive cancels it: no route commit, the camera returns, no stale tick', () => {
    const { controller, commits, moves } = setup();
    controller.send({ type: 'open', route: knowledge, target: library, animate: true, push: true });
    vi.advanceTimersByTime(DIVE_TIMINGS.focusMs + 100); // diving
    controller.send({ type: 'close', route: overview, animate: true, push: true });
    expect(controller.state).toEqual(IDLE);
    expect(moves.at(-1)).toEqual({ kind: 'return', ms: DIVE_TIMINGS.returnMs });
    vi.advanceTimersByTime(5000);
    expect(commits).toEqual([]);
    expect(controller.state).toEqual(IDLE);
  });

  it('opens and closes at once without animation (reduced motion) and never moves the camera', () => {
    const { controller, commits, moves } = setup();
    controller.send({ type: 'open', route: knowledge, target: library, animate: false, push: true });
    expect(controller.state.phase).toBe('inside');
    expect(commits).toEqual([{ route: knowledge, push: true }]);
    controller.send({ type: 'close', route: overview, animate: false, push: true });
    expect(controller.state).toEqual(IDLE);
    expect(commits.at(-1)).toEqual({ route: overview, push: true });
    expect(moves.every(move => move.kind === 'hold' || (move.kind === 'return' && move.ms === 0))).toBe(true);
  });

  it('opens without a dive when the scene has no target building (e.g. no Praetorium yet)', () => {
    const { controller, commits } = setup();
    controller.send({ type: 'open', route: { view: 'owner' }, target: null, animate: true, push: true });
    expect(controller.state.phase).toBe('inside');
    expect(commits).toEqual([{ route: { view: 'owner' }, push: true }]);
  });

  it('starts inside for a deep link, and a later close zooms out of the screen’s building', () => {
    expect(initialDiveState(true)).toEqual(insideState(null));
    expect(initialDiveState(false)).toEqual(IDLE);
    const step = reduceDive(initialDiveState(true), { type: 'close', route: overview, animate: true, push: true, target: room });
    expect(step.state).toMatchObject({ phase: 'exiting', target: room });
    expect(step.effects).toContainEqual({ type: 'camera', move: { kind: 'cover', point: room } });
  });

  it('Back/Forward (immediate) opens a screen at once, even in the middle of a dive or an exit', () => {
    const { controller, commits } = setup();
    controller.send({ type: 'open', route: knowledge, target: library, animate: true, push: true });
    vi.advanceTimersByTime(100);
    controller.send({ type: 'open', route: { view: 'agents' }, target: null, animate: true, push: false, immediate: true });
    expect(controller.state.phase).toBe('inside');
    expect(commits).toEqual([{ route: { view: 'agents' }, push: false }]);
    vi.advanceTimersByTime(5000);
    expect(commits).toHaveLength(1); // the cancelled dive never lands
    controller.send({ type: 'close', route: overview, animate: true, push: true });
    controller.send({ type: 'open', route: knowledge, target: library, animate: true, push: false, immediate: true });
    expect(controller.state.phase).toBe('inside');
    vi.advanceTimersByTime(5000);
    expect(commits).toEqual([{ route: { view: 'agents' }, push: false }, { route: knowledge, push: false }]);
  });

  it('switches screen to screen without a dive, but dives from the rooms directory into a room', () => {
    const { controller, commits, moves } = setup(insideState(null));
    controller.send({ type: 'open', route: knowledge, target: library, animate: true, push: true });
    expect(controller.state).toMatchObject({ phase: 'inside', target: library });
    expect(commits).toEqual([{ route: knowledge, push: true }]);
    expect(moves).toEqual([]);
    const roomRoute: Route = { view: 'rooms', roomId: 'r1' };
    controller.send({ type: 'open', route: roomRoute, target: room, animate: true, push: true, redive: true });
    // The directory is hidden (no history entry), then the dive runs and the room is pushed.
    expect(commits.at(-1)).toEqual({ route: overview, push: false });
    expect(controller.state).toMatchObject({ phase: 'focusing', fromScreen: true });
    vi.advanceTimersByTime(DIVE_TIMINGS.focusMs + DIVE_TIMINGS.diveMs);
    expect(commits.at(-1)).toEqual({ route: roomRoute, push: true });
  });

  it('cancelling a dive that started from the directory makes the city official in the history', () => {
    const { controller, commits } = setup(insideState(null));
    controller.send({ type: 'open', route: { view: 'rooms', roomId: 'r1' }, target: room, animate: true, push: true, redive: true });
    controller.send({ type: 'close', route: overview, animate: true, push: true });
    expect(commits).toEqual([{ route: overview, push: false }, { route: overview, push: true }]);
  });

  it('dispose clears the pending timer', () => {
    const { controller, commits } = setup();
    controller.send({ type: 'open', route: knowledge, target: library, animate: true, push: true });
    controller.dispose();
    vi.advanceTimersByTime(5000);
    expect(commits).toEqual([]);
  });
});
