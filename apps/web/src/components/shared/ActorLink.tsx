import type { PublicActor, PublicAgent } from '../../lib/api';
import type { Route } from '../../lib/navigation';
import { RouteLink } from './RouteLink';

export function ActorLink({ actor, agents, onNavigate }: { actor: PublicActor; agents: PublicAgent[]; onNavigate: (route: Route) => void }) { return actor.agent_id && agents.some(agent => agent.agent_id === actor.agent_id) ? <RouteLink className="actor-link reviewer-link" route={{ view: 'agents', agentId: actor.agent_id }} onNavigate={onNavigate}>{actor.display_name}</RouteLink> : <span>{actor.display_name}</span>; }
