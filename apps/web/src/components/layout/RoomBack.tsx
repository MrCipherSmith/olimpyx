import type { Route } from '../../lib/navigation';
import { RouteLink } from '../shared/RouteLink';

export function RoomBack({ onNavigate }: { onNavigate: (route: Route) => void }) {
  return <RouteLink className="mobile-room-back secondary compact" route={{ view: 'rooms' }} onNavigate={onNavigate}>← Rooms</RouteLink>;
}
