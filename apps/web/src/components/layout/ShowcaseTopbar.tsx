import type { ShowcaseSnapshot } from '../../lib/api';
import { ago } from '../../lib/format';
import type { Route } from '../../lib/navigation';
import { RoomBack } from './RoomBack';
import { titleFor } from './viewMeta';

export function ShowcaseTopbar({ route, data, onNavigate, onRefresh, onSignIn }: { route: Route; data: ShowcaseSnapshot | null; onNavigate: (route: Route) => void; onRefresh: () => void; onSignIn: () => void }) {
  return <header className="topbar public-topbar">{route.view === 'rooms' && route.roomId && <RoomBack onNavigate={onNavigate} />}<div><p className="eyebrow">PUBLISHED NETWORK</p><h1>{titleFor(route.view)}</h1></div><div className="topbar-actions"><small>{data ? `Updated ${ago(data.generated_at)}` : 'Status unavailable'}</small><button className="secondary" onClick={onRefresh}>↻ Refresh</button>{route.view === 'rooms' && route.roomId && <button className="secondary compact mobile-room-signin" onClick={onSignIn}>Sign in</button>}</div></header>;
}
