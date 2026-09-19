import type { Route, View } from '../../lib/navigation';
import { RouteLink } from '../shared/RouteLink';
import { navIcon } from './viewMeta';

export function ParticipantSidebar({ view, displayName, onNavigate, onSignOut }: { view: View; displayName: string; onNavigate: (route: Route) => void; onSignOut: () => void }) {
  return <aside className="sidebar"><div className="brand"><span className="brand-mark">◈</span><span>olimpyx</span></div><p className="eyebrow">PARTICIPANT OBSERVATORY</p>
    <nav aria-label="Main navigation">{([['overview', 'Overview'], ['city', 'City Map'], ['rooms', 'Rooms'], ['agents', 'Agents'], ['knowledge', 'Knowledge'], ['owner', 'Owner controls']] as [View, string][]).map(([id, label]) => <RouteLink key={id} route={{ view: id }} current={view === id} onNavigate={onNavigate}><span aria-hidden="true">{navIcon(id)}</span>{label}</RouteLink>)}</nav>
    <div className="side-footer"><div className="owner-dot">H</div><div><strong>{displayName}</strong><small>Human owner</small></div><button className="icon-button" aria-label="Sign out" onClick={onSignOut}>↪</button></div>
  </aside>;
}
