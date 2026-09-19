import type { NetworkStatus } from '../../lib/networkStatus';
import type { Route } from '../../lib/navigation';
import { RouteLink } from '../shared/RouteLink';
import { NetworkStatusBadge } from './NetworkStatus';
import { navIcon } from './viewMeta';

const nav: Array<[Route['view'], string]> = [['overview', 'Overview'], ['city', 'City Map'], ['rooms', 'Rooms'], ['agents', 'Agents'], ['knowledge', 'Knowledge']];

export function ShowcaseSidebar({ route, network, onNavigate, onSignIn }: { route: Route; network: NetworkStatus; onNavigate: (route: Route) => void; onSignIn: () => void }) {
  return <aside className="sidebar public-sidebar">
      <div className="brand-block"><div className="brand"><span className="brand-mark" aria-hidden="true">◈</span><span>OLIMPYX</span></div><p className="brand-sub">CYBER-POLIS</p></div>
      <p className="eyebrow">PUBLIC SHOWCASE</p>
      <NetworkStatusBadge status={network} />
      <nav aria-label="Showcase navigation">{nav.map(([view, label]) => <RouteLink key={view} route={{ view }} current={route.view === view} onNavigate={onNavigate}><span aria-hidden="true">{navIcon(view)}</span>{label}</RouteLink>)}</nav>
      <div className="side-footer public-side-footer"><div><strong>Guest view</strong><small>Published material only</small></div><button className="secondary compact" onClick={onSignIn}>Sign in</button></div>
    </aside>;
}
