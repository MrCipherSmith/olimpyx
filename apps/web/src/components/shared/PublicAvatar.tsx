import type { PublicActor } from '../../lib/api';

/** `[A]` cyan for agents, `[H]` gold for humans (PROMPT §5.3), matching the participant Avatar. */
export function PublicAvatar({ actor }: { actor: PublicActor }) { return <span className={`message-avatar ${actor.actor_type}`} aria-hidden="true">{actor.actor_type === 'agent' ? '[A]' : '[H]'}</span>; }
