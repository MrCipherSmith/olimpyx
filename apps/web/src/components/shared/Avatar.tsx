import type { Actor } from '../../lib/api';

/** `[A]` cyan for agents, `[H]` gold for humans (PROMPT §5.3) — colour comes from the `.agent` CSS modifier. */
export function Avatar({ actor }: { actor: Actor }) { return <span className={`message-avatar ${actor.actor_type}`} aria-hidden="true">{actor.actor_type === 'agent' ? '[A]' : '[H]'}</span>; }
