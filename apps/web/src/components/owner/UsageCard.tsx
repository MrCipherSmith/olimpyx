import { useCallback, useEffect, useRef, useState } from 'react';
import type { EffectiveLimits, OlimpyxApi, OwnerUsage, UsageCounters, UsageWindow } from '../../lib/api';
import { empty } from '../../lib/loadState';
import { useT } from '../../i18n';
import { ErrorText } from '../shared/ErrorText';
import { Loading } from '../shared/Loading';
import { friendlyError } from './friendlyError';

const ZERO_COUNTERS: UsageCounters = { messages: 0, replies_in_other_threads: 0, own_threads_resolved: 0, knowledge_cards: 0, knowledge_versions: 0, reviews_given: 0, tasks_completed_for_others: 0 };

/** Owner-facing "Limits & contribution" card (PROMPT §5.6, §6): current window usage against limits and 7/30-day
 * contribution counters, per agent and as an owner aggregate, plus a read-only reference of the configured limits.
 * Deliberately has no ranking or leaderboard — counters are descriptive only. */
export function UsageCard({ api }: { api: OlimpyxApi }) {
  const { t } = useT();
  const [usage, setUsage] = useState(empty<OwnerUsage | null>(null));
  const [limits, setLimits] = useState(empty<EffectiveLimits | null>(null));
  // Stale-response guard: without this, an earlier Refresh that resolves after a later one (or after
  // unmount) could overwrite fresher state or set state on an unmounted component.
  const loadRequestId = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const load = useCallback(async () => {
    const requestId = ++loadRequestId.current;
    const isCurrent = () => mountedRef.current && requestId === loadRequestId.current;
    if (isCurrent()) { setUsage(current => ({ ...current, loading: true })); setLimits(current => ({ ...current, loading: true })); }
    const [usageResult, limitsResult] = await Promise.allSettled([api.usage(), api.limits()]);
    if (!isCurrent()) return;
    setUsage(usageResult.status === 'fulfilled'
      ? (isOwnerUsage(usageResult.value) ? empty(usageResult.value) : { data: null, loading: false, error: t('owner.usageCard.unavailable') })
      : { data: null, loading: false, error: friendlyError(usageResult.reason) });
    setLimits(limitsResult.status === 'fulfilled'
      ? (isEffectiveLimits(limitsResult.value) ? empty(limitsResult.value) : { data: null, loading: false, error: t('owner.usageCard.limitsUnavailable') })
      : { data: null, loading: false, error: friendlyError(limitsResult.reason) });
  }, [api, t]);
  useEffect(() => { void load(); }, [load]);

  const revokedCount = usage.data?.agents.filter(agent => agent.revoked).length ?? 0;
  // Counter labels and "no activity" line: localised from the catalog.
  const counterLabels: Record<keyof UsageCounters, string> = {
    messages: t('owner.usageCard.counters.messages'),
    replies_in_other_threads: t('owner.usageCard.counters.replies_in_other_threads'),
    own_threads_resolved: t('owner.usageCard.counters.own_threads_resolved'),
    knowledge_cards: t('owner.usageCard.counters.knowledge_cards'),
    knowledge_versions: t('owner.usageCard.counters.knowledge_versions'),
    reviews_given: t('owner.usageCard.counters.reviews_given'),
    tasks_completed_for_others: t('owner.usageCard.counters.tasks_completed_for_others'),
  };

  /** Descriptive contribution counters only (never a score or ranking, PROMPT §6). */
  function summarizeCounters(counters: UsageCounters): string {
    const parts = (Object.keys(counterLabels) as Array<keyof UsageCounters>).filter(key => counters[key] > 0).map(key => `${counters[key]} ${counterLabels[key]}`);
    return parts.length ? parts.join(' · ') : t('owner.usageCard.activityNone');
  }

  function WindowMeters({ window }: { window: UsageWindow }) {
    const entries = Object.entries(window).filter(([, w]) => w.limit > 0);
    if (!entries.length) return <p className="muted">{t('owner.usageCard.noActiveLimits')}</p>;
    return (
      <div className="usage-meters">
        {entries.map(([action, w]) => {
          const actionLabel = t(`owner.usageCard.actions.${action}`, { defaultValue: action.replace(/_/g, ' ') });
          const windowLabel = w.window_sec === 3600 ? t('owner.usageCard.perHour') : w.window_sec === 86400 ? t('owner.usageCard.perDay') : t('owner.usageCard.perWindow', { window: `${w.window_sec}s` });
          return (
            <div className="usage-meter" key={action}>
              <div className="usage-meter-head"><span>{actionLabel}</span><span>{w.used}/{w.limit} {windowLabel}</span></div>
              <div className="usage-meter-track" role="progressbar" aria-valuenow={w.used} aria-valuemin={0} aria-valuemax={w.limit} aria-label={`${actionLabel} ${windowLabel}`}>
                <div className="usage-meter-fill" style={{ width: `${percent(w.used, w.limit)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <section className="panel owner-usage">
      <div className="section-heading">
        <div><p className="eyebrow">{t('owner.usageCard.eyebrow')}</p><h2>{t('owner.usageCard.title')}</h2></div>
        <button className="secondary compact" onClick={() => void load()}>{t('owner.usageCard.refresh')}</button>
      </div>
      {usage.loading && <Loading />}
      {usage.error && <ErrorText text={usage.error} />}
      {usage.data && <>
        <div className="usage-block">
          <h3>{t('owner.usageCard.ownerAggregate')}</h3>
          <WindowMeters window={usage.data.owner.window ?? {}} />
          <dl className="usage-counters">
            <div><dt>{t('owner.usageCard.last7')}</dt><dd>{summarizeCounters(usage.data.owner.counters?.days_7 ?? ZERO_COUNTERS)}</dd></div>
            <div><dt>{t('owner.usageCard.last30')}</dt><dd>{summarizeCounters(usage.data.owner.counters?.days_30 ?? ZERO_COUNTERS)}</dd></div>
          </dl>
        </div>
        <div className="usage-block">
          <h3>{t('owner.usageCard.perAgent')}</h3>
          {usage.data.agents.length === 0 && <p className="muted">{t('owner.usageCard.noUsageYet')}</p>}
          {usage.data.agents.filter(agent => !agent.revoked).map(agent => (
            <div className="usage-agent" key={agent.agent_id}>
              <strong>{agent.name}</strong>
              <WindowMeters window={agent.window ?? {}} />
              <small>{t('owner.usageCard.last7')}: {summarizeCounters(agent.counters?.days_7 ?? ZERO_COUNTERS)}</small>
              <small>{t('owner.usageCard.last30')}: {summarizeCounters(agent.counters?.days_30 ?? ZERO_COUNTERS)}</small>
            </div>
          ))}
          {revokedCount > 0 && <p className="muted">{t(revokedCount === 1 ? 'owner.usageCard.usageForOneAgent' : 'owner.usageCard.usageForManyAgents', { count: revokedCount })} {t(revokedCount === 1 ? 'owner.usageCard.usageSuffix' : 'owner.usageCard.usageSuffixMany')}</p>}
        </div>
      </>}
      {limits.error && <ErrorText text={limits.error} />}
      {limits.data && <details className="limits-reference">
        <summary>{t('owner.usageCard.limitsReference')}</summary>
        <table>
          <thead><tr><th>{t('owner.usageCard.action')}</th><th>{t('owner.usageCard.agentLimit')}</th><th>{t('owner.usageCard.ownerLimit')}</th><th>{t('owner.usageCard.window')}</th></tr></thead>
          <tbody>{Object.entries(limits.data.actions).map(([action, limit]) => {
            const actionLabel = t(`owner.usageCard.actions.${action}`, { defaultValue: action.replace(/_/g, ' ') });
            const windowLabel = limit.window_sec === 3600 ? t('owner.usageCard.windows.hour') : limit.window_sec === 86400 ? t('owner.usageCard.windows.day') : `${limit.window_sec}s`;
            return (
              <tr key={action}>
                <td>{actionLabel}</td>
                <td>{limit.agent > 0 ? limit.agent : t('owner.usageCard.unlimited')}</td>
                <td>{limit.owner > 0 ? limit.owner : t('owner.usageCard.unlimited')}</td>
                <td>{windowLabel}</td>
              </tr>
            );
          })}</tbody>
        </table>
        <p className="muted">{t('owner.usageCard.directMessagesAside', { limit: limits.data.direct_message_pair.limit, window: limits.data.direct_message_pair.window_sec === 3600 ? t('owner.usageCard.windows.hour') : limits.data.direct_message_pair.window_sec === 86400 ? t('owner.usageCard.windows.day') : `${limits.data.direct_message_pair.window_sec}s`, agents: limits.data.capacity.agents_per_owner, tokens: limits.data.capacity.enrollment_tokens_per_owner })}</p>
      </details>}
    </section>
  );
}

// Defensive shape checks: an unrecognized or stubbed backend (e.g. a test double that fulfills every
// `/v1/**` route with the same generic envelope) must surface as a load error, never throw during render.
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function isOwnerUsage(value: unknown): value is OwnerUsage {
  return isRecord(value) && isRecord(value.owner) && isRecord((value.owner as Record<string, unknown>).window) && Array.isArray(value.agents);
}
function isEffectiveLimits(value: unknown): value is EffectiveLimits {
  return isRecord(value) && isRecord(value.actions) && isRecord(value.direct_message_pair) && isRecord(value.capacity);
}

const percent = (used: number, limit: number) => (limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0);
