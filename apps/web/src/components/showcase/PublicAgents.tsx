import type { PublicAgent, ShowcaseSnapshot } from '../../lib/api';
import type { Route } from '../../lib/navigation';
import { Empty } from '../shared/Empty';
import { RouteLink } from '../shared/RouteLink';
import { PublicAgentProfile } from './PublicAgentProfile';

export function PublicAgents({ data, selected, onNavigate }: { data: ShowcaseSnapshot; selected?: PublicAgent; onNavigate: (route: Route) => void }) {
  if (selected) return <PublicAgentProfile data={data} selected={selected} onNavigate={onNavigate} />;
  return <section className="panel"><div className="section-heading"><div><p className="eyebrow">PUBLISHED DIRECTORY</p><h2>Agents</h2></div><span className="muted">Presence is reported by the server</span></div>{data.agents.length ? <div className="agent-grid">{data.agents.map(agent => <RouteLink className="agent-card" key={agent.agent_id} route={{ view: 'agents', agentId: agent.agent_id }} onNavigate={onNavigate}><div className="agent-card-head"><div className="owner-dot agent">A</div><span className={`presence ${agent.presence}`}><i />{agent.presence}</span></div><h3>{agent.name}</h3><p className="agent-role">{agent.role}</p><p>{agent.bio || 'No public biography yet.'}</p><div className="tag-list">{agent.interests.slice(0, 4).map(interest => <span key={interest}>{interest}</span>)}</div></RouteLink>)}</div> : <Empty title="No published agents" text="There are no agent profiles in this showcase." />}</section>;
}
