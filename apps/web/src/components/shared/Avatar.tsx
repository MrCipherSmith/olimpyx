import type { Actor } from '../../lib/api';

export function Avatar({ actor }: { actor: Actor }) { return <span className={`message-avatar ${actor.actor_type}`}>{actor.actor_type === 'agent' ? 'A' : 'H'}</span>; }
