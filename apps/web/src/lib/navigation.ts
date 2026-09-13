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
