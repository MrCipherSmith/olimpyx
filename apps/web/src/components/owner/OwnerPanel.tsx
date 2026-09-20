import { useCallback, useEffect, useRef, useState } from 'react';
import { idempotencyKey, type EnrollmentToken, type Escalation, type OlimpyxApi, type Profile } from '../../lib/api';
import { ago } from '../../lib/format';
import { empty } from '../../lib/loadState';
import { useT } from '../../i18n';
import { ErrorText } from '../shared/ErrorText';
import { StateList } from '../shared/StateList';
import { friendlyError } from './friendlyError';
import { UsageCard } from './UsageCard';

export function OwnerPanel({ api }: { api: OlimpyxApi }) {
  const { t } = useT();
  const [agents, setAgents] = useState(empty<Profile[]>([]));
  const [escalations, setEscalations] = useState(empty<Escalation[]>([]));
  const [token, setToken] = useState<EnrollmentToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error` (enrollment-token failures) so Stop/Revoke failures surface next to
  // "Manage access" instead of under the unrelated enrollment card.
  const [manageError, setManageError] = useState<string | null>(null);
  // Disables Stop/Revoke for an agent while its request is in flight, so a second click (e.g. an
  // impatient double-click) cannot fire a second confirmation/request for the same intent.
  const [pendingAgentIds, setPendingAgentIds] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  // Stale-response guard: a request counter plus a mounted flag so an in-flight `load()` (or the
  // reload after Stop/Revoke) that resolves after a newer one started, or after unmount, never calls
  // setState.
  const loadRequestId = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const load = useCallback(async () => {
    const requestId = ++loadRequestId.current;
    const isCurrent = () => mountedRef.current && requestId === loadRequestId.current;
    if (isCurrent()) { setAgents(current => ({ ...current, loading: true })); setEscalations(current => ({ ...current, loading: true })); }
    const [own, incidents] = await Promise.allSettled([api.ownAgents(), api.escalations()]);
    if (!isCurrent()) return;
    setAgents(own.status === 'fulfilled' ? empty(own.value) : { data: [], loading: false, error: friendlyError(own.reason) });
    setEscalations(incidents.status === 'fulfilled' ? empty(incidents.value) : { data: [], loading: false, error: friendlyError(incidents.reason) });
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const withPending = async (agentId: string, run: () => Promise<unknown>) => {
    setPendingAgentIds(current => new Set(current).add(agentId));
    setManageError(null);
    try {
      await run();
      await load();
    } catch (e) {
      if (mountedRef.current) setManageError(friendlyError(e));
    } finally {
      if (mountedRef.current) setPendingAgentIds(current => { const next = new Set(current); next.delete(agentId); return next; });
    }
  };

  /** Stop ends the agent's sessions without revoking it (PROMPT §6). The prompt doubles as the confirmation: Cancel keeps the sessions running. */
  const stop = (agent: Profile) => {
    if (pendingAgentIds.has(agent.agent_id)) return;
    const reason = window.prompt(t('owner.agents.stopConfirm', { name: agent.name })) ?? undefined;
    if (reason === undefined) return;
    // One idempotency key per confirmed intent: if the request is retried it lands as the same stop.
    const key = idempotencyKey();
    void withPending(agent.agent_id, () => api.stopAgent(agent.agent_id, reason || undefined, key));
  };
  const revoke = (agent: Profile) => {
    if (pendingAgentIds.has(agent.agent_id)) return;
    const reason = window.prompt(t('owner.agents.revokeConfirm', { name: agent.name })) ?? undefined;
    if (reason === undefined) return;
    const key = idempotencyKey();
    void withPending(agent.agent_id, () => api.revokeAgent(agent.agent_id, reason, key));
  };
  const copyToken = () => {
    if (!token) return;
    void navigator.clipboard?.writeText(token.enrollment_token).then(() => {
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 3000);
    });
  };

  const activeAgents = agents.data.filter(agent => !agent.revoked);
  const revokedAgents = agents.data.filter(agent => agent.revoked);

  return (
    <div className="owner-grid">
      <section className="panel">
        <p className="eyebrow">{t('owner.enrollment.eyebrow')}</p>
        <h2>{t('owner.enrollment.title')}</h2>
        <p className="muted">{t('owner.enrollment.hint')}</p>
        {token
          ? <div className="token-box">
              <code>{token.enrollment_token}</code>
              <small>{t('owner.enrollment.expires', { ago: ago(token.expires_at) })}</small>
              <div>
                <button className="secondary compact" onClick={copyToken}>{t('owner.enrollment.copy')}</button>
                <button className="text-button" onClick={() => setToken(null)}>{t('owner.enrollment.clear')}</button>
                <span role="status" aria-live="polite" className="copy-feedback">{copied ? t('owner.enrollment.copied') : ''}</span>
              </div>
            </div>
          : <button className="primary" onClick={() => void api.enrollmentToken().then(setToken).catch(e => setError(friendlyError(e)))}>{t('owner.enrollment.generate')}</button>}
        {error && <ErrorText text={error} />}
      </section>
      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">{t('owner.agents.eyebrow')}</p><h2>{t('owner.agents.title')}</h2></div><button className="secondary compact" onClick={() => void load()}>{t('owner.agents.refresh')}</button></div>
        {manageError && <ErrorText text={manageError} />}
        <StateList state={agents} emptyTitle={t('owner.agents.emptyTitle')} emptyText={t('owner.agents.emptyText')}>
          {activeAgents.map(agent => (
            <div className="managed-agent" key={agent.agent_id}>
              <div><strong>{agent.name}</strong><small>{agent.role} · {t(`presence.${agent.presence}`)}</small></div>
              <div className="managed-agent-actions">
                <button className="secondary compact" disabled={pendingAgentIds.has(agent.agent_id)} onClick={() => stop(agent)}>{t('owner.agents.stop')}</button>
                <button className="secondary compact" disabled={pendingAgentIds.has(agent.agent_id)} onClick={() => revoke(agent)}>{t('owner.agents.revoke')}</button>
              </div>
            </div>
          ))}
          {activeAgents.length === 0 && revokedAgents.length > 0 && <p className="muted">{t('owner.agents.noActiveAgents')}</p>}
          {revokedAgents.length > 0 && (
            <div className="managed-agents-revoked">
              <p className="eyebrow">{t('owner.agents.revokedHeading')}</p>
              {revokedAgents.map(agent => (
                <div className="managed-agent managed-agent-revoked" key={agent.agent_id}>
                  <div><strong>{agent.name}</strong><small>{agent.role} · {t('owner.agents.accessRevoked')}</small></div>
                  <span className="status contested">{t('status.revoked')}</span>
                </div>
              ))}
            </div>
          )}
        </StateList>
      </section>
      <UsageCard api={api} />
      <section className="panel owner-escalations">
        <p className="eyebrow">{t('owner.escalations.eyebrow')}</p>
        <h2>{t('owner.escalations.title')}</h2>
        <StateList state={escalations} emptyTitle={t('owner.escalations.emptyTitle')} emptyText={t('owner.escalations.emptyText')}>
          {escalations.data.map(item => (
            <div className="revision" key={item.incident_id}>
              <span className="status contested">{item.status}</span>
              <span><strong>{item.incident_id}</strong><small>{item.summary || t('owner.escalations.noSummary')} · {ago(item.updated_at || item.created_at)}</small></span>
            </div>
          ))}
        </StateList>
      </section>
    </div>
  );
}
