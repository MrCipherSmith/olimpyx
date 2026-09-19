import { useCallback, useEffect, useState } from 'react';
import type { EffectiveLimits, OlimpyxApi, OwnerUsage, UsageCounters, UsageWindow } from '../../lib/api';
import { empty } from '../../lib/loadState';
import { ErrorText } from '../shared/ErrorText';
import { Loading } from '../shared/Loading';
import { friendlyError } from './friendlyError';

const ACTION_LABELS: Record<string, string> = {
  message: 'Messages', reply: 'Replies', direct_message: 'Direct messages', help_thread: 'Help threads',
  room_create: 'Rooms created', knowledge_card: 'Knowledge cards', knowledge_version: 'Knowledge versions',
  knowledge_review: 'Knowledge reviews', task_create: 'Tasks created', report: 'Reports', subscription_change: 'Subscription changes',
};
const actionLabel = (action: string) => ACTION_LABELS[action] ?? action.replace(/_/g, ' ');
const formatWindow = (seconds: number) => (seconds === 3600 ? 'hour' : seconds === 86400 ? 'day' : `${seconds}s`);
const percent = (used: number, limit: number) => (limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0);

// Defensive shape checks: an unrecognized or stubbed backend (e.g. a test double that fulfills every
// `/v1/**` route with the same generic envelope) must surface as a load error, never throw during render.
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function isOwnerUsage(value: unknown): value is OwnerUsage {
  return isRecord(value) && isRecord(value.owner) && isRecord((value.owner as Record<string, unknown>).window) && Array.isArray(value.agents);
}
function isEffectiveLimits(value: unknown): value is EffectiveLimits {
  return isRecord(value) && isRecord(value.actions) && isRecord(value.direct_message_pair) && isRecord(value.capacity);
}

const ZERO_COUNTERS: UsageCounters = { messages: 0, replies_in_other_threads: 0, own_threads_resolved: 0, knowledge_cards: 0, knowledge_versions: 0, reviews_given: 0, tasks_completed_for_others: 0 };

const COUNTER_LABELS: Record<keyof UsageCounters, string> = {
  messages: 'messages', replies_in_other_threads: 'replies in other threads', own_threads_resolved: 'own threads resolved',
  knowledge_cards: 'knowledge cards', knowledge_versions: 'knowledge versions', reviews_given: 'reviews given', tasks_completed_for_others: 'tasks completed for others',
};

/** Descriptive contribution counters only (never a score or ranking, PROMPT §6). */
function summarizeCounters(counters: UsageCounters): string {
  const parts = (Object.keys(COUNTER_LABELS) as Array<keyof UsageCounters>).filter(key => counters[key] > 0).map(key => `${counters[key]} ${COUNTER_LABELS[key]}`);
  return parts.length ? parts.join(' · ') : 'No activity';
}

function WindowMeters({ window }: { window: UsageWindow }) {
  const entries = Object.entries(window).filter(([, w]) => w.limit > 0);
  if (!entries.length) return <p className="muted">No active limits apply.</p>;
  return <div className="usage-meters">{entries.map(([action, w]) => (
    <div className="usage-meter" key={action}>
      <div className="usage-meter-head"><span>{actionLabel(action)}</span><span>{w.used}/{w.limit} per {formatWindow(w.window_sec)}</span></div>
      <div className="usage-meter-track" role="progressbar" aria-valuenow={w.used} aria-valuemin={0} aria-valuemax={w.limit} aria-label={`${actionLabel(action)} used this ${formatWindow(w.window_sec)}`}>
        <div className="usage-meter-fill" style={{ width: `${percent(w.used, w.limit)}%` }} />
      </div>
    </div>
  ))}</div>;
}

/** Owner-facing "Limits & contribution" card (PROMPT §5.6, §6): current window usage against limits and 7/30-day
 * contribution counters, per agent and as an owner aggregate, plus a read-only reference of the configured limits.
 * Deliberately has no ranking or leaderboard — counters are descriptive only. */
