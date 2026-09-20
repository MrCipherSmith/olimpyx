import { useState } from 'react';
import type { PublicKnowledgeCard, ShowcaseSnapshot } from '../../lib/api';
import { ago } from '../../lib/format';
import type { Route } from '../../lib/navigation';
import { useT } from '../../i18n';
import { ActorLink } from '../shared/ActorLink';
import { Empty } from '../shared/Empty';
import { RouteLink } from '../shared/RouteLink';
import { SourceLink } from '../shared/SourceLink';
import { StatusBadge } from '../shared/StatusBadge';

export function PublicKnowledge({ data, selected, onNavigate }: { data: ShowcaseSnapshot; selected?: PublicKnowledgeCard; onNavigate: (route: Route) => void }) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const matches = data.knowledge_cards.filter(card => `${card.latest.topic} ${card.latest.summary} ${card.latest.body}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="split-layout knowledge-layout">
      <section className="panel room-list">
        <div className="section-heading"><div><p className="eyebrow">{t('showcase.sections.knowledge.sectionEyebrow')}</p><h2>{t('showcase.sections.knowledge.sectionTitle')}</h2></div></div>
        <label>{t('showcase.sections.knowledge.filterLabel')}<input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('showcase.sections.knowledge.filterPlaceholder')} /></label>
        {matches.length ? matches.map(card => (
          <RouteLink className="knowledge-row" current={selected?.card_id === card.card_id} key={card.card_id} route={{ view: 'knowledge', cardId: card.card_id }} onNavigate={onNavigate}>
            <StatusBadge status={card.latest.status} />
            <span><strong>{card.latest.topic}</strong><small>{card.latest.summary}</small></span>
            <time>v{card.latest.version}</time>
          </RouteLink>
        )) : <p className="muted">{data.knowledge_cards.length ? t('showcase.sections.knowledge.noMatches') : t('showcase.sections.knowledge.empty')}</p>}
      </section>
      <section className="panel card-detail">
        {selected ? <>
          <div className="section-heading"><div><p className="eyebrow">{t('showcase.sections.knowledge.cardEyebrow')}</p><h2>{selected.latest.topic}</h2></div><StatusBadge status={selected.latest.status} /></div>
          <p className="lead">{selected.latest.summary}</p>
          <p className="card-body">{selected.latest.body}</p>
          {selected.latest.sources.length > 0 && (
            <section className="revision-section">
              <h3>{t('showcase.sections.knowledge.sourcesTitle')}</h3>
              <ul>{selected.latest.sources.map(source => <li key={source.url}><SourceLink url={source.url} label={source.title} /></li>)}</ul>
            </section>
          )}
          <div className="detail-meta">
            <span>{t('showcase.sections.knowledge.versionLabel', { version: selected.latest.version })}</span>
            <span>{t('showcase.sections.knowledge.authoredByLabel')} <ActorLink actor={selected.latest.author} agents={data.agents} onNavigate={onNavigate} /></span>
            <span>{t('showcase.sections.knowledge.confirmsRefutesLabel', { confirm: selected.latest.review_counts.confirm, refute: selected.latest.review_counts.refute })}</span>
          </div>
          <section className="revision-section">
            <h3>{t('showcase.sections.knowledge.reviewsTitle')}</h3>
            {selected.latest.reviews.length ? selected.latest.reviews.map(review => (
              <div className="revision" key={review.review_id}>
                <StatusBadge status={review.verdict} />
                <span>
                  <strong><ActorLink actor={review.reviewer} agents={data.agents} onNavigate={onNavigate} /></strong>
                  <p>{review.explanation}</p>
                  {review.evidence.length > 0 && <ul>{review.evidence.map(source => <li key={source.url}><SourceLink url={source.url} label={source.title} /></li>)}</ul>}
                  <small>{ago(review.created_at)}</small>
                </span>
              </div>
            )) : <p className="muted">{t('showcase.sections.knowledge.noPublicReviews')}</p>}
          </section>
          <p className="permission-note">{t('showcase.sections.knowledge.permissionNote')}</p>
        </> : <Empty title={t('showcase.sections.knowledge.chooseTitle')} text={t('showcase.sections.knowledge.chooseText')} />}
      </section>
    </div>
  );
}
