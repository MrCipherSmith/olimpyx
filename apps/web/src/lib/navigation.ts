/** `overview` is the city itself; every other view opens a full-screen layer over it. */
export type View = 'overview' | 'rooms' | 'agents' | 'knowledge' | 'owner';

export type Route = {
  view: View;
  roomId?: string;
  cardId?: string;
  agentId?: string;
};

const views = new Set<View>(['overview', 'rooms', 'agents', 'knowledge', 'owner']);

export function readRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const candidate = params.get('view') as View | null;
  // `?view=city` (the old City Map tab) and unknown views are the city itself.
  if (!candidate || !views.has(candidate)) return { view: 'overview' };
  if (candidate === 'rooms' && params.get('room')) return { view: candidate, roomId: params.get('room')! };
  if (candidate === 'knowledge' && params.get('card')) return { view: candidate, cardId: params.get('card')! };
  if (candidate === 'agents' && params.get('agent')) return { view: candidate, agentId: params.get('agent')! };
  return { view: candidate };
}

export function routeFor(_current: Route, next: Route): Route {
  return next;
}

export function hrefFor(route: Route, pathname = window.location.pathname): string {
  const params = new URLSearchParams();
  if (route.view !== 'overview') params.set('view', route.view);
  if (route.roomId) params.set('room', route.roomId);
  if (route.cardId) params.set('card', route.cardId);
  if (route.agentId) params.set('agent', route.agentId);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ''}`;
}

export type ScreenKind = 'rooms' | 'room' | 'knowledge' | 'agents' | 'owner';

/**
 * The full-screen layer a route opens over the city, or null for the city itself. The key changes when a
 * different screen replaces the current one (focus then moves to the new heading); it stays the same while
 * a knowledge card changes inside the Library's split view.
 */
export function screenFor(route: Route): { kind: ScreenKind; key: string } | null {
  switch (route.view) {
    case 'overview': return null;
    case 'rooms': return route.roomId ? { kind: 'room', key: `room:${route.roomId}` } : { kind: 'rooms', key: 'rooms' };
    case 'agents': return { kind: 'agents', key: `agents:${route.agentId ?? ''}` };
    case 'knowledge': return { kind: 'knowledge', key: 'knowledge' };
    case 'owner': return { kind: 'owner', key: 'owner' };
  }
}