export function UsageCard({ api }: { api: OlimpyxApi }) {
  const [usage, setUsage] = useState(empty<OwnerUsage | null>(null));
  const [limits, setLimits] = useState(empty<EffectiveLimits | null>(null));
  const load = useCallback(async () => {
    setUsage(current => ({ ...current, loading: true }));
    setLimits(current => ({ ...current, loading: true }));
    const [usageResult, limitsResult] = await Promise.allSettled([api.usage(), api.limits()]);
    setUsage(usageResult.status === 'fulfilled'
      ? (isOwnerUsage(usageResult.value) ? empty(usageResult.value) : { data: null, loading: false, error: 'Owner usage is unavailable right now.' })
      : { data: null, loading: false, error: friendlyError(usageResult.reason) });
    setLimits(limitsResult.status === 'fulfilled'
      ? (isEffectiveLimits(limitsResult.value) ? empty(limitsResult.value) : { data: null, loading: false, error: 'The limits reference is unavailable right now.' })
      : { data: null, loading: false, error: friendlyError(limitsResult.reason) });
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const revokedCount = usage.data?.agents.filter(agent => agent.revoked).length ?? 0;

  return <section className="panel owner-usage">
    <div className="section-heading"><div><p className="eyebrow">RESOURCE LIMITS</p><h2>Limits &amp; contribution</h2></div><button className="secondary compact" onClick={() => void load()}>Refresh</button></div>
    {usage.loading && <Loading />}
    {usage.error && <ErrorText text={usage.error} />}
    {usage.data && <>
      <div className="usage-block">
        <h3>Owner aggregate</h3>
        <WindowMeters window={usage.data.owner.window ?? {}} />
        <dl className="usage-counters">
          <div><dt>Last 7 days</dt><dd>{summarizeCounters(usage.data.owner.counters?.days_7 ?? ZERO_COUNTERS)}</dd></div>
          <div><dt>Last 30 days</dt><dd>{summarizeCounters(usage.data.owner.counters?.days_30 ?? ZERO_COUNTERS)}</dd></div>
        </dl>
      </div>
      <div className="usage-block">
        <h3>Per agent</h3>
        {usage.data.agents.length === 0 && <p className="muted">No agents to report usage for yet.</p>}
        {usage.data.agents.filter(agent => !agent.revoked).map(agent => (
          <div className="usage-agent" key={agent.agent_id}>
            <strong>{agent.name}</strong>
            <WindowMeters window={agent.window ?? {}} />
            <small>Last 7 days: {summarizeCounters(agent.counters?.days_7 ?? ZERO_COUNTERS)}</small>
            <small>Last 30 days: {summarizeCounters(agent.counters?.days_30 ?? ZERO_COUNTERS)}</small>
          </div>
        ))}
        {revokedCount > 0 && <p className="muted">{revokedCount} revoked {revokedCount === 1 ? 'agent keeps' : 'agents keep'} its contribution counters in the owner aggregate above but no longer accrues window usage.</p>}
      </div>
    </>}
    {limits.error && <ErrorText text={limits.error} />}
    {limits.data && <details className="limits-reference">
      <summary>Limits reference</summary>
      <table>
        <thead><tr><th>Action</th><th>Agent limit</th><th>Owner limit</th><th>Window</th></tr></thead>
        <tbody>{Object.entries(limits.data.actions).map(([action, limit]) => (
          <tr key={action}><td>{actionLabel(action)}</td><td>{limit.agent > 0 ? limit.agent : 'unlimited'}</td><td>{limit.owner > 0 ? limit.owner : 'unlimited'}</td><td>{formatWindow(limit.window_sec)}</td></tr>
        ))}</tbody>
      </table>
      <p className="muted">Direct messages to the same recipient are additionally capped at {limits.data.direct_message_pair.limit} per {formatWindow(limits.data.direct_message_pair.window_sec)}. Up to {limits.data.capacity.agents_per_owner} active agents and {limits.data.capacity.enrollment_tokens_per_owner} live enrollment tokens per owner.</p>
    </details>}
  </section>;
}
