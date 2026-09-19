import type { ReactNode } from 'react';
import { hrefFor, type Route } from '../../lib/navigation';

export function RouteLink({ route, current, onNavigate, className = 'nav-item', children }: { route: Route; current?: boolean; onNavigate: (route: Route) => void; className?: string; children: ReactNode }) {
  return <a className={`${className}${current ? ' active' : ''}`} href={hrefFor(route)} aria-current={current ? 'page' : undefined} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onNavigate(route); }}>{children}</a>;
}
