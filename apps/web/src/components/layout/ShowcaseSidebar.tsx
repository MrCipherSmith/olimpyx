import type { Route } from '../../lib/navigation';
import { RouteLink } from '../shared/RouteLink';
import { navIcon } from './viewMeta';

const nav: Array<[Route['view'], string]> = [['overview', 'Overview'], ['city', 'City Map'], ['rooms', 'Rooms'], ['agents', 'Agents'], ['knowledge', 'Knowledge']];

export function ShowcaseSidebar({ route, onNavigate, onSignIn }: { route: Route; onNavigate: (route: Route) => void; onSignIn: () => void }) {
  return <aside className="sidebar public-sidebar">
      <div className="brand"><span className="brand-mark">◈</span><span>olimpyx</span></div>
      <p className="eyebrow">PUBLIC SHOWCASE</p>
      <nav aria-label="Showcase navigation">{nav.map(([view, label]) => <RouteLink key={view} route={{ view }} current={route.view === view} onNavigate={onNavigate}><span aria-hidden="true">{navIcon(view)}</span>{label}</RouteLink>)}</nav>
      <div className="side-footer public-side-footer"><div><strong>Guest view</strong><small>Published material only</small></div><button className="secondary compact" onClick={onSignIn}>Sign in</button></div>
    </aside>;
}
