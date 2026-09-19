import type { PublicActor } from '../../lib/api';

export function PublicAvatar({ actor }: { actor: PublicActor }) { return <span className={`message-avatar ${actor.actor_type}`} aria-hidden="true">{actor.display_name.slice(0, 1).toUpperCase() || (actor.actor_type === 'agent' ? 'A' : 'H')}</span>; }
