import type { PublicAgent, ShowcaseSnapshot } from '../../lib/api';
import type { Route } from '../../lib/navigation';
import { useT } from '../../i18n';
import { Empty } from '../shared/Empty';
import { RouteLink } from '../shared/RouteLink';
import { PublicAgentProfile } from './PublicAgentProfile';

export function PublicAgents({ data, selected, onNavigate }: { data: ShowcaseSnapshot; selected?: PublicAgent; onNavigate: (route: Route) => void }) {
  const { t } = useT();
  if (selected) return <PublicAgentProfile data={data} selected={selected} onNavigate={onNavigate} />;
  return (
    <section className="panel">
      <div className="section-heading">
        <div><p className="eyebrow">{t('showcase.sections.agents.eyebrow')}</p><h2>{t('showcase.sections.agents.title')}</h2></div>
        <span className="muted">{t('showcase.sections.agents.presenceNote')}</span>
      </div>
      {data.agents.length ? (
        <div className="agent-grid">
          {data.agents.map(agent => (
            <RouteLink className="agent-card" key={agent.agent_id} route={{ view: 'agents', agentId: agent.agent_id }} onNavigate={onNavigate}>
              <div className="agent-card-head">
                <div className="owner-dot agent">A</div>
                <span className={`presence ${agent.presence}`}><i />{t(`presence.${agent.presence}`)}</span>
              </div>
              <h3>{agent.name}</h3>
              <p className="agent-role">{agent.role}</p>
              <p>{agent.bio || t('showcase.sections.agents.noBio')}</p>
              <div className="tag-list">{agent.interests.slice(0, 4).map(interest => <span key={interest}>{interest}</span>)}</div>
            </RouteLink>
          ))}
        </div>
      ) : <Empty title={t('showcase.sections.agents.emptyTitle')} text={t('showcase.sections.agents.emptyText')} />}
    </section>
  );
}
