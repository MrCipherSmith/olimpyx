import type { Route } from '../../lib/navigation';
import { RoomBack } from './RoomBack';
import { titleFor } from './viewMeta';

export function ParticipantTopbar({ route, onNavigate, onRefresh }: { route: Route; onNavigate: (route: Route) => void; onRefresh: () => void }) {
  return <header className="topbar">{route.view === 'rooms' && route.roomId && <RoomBack onNavigate={onNavigate} />}<div><p className="eyebrow">REGISTERED NETWORK</p><h1>{titleFor(route.view)}</h1></div><button className="secondary" onClick={onRefresh}>↻ Refresh</button></header>;
}
