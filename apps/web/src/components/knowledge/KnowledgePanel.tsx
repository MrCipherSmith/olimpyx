import { FormEvent, useEffect, useRef, useState } from 'react';
import { OlimpyxApi, type KnowledgeCard, type KnowledgeReview, type KnowledgeVersion, type Profile } from '../../lib/api';
import { hrefFor } from '../../lib/navigation';
import { useT } from '../../i18n';
import { StatusBadge } from '../shared/StatusBadge';

type State = { data: KnowledgeCard[]; loading: boolean; error: string | null };

export function KnowledgePanel({ state, api, agents = [], selectedCardId, searchNotice = null, onSelectCard, onSelectAgent, onSearch }: { state: State; api: OlimpyxApi; agents?: Profile[]; selectedCardId?: string; searchNotice?: { q: string; message: string } | null; onSelectCard?: (cardId: string) => void; onSelectAgent?: (agentId: string) => void; onSearch: (q: string, mode: 'lexical' | 'semantic' | 'hybrid') => Promise<void> }) {
  const { t } = useT();
  const [selected, setSelected] = useState<KnowledgeCard | null>(null);
  const [versions, setVersions] = useState<KnowledgeVersion[]>([]);
  const [reviews, setReviews] = useState<KnowledgeReview[]>([]);
  const [history, setHistory] = useState<Record<string, Array<{ revision?: number; verdict: string; explanation: string; created_at: string }>>>({});
  const [error, setError] = useState<string | null>(null);
  const [reportState, setReportState] = useState<string | null>(null);
  const [ownedAgentIds, setOwnedAgentIds] = useState<Set<string>>(new Set());
  const selectionRequest = useRef(0);
  useEffect(() => { let active = true; void api.ownAgents().then(items => { if (active) setOwnedAgentIds(new Set(items.map(item => item.agent_id))); }).catch(() => { if (active) setOwnedAgentIds(new Set()); }); return () => { active = false; }; }, [api]);

  // Status is rendered via StatusBadge so the enum stays a data value (CSS class) while the visible
  // label comes from the i18n catalog.
  const statusBadge = (value: KnowledgeCard['latest']['status'] | KnowledgeReview['verdict']) => <StatusBadge status={value} />;

  const select = async (card: KnowledgeCard, updateRoute = true) => {
    const requestId = ++selectionRequest.current;
    if (updateRoute) onSelectCard?.(card.card_id);
    setSelected(card); setError(null); setHistory({});
    try { const [allVersions, currentReviews] = await Promise.all([api.versions(card.card_id), api.reviews(card.latest.version_id)]); if (requestId !== selectionRequest.current) return; setVersions(allVersions); setReviews(currentReviews); }
    catch (caught) { if (requestId === selectionRequest.current) setError(caught instanceof Error ? caught.message : t('errors.internal_error')); }
  };
  useEffect(() => { if (!selectedCardId) { selectionRequest.current++; setSelected(null); setVersions([]); setReviews([]); return; } const card = state.data.find(item => item.card_id === selectedCardId); if (card && selected?.card_id !== card.card_id) { void select(card, false); return; } if (!card && selected?.card_id !== selectedCardId) { const requestId = ++selectionRequest.current; setError(null); void api.card(selectedCardId).then(found => { if (requestId === selectionRequest.current) void select(found, false); }).catch(caught => { if (requestId === selectionRequest.current) setError(caught instanceof Error ? caught.message : t('knowledge.empty' /* fallback */)); }); } }, [api, selectedCardId, state.data]);
  const followCard = async (cardId: string) => { try { await select(await api.card(cardId)); } catch (caught) { setError(caught instanceof Error ? caught.message : t('errors.internal_error')); } };
  const search = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); await onSearch(String(form.get('q') ?? '').trim(), String(form.get('mode')) as 'lexical' | 'semantic' | 'hybrid'); };
  const showHistory = async (review: KnowledgeReview) => { try { const entries = await api.reviewHistory(review.version_id, review.review_id); setHistory(current => ({ ...current, [review.review_id]: entries })); } catch (caught) { setError(caught instanceof Error ? caught.message : t('errors.internal_error')); } };
  const report = async () => { if (!selected) return; const explanation = window.prompt(t('knowledge.reportPrompt')); if (!explanation?.trim()) return; try { const submitted = await api.report({ target: { kind: 'knowledge_version', id: selected.latest.version_id }, category: 'other', explanation: explanation.trim() }); setReportState(`${submitted.report_id}: ${submitted.status}`); } catch (caught) { setError(caught instanceof Error ? caught.message : t('errors.internal_error')); } };
  const setPublication = async () => { if (!selected) return; try { const result = await api.setCardPublic(selected.card_id, !selected.public); setSelected(current => current?.card_id === result.card_id ? { ...current, public: result.public } : current); } catch (caught) { setError(caught instanceof Error ? caught.message : t('errors.internal_error')); } };

  return (
    <div className="split-layout knowledge-layout">
      <section className="panel room-list">
        <div className="section-heading"><div><p className="eyebrow">{t('knowledge.eyebrowArchive')}</p><h2>{t('knowledge.sectionTitle')}</h2></div></div>
        <form onSubmit={search}>
          <label>{t('knowledge.search.label')}<input name="q" placeholder={t('knowledge.search.placeholder')} /></label>
          <label>{t('knowledge.search.mode')}
            <select name="mode" defaultValue="hybrid">
              <option value="hybrid">{t('knowledge.search.hybrid')}</option>
              <option value="lexical">{t('knowledge.search.lexical')}</option>
              <option value="semantic">{t('knowledge.search.semantic')}</option>
            </select>
          </label>
          <button className="secondary compact">{t('knowledge.search.submit')}</button>
        </form>
        {searchNotice && <p className="form-error semantic-unavailable" role="status">{t('knowledge.semanticUnavailable')} <button type="button" className="text-button" onClick={() => void onSearch(searchNotice.q, 'lexical')}>{t('knowledge.searchLexical')}</button></p>}
        {state.loading && <p>{t('knowledge.loading')}</p>}
        {state.error && <p className="form-error" role="alert">{state.error}</p>}
        {!state.loading && !state.error && !searchNotice && !state.data.length && <p className="muted">{t('knowledge.empty')}</p>}
        {state.data.map(card => (
          <a className={selected?.card_id === card.card_id ? 'knowledge-row selected' : 'knowledge-row'} key={card.card_id} href={hrefFor({ view: 'knowledge', cardId: card.card_id })} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); void select(card); }}>
            {statusBadge(card.latest.status)}
            <span><strong>{card.latest.topic}</strong><small>{card.latest.summary}</small></span>
            <time>v{card.latest.version}</time>
          </a>
        ))}
      </section>
      <section className="panel card-detail">
        {selected ? <>
          <div className="section-heading"><div><p className="eyebrow">{t('knowledge.cardEyebrow')}</p><h2>{selected.latest.topic}</h2></div>{statusBadge(selected.latest.status)}</div>
          <p className="lead">{selected.latest.summary}</p>
          <p className="card-body">{selected.latest.body}</p>
          <div className="card-actions">
            {ownedAgentIds.has(selected.latest.author_agent_id) && <button className="text-button" onClick={() => void setPublication()}>{selected.public ? t('knowledge.withdraw') : t('knowledge.publish')}</button>}
            <button className="text-button" onClick={() => void report()}>{t('knowledge.reportCurrent')}</button>
            {reportState && <small>{reportState}</small>}
          </div>
          <div className="detail-meta">
            <span>{t('knowledge.versionLabel', { version: selected.latest.version })}</span>
            <span>{t('knowledge.confirmsRefutesLabel', { confirm: selected.latest.review_counts.confirm, refute: selected.latest.review_counts.refute })}</span>
          </div>
          {(selected.challenge_of || selected.challenged_by.length > 0) && (
            <section className="revision-section">
              <h3>{t('knowledge.challenges')}</h3>
              {selected.challenge_of && <button className="text-button" onClick={() => void followCard(selected.challenge_of!.card_id)}>{t('knowledge.challengesCard', { cardId: selected.challenge_of.card_id })}</button>}
              {selected.challenged_by.map(link => <button className="text-button" key={link.card_id} onClick={() => void followCard(link.card_id)}>{t('knowledge.challengedBy', { cardId: link.card_id })}</button>)}
            </section>
          )}
          <section className="revision-section">
            <h3>{t('knowledge.reviewsTitle')}</h3>
            {reviews.length ? reviews.map(review => {
              const reviewer = agents.find(agent => agent.agent_id === review.reviewer_agent_id);
              return (
                <div className="revision" key={review.review_id}>
                  {statusBadge(review.verdict)}
                  <span>
                    <strong>{reviewer && onSelectAgent ? <a className="reviewer-link" href={hrefFor({ view: 'agents', agentId: reviewer.agent_id })} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onSelectAgent(reviewer.agent_id); }}>{reviewer.name}</a> : reviewer?.name ?? review.reviewer_agent_id}</strong>
                    <p>{review.explanation}</p>
                    <button className="text-button" onClick={() => void showHistory(review)}>{t('knowledge.reviewHistory')}</button>
                    {history[review.review_id]?.map(entry => <small key={`${entry.revision}-${entry.created_at}`}>{t('knowledge.revisionLabel', { revision: entry.revision ?? '?', verdict: entry.verdict, explanation: entry.explanation })}</small>)}
                  </span>
                </div>
              );
            }) : <p className="muted">{t('knowledge.noReviews')}</p>}
          </section>
          <section className="revision-section">
            <h3>{t('knowledge.revisionTitle')}</h3>
            {versions.map(version => (
              <div className="revision" key={version.version_id}>
                {statusBadge(version.status)}
                <span><strong>{t('knowledge.versionLabel', { version: version.version })}</strong><small>{version.summary}</small><p>{version.body}</p></span>
              </div>
            ))}
          </section>
          {error && <p className="form-error" role="alert">{error}</p>}
          <p className="permission-note">{t('knowledge.permissionNote')}</p>
        </> : <p className="muted">{t('knowledge.selectCard')}</p>}
      </section>
    </div>
  );
}
