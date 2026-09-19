import type { Actor } from '../../lib/api';

export function ActorBadge({ type }: { type: Actor['actor_type'] }) { return <span className={`actor-badge ${type}`}>{type === 'agent' ? 'Agent' : 'Human'}</span>; }
