/**
 * The dive / back transition (PROMPT §4) as a pure state machine plus a tiny timer-driven controller.
 *
 *   idle ──open──▶ focusing ──650ms──▶ diving ──550ms──▶ inside ──close──▶ exiting ──300ms──▶ (city shown) ──650ms──▶ idle
 *
 * - focusing: the camera glides to the building roof at zoom 1.65 and the target lock appears;
 * - diving: zoom to 6.5 on the same point under the "/// INITIATING PACKET DIVE ///" overlay;
 * - inside: the route is committed (URL + screen) and the screen layer is shown;
 * - exiting (covered): the overlay hides the screen; then the route is committed, the screen goes away and
 *   the camera zooms back out (covered = false) until the machine is idle again.
 *
 * Without animation (reduced motion, phones, a city that is not drawn) a screen opens and closes at once.
 * Deep links and browser Back/Forward (`immediate`) always open at once, whatever the machine is doing.
 * Any other request during a transition is ignored, except a close during focusing/diving, which cancels
 * the dive and returns the camera, and a browser Back during the exit, which only drops the pending push. Effects are returned as data; DiveController executes them.
 */
import type { DiveCameraMove, DivePoint } from '../city/cameraMath';
import type { Route } from '../../lib/navigation';

export const DIVE_TIMINGS = { focusMs: 650, diveMs: 550, coverMs: 300, returnMs: 650 } as const;

export type DivePhase = 'idle' | 'focusing' | 'diving' | 'inside' | 'exiting';

/** What the camera dives into: a building (or the forum centre) with a display name for the overlay. */
export interface DiveTarget extends DivePoint {
  /** Building id in the scene (`library`, `room:<id>`…), or `forum` for the plaza itself. */
  key: string;
  name: string;
  subline: string;
}

export interface DiveCommit { route: Route; push: boolean; }

export interface DiveState {
  phase: DivePhase;
  target: DiveTarget | null;
  /** exiting only: true while the overlay still covers the screen. */
  covered: boolean;
  /** The route committed when the dive lands or the exit uncovers the city. */
  pending: DiveCommit | null;
  /** The dive started from an open screen (rooms directory → room): that screen was hidden first. */
  fromScreen: boolean;
}

export type DiveEvent =
  | {
    type: 'open'; route: Route; target: DiveTarget | null; animate: boolean; push: boolean;
    /** Deep link or Back/Forward: open now, cancelling any transition. */
    immediate?: boolean;
    /** From the rooms directory into a room: hide the directory and dive into the room's building. */
    redive?: boolean;
  }
  | {
    type: 'close'; route: Route; animate: boolean; push: boolean; immediate?: boolean;
    /** The building of the open screen, used when the screen was opened without a dive (deep link). */
    target?: DiveTarget | null;
  }
  | { type: 'tick' };

export type DiveEffect =
  | { type: 'commit'; commit: DiveCommit }
  | { type: 'camera'; move: DiveCameraMove }
  | { type: 'schedule'; ms: number };

export const IDLE: DiveState = { phase: 'idle', target: null, covered: false, pending: null, fromScreen: false };

export function insideState(target: DiveTarget | null): DiveState {
  return { phase: 'inside', target, covered: false, pending: null, fromScreen: false };
}

/** Initial state: a deep link to a screen starts inside, with no dive. */
export function initialDiveState(screenOpen: boolean): DiveState {
  return screenOpen ? insideState(null) : IDLE;
}

interface Step { state: DiveState; effects: DiveEffect[]; }

const commit = (route: Route, push: boolean): DiveEffect => ({ type: 'commit', commit: { route, push } });
const camera = (move: DiveCameraMove): DiveEffect => ({ type: 'camera', move });
const schedule = (ms: number): DiveEffect => ({ type: 'schedule', ms });
const OVERVIEW: Route = { view: 'overview' };

