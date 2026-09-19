import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { CityCameraController } from '../city/CityCanvas';
import { hrefFor, readRoute, screenFor, type Route } from '../../lib/navigation';
import { DiveController, initialDiveState, type DiveState } from './diveMachine';
import { diveTargetFor } from './diveTargets';
import { PHONE_QUERY, useMediaQuery, usePrefersReducedMotion } from './useMediaQuery';

interface CityRouteOptions {
  /** Current scene buildings: the dive targets. */
  buildings: Parameters<typeof diveTargetFor>[1];
  /** The city camera (CityView's `camera` prop); absent or not drawable ⇒ screens open without a dive. */
  camera: MutableRefObject<CityCameraController | null>;
  /** Rewrites routes the viewer may not open (a guest's `?view=owner` becomes the city). */
  normalize?: (route: Route) => Route;
}

export interface CityRoute {
  /** The displayed route: the open screen, or the city. It changes when a dive lands, not when it starts. */
  route: Route;
  /** User navigation: dives into the target building, or runs the exit back to the city. */
  navigate: (route: Route) => void;
  /** "← Back to the city", Escape. */
  close: () => void;
  /** Session change (sign in / out): go to the route at once, no transition. */
  reset: (route: Route) => void;
  dive: DiveState;
}

const identity = (route: Route) => route;
const currentRoute = () => readRoute(typeof window === 'undefined' ? '' : window.location.search);
const currentHref = () => `${window.location.pathname}${window.location.search}`;
const sameRoute = (a: Route, b: Route) => hrefFor(a, '') === hrefFor(b, '');

/** The route the viewer may open; a rewritten one (a guest's `?view=owner`) also replaces the URL. */
function readAllowedRoute(normalize: (route: Route) => Route): Route {
  const raw = currentRoute();
  const allowed = normalize(raw);
  if (typeof window !== 'undefined' && !sameRoute(raw, allowed)) window.history.replaceState(window.history.state, '', hrefFor(allowed));
  return allowed;
}

/**
 * The shell's route and history, with the dive transition in between (PROMPT §4). The URL is pushed when
 * the screen actually opens (the dive lands) or closes, so Back/Forward always mirror what is shown.
 * Deep links and Back/Forward open screens at once; closing from Back plays the exit when motion is allowed.
 */
export function useCityRoute({ buildings, camera, normalize = identity }: CityRouteOptions): CityRoute {
  const reducedMotion = usePrefersReducedMotion();
  const phone = useMediaQuery(PHONE_QUERY);
  const [route, setRoute] = useState<Route>(() => readAllowedRoute(normalize));
  const latest = useRef({ route, buildings, camera, normalize, reducedMotion, phone });
  latest.current = { ...latest.current, buildings, camera, normalize, reducedMotion, phone };

  const controllerRef = useRef<DiveController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new DiveController(initialDiveState(screenFor(route) !== null), {
      commit: ({ route: next, push }) => {
        // Never push the entry already shown (Overview on the city, a close after Back): Back must work.
        const href = hrefFor(next);
        if (push && href !== currentHref()) window.history.pushState(null, '', href);
        latest.current.route = next;
        setRoute(next);
      },
      camera: move => latest.current.camera.current?.dive(move),
    });
  }
  const controller = controllerRef.current;
  const [dive, setDive] = useState<DiveState>(controller.state);
  useEffect(() => controller.subscribe(setDive), [controller]);
  useEffect(() => () => controller.dispose(), [controller]);

  const animate = () => {
    const { reducedMotion: reduced, phone: narrow, camera: ref } = latest.current;
    return !reduced && !narrow && Boolean(ref.current?.canAnimate());
  };

  const go = useCallback((raw: Route, push: boolean, immediate: boolean) => {
    const { normalize: rewrite, buildings: current, route: shown } = latest.current;
    const next = rewrite(raw);
    const screen = screenFor(next);
    if (screen) {
      const redive = screenFor(shown)?.kind === 'rooms' && screen.kind === 'room';
      controller.send({ type: 'open', route: next, target: diveTargetFor(next, current), animate: animate(), push, immediate, redive });
    } else {
      controller.send({ type: 'close', route: next, target: diveTargetFor(shown, current), animate: !immediate && animate(), push, immediate });
    }
  }, [controller]);

  const navigate = useCallback((next: Route) => go(next, true, false), [go]);
  const close = useCallback(() => go({ view: 'overview' }, true, false), [go]);
  const reset = useCallback((next: Route) => go(next, true, true), [go]);

  // Back / Forward: the URL already changed; show what it says (screens at once, closing with the exit).
  useEffect(() => {
    const onPopState = () => {
      const next = readAllowedRoute(latest.current.normalize);
      go(next, false, screenFor(next) !== null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [go]);

  // Escape during the dive cancels it (once the screen is open, CityShell owns Escape).
  const diving = dive.phase === 'focusing' || dive.phase === 'diving';
  useEffect(() => {
    if (!diving) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) close(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [diving, close]);

  return { route, navigate, close, reset, dive };
}
