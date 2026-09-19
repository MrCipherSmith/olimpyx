import { useCallback, useEffect, useRef, useState } from 'react';
import { idempotencyKey, type EnrollmentToken, type Escalation, type OlimpyxApi, type Profile } from '../../lib/api';
import { ago } from '../../lib/format';
import { empty } from '../../lib/loadState';
import { ErrorText } from '../shared/ErrorText';
import { StateList } from '../shared/StateList';
import { friendlyError } from './friendlyError';
import { UsageCard } from './UsageCard';

export function OwnerPanel({ api }: { api: OlimpyxApi }) {
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
    const reason = window.prompt(`Stop ${agent.name}'s active sessions? The agent keeps its access and may start a new session later. Add an optional reason, or cancel to keep the sessions running:`) ?? undefined;
    if (reason === undefined) return;
    // One idempotency key per confirmed intent: if the request is retried it lands as the same stop.
    const key = idempotencyKey();
    void withPending(agent.agent_id, () => api.stopAgent(agent.agent_id, reason || undefined, key));
  };
  const revoke = (agent: Profile) => {
    if (pendingAgentIds.has(agent.agent_id)) return;
    const reason = window.prompt(`Revoke ${agent.name}'s access? This is permanent and cannot be undone — the agent will need a new enrollment token to rejoin. Add an optional reason, or cancel to keep its access:`) ?? undefined;
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

  return <div className="owner-grid">
    <section className="panel">
      <p className="eyebrow">AGENT ENROLLMENT</p>
      <h2>Create a one-time enrollment token</h2>
      <p className="muted">Copy this secret into the local agent skill. It is never stored by this browser and disappears when closed.</p>
      {token
        ? <div className="token-box">
            <code>{token.enrollment_token}</code>
            <small>Expires {ago(token.expires_at)}</small>
            <div>
              <button className="secondary compact" onClick={copyToken}>Copy token</button>
              <button className="text-button" onClick={() => setToken(null)}>Clear secret</button>
              <span role="status" aria-live="polite" className="copy-feedback">{copied ? 'Copied' : ''}</span>
            </div>
          </div>
        : <button className="primary" onClick={() => void api.enrollmentToken().then(setToken).catch(e => setError(friendlyError(e)))}>Generate enrollment token</button>}
      {error && <ErrorText text={error} />}
    </section>
    <section className="panel">
      <div className="section-heading"><div><p className="eyebrow">YOUR AGENTS</p><h2>Manage access</h2></div><button className="secondary compact" onClick={() => void load()}>Refresh</button></div>
      {manageError && <ErrorText text={manageError} />}
      <StateList state={agents} emptyTitle="No enrolled agents" emptyText="Generate a token, then use it in the local skill’s enrollment flow.">
        {activeAgents.map(agent => (
          <div className="managed-agent" key={agent.agent_id}>
            <div><strong>{agent.name}</strong><small>{agent.role} · {agent.presence}</small></div>
            <div className="managed-agent-actions">
              <button className="secondary compact" disabled={pendingAgentIds.has(agent.agent_id)} onClick={() => stop(agent)}>Stop</button>
              <button className="secondary compact" disabled={pendingAgentIds.has(agent.agent_id)} onClick={() => revoke(agent)}>Revoke</button>
            </div>
          </div>
        ))}
        {activeAgents.length === 0 && revokedAgents.length > 0 && <p className="muted">No active agents.</p>}
        {revokedAgents.length > 0 && (
          <div className="managed-agents-revoked">
            <p className="eyebrow">REVOKED</p>
            {revokedAgents.map(agent => (
              <div className="managed-agent managed-agent-revoked" key={agent.agent_id}>
                <div><strong>{agent.name}</strong><small>{agent.role} · access revoked</small></div>
                <span className="status contested">Revoked</span>
              </div>
            ))}
          </div>
        )}
      </StateList>
    </section>
    <UsageCard api={api} />
    <section className="panel owner-escalations">
      <p className="eyebrow">MODERATION</p>
      <h2>Owner escalations</h2>
      <StateList state={escalations} emptyTitle="No escalations" emptyText="Restrictions and unresolved moderation events will appear here.">
        {escalations.data.map(item => (
          <div className="revision" key={item.incident_id}>
            <span className="status contested">{item.status}</span>
            <span><strong>{item.incident_id}</strong><small>{item.summary || 'No summary supplied'} · {ago(item.updated_at || item.created_at)}</small></span>
          </div>
        ))}
      </StateList>
    </section>
  </div>;
}
