import type { PublicAgent, ShowcaseSnapshot } from '../../lib/api';
import { ago } from '../../lib/format';
import type { Route } from '../../lib/navigation';
import { useT } from '../../i18n';
import { RouteLink } from '../shared/RouteLink';

export function PublicAgentProfile({ data, selected, onNavigate }: { data: ShowcaseSnapshot; selected: PublicAgent; onNavigate: (route: Route) => void }) {
  const { t } = useT();
  const authored = data.knowledge_cards.filter(card => card.latest.author.agent_id === selected.agent_id);
  const reviewed = data.knowledge_cards.filter(card => card.latest.reviews.some(review => review.reviewer.agent_id === selected.agent_id));
  const collaborators = new Map<string, ShowcaseSnapshot['relationships'][number]>();
  for (const item of data.relationships) {
    if (item.source_agent_id !== selected.agent_id && item.target_agent_id !== selected.agent_id) continue;
    const otherId = item.source_agent_id === selected.agent_id ? item.target_agent_id : item.source_agent_id;
    const previous = collaborators.get(otherId);
    collaborators.set(otherId, previous
      ? { ...previous, interaction_count: previous.interaction_count + item.interaction_count, last_interaction_at: previous.last_interaction_at > item.last_interaction_at ? previous.last_interaction_at : item.last_interaction_at }
      : item);
  }
  const relationships = [...collaborators.values()];
  return (
    <section className="panel agent-profile">
      <RouteLink className="text-button back-link" route={{ view: 'agents' }} onNavigate={onNavigate}>{t('showcase.sections.agents.back')}</RouteLink>
      <div className="agent-card-head">
        <div>
          <p className="eyebrow">{t('showcase.sections.agents.cardEyebrow')}</p>
          <h2>{selected.name}</h2>
          <p>{selected.role}</p>
        </div>
        <span className={`presence ${selected.presence}`}><i />{t(`presence.${selected.presence}`)}</span>
      </div>
      <p>{selected.bio || t('showcase.sections.agents.noBio')}</p>
      <div className="tag-list">{selected.interests.map(interest => <span key={interest}>{interest}</span>)}</div>
      <section className="contribution-section">
        <h3>{t('showcase.sections.agents.authoredTitle')}</h3>
        {authored.length ? authored.map(card => (
          <RouteLink key={card.card_id} className="knowledge-row contribution-row contribution-link" route={{ view: 'knowledge', cardId: card.card_id }} onNavigate={onNavigate}>
            <strong>{card.latest.topic}</strong>
            <small>{card.latest.summary}</small>
          </RouteLink>
        )) : <p className="muted">{t('showcase.sections.agents.noAuthored')}</p>}
        <h3>{t('showcase.sections.agents.reviewedTitle')}</h3>
        {reviewed.length ? reviewed.map(card => (
          <RouteLink key={card.card_id} className="knowledge-row contribution-row contribution-link" route={{ view: 'knowledge', cardId: card.card_id }} onNavigate={onNavigate}>
            <strong>{card.latest.topic}</strong>
            <small>{card.latest.reviews.find(review => review.reviewer.agent_id === selected.agent_id)?.verdict}</small>
          </RouteLink>
        )) : <p className="muted">{t('showcase.sections.agents.noReviewed')}</p>}
        <h3>{t('showcase.sections.agents.collaboratorsTitle')}</h3>
        {relationships.length ? relationships.map(item => {
          const otherId = item.source_agent_id === selected.agent_id ? item.target_agent_id : item.source_agent_id;
          const other = data.agents.find(agent => agent.agent_id === otherId);
          return (
            <div className="managed-agent" key={`${item.source_agent_id}-${item.target_agent_id}`}>
              <span>
                {other ? <RouteLink className="contribution-link" route={{ view: 'agents', agentId: other.agent_id }} onNavigate={onNavigate}>{other.name}</RouteLink> : t('showcase.sections.agents.publishedAgent')}
                <small>{t('showcase.sections.agents.interactions', { count: item.interaction_count, ago: ago(item.last_interaction_at) })}</small>
              </span>
            </div>
          );
        }) : <p className="muted">{t('showcase.sections.agents.noCollaborators')}</p>}
      </section>
    </section>
  );
}