export function reduceDive(state: DiveState, event: DiveEvent): Step {
  const ignore: Step = { state, effects: [] };
  switch (event.type) {
    case 'open': {
      const openNow: Step = { state: insideState(event.target ?? (state.phase === 'inside' ? state.target : null)), effects: [commit(event.route, event.push), camera({ kind: 'hold' })] };
      if (event.immediate) return openNow;
      const dive = (fromScreen: boolean): Step => ({
        state: { phase: 'focusing', target: event.target, covered: false, pending: { route: event.route, push: event.push }, fromScreen },
        effects: [
          ...(fromScreen ? [commit(OVERVIEW, false)] : []),
          camera({ kind: 'focus', point: event.target!, ms: DIVE_TIMINGS.focusMs }),
          schedule(DIVE_TIMINGS.focusMs),
        ],
      });
      switch (state.phase) {
        case 'idle': return event.animate && event.target ? dive(false) : openNow;
        // Screen → screen: no dive, except the rooms directory handing over to a room.
        case 'inside': return event.redive && event.animate && event.target ? dive(true)
          : { state: insideState(event.target ?? state.target), effects: [commit(event.route, event.push)] };
        default: return ignore; // no re-entry while a transition runs
      }
    }
    case 'close': {
      const closeNow: Step = { state: IDLE, effects: [commit(event.route, event.push), camera({ kind: 'return', ms: 0 })] };
      if (event.immediate) return closeNow;
      switch (state.phase) {
        case 'idle': return { state: IDLE, effects: [commit(event.route, event.push)] };
        case 'inside': {
          if (!event.animate) return closeNow;
          const target = state.target ?? event.target ?? null;
          return {
            state: { phase: 'exiting', target, covered: true, pending: { route: event.route, push: event.push }, fromScreen: false },
            effects: [camera({ kind: 'cover', point: target }), schedule(DIVE_TIMINGS.coverMs)],
          };
        }
        case 'focusing':
        case 'diving': {
          // Escape / Back during the dive cancels it. The route was never committed, unless the dive
          // started from a screen that is already hidden (then the city is made official) or the request
          // came from the browser history (the URL already changed: commit it, never push on top of it).
          const reconcile = state.fromScreen || !event.push ? [commit(event.route, event.push)] : [];
          return { state: IDLE, effects: [...reconcile, camera({ kind: 'return', ms: event.animate ? DIVE_TIMINGS.returnMs : 0 })] };
        }
        case 'exiting':
          // Browser Back while the overlay still covers the screen: the URL already moved, so the pending
          // commit must not push. The exit keeps running on its timer. Any other close is ignored.
          return !event.push && state.pending
            ? { state: { ...state, pending: { route: event.route, push: false } }, effects: [] }
            : ignore;
        default: return ignore;
      }
    }
    case 'tick': {
      switch (state.phase) {
        case 'focusing': return {
          state: { ...state, phase: 'diving' },
          effects: [camera({ kind: 'dive', point: state.target!, ms: DIVE_TIMINGS.diveMs }), schedule(DIVE_TIMINGS.diveMs)],
        };
        case 'diving': return { state: insideState(state.target), effects: state.pending ? [commit(state.pending.route, state.pending.push)] : [] };
        case 'exiting': return state.covered
          ? {
            state: { ...state, covered: false, pending: null },
            effects: [...(state.pending ? [commit(state.pending.route, state.pending.push)] : []), camera({ kind: 'return', ms: DIVE_TIMINGS.returnMs }), schedule(DIVE_TIMINGS.returnMs)],
          }
          : { state: IDLE, effects: [] };
        default: return ignore;
      }
    }
  }
}

export interface DiveIo {
  commit: (commit: DiveCommit) => void;
  camera: (move: DiveCameraMove) => void;
}

/**
 * Runs the machine: executes effects in order and owns the single pending timer. Any phase change clears
 * the previous timer, so a cancelled dive can never fire a stale tick.
 */
export class DiveController {
  private current: DiveState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(state: DiveState) => void>();

  constructor(initial: DiveState, private readonly io: DiveIo) { this.current = initial; }

  get state(): DiveState { return this.current; }

  send(event: DiveEvent): void {
    const { state, effects } = reduceDive(this.current, event);
    if (state === this.current && !effects.length) return;
    // A phase change (or a new schedule) makes the pending tick stale; an update within the same phase
    // (exiting: Back turns the pending push into a plain commit) keeps the running timer.
    const stale = state.phase !== this.current.phase || effects.some(effect => effect.type === 'schedule');
    if (stale && this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.current = state;
    for (const effect of effects) {
      if (effect.type === 'commit') this.io.commit(effect.commit);
      else if (effect.type === 'camera') this.io.camera(effect.move);
      else this.timer = setTimeout(() => { this.timer = null; this.send({ type: 'tick' }); }, effect.ms);
    }
    this.listeners.forEach(listener => listener(state));
  }

  subscribe(listener: (state: DiveState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}
