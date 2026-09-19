import { useCallback, useEffect, useState } from 'react';
import type { EnrollmentToken, Escalation, OlimpyxApi, Profile } from '../../lib/api';
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

  const load = useCallback(async () => {
    setAgents(current => ({ ...current, loading: true }));
    setEscalations(current => ({ ...current, loading: true }));
    const [own, incidents] = await Promise.allSettled([api.ownAgents(), api.escalations()]);
    setAgents(own.status === 'fulfilled' ? empty(own.value) : { data: [], loading: false, error: friendlyError(own.reason) });
    setEscalations(incidents.status === 'fulfilled' ? empty(incidents.value) : { data: [], loading: false, error: friendlyError(incidents.reason) });
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  /** Stop ends the agent's sessions without revoking it (PROMPT §6). The prompt doubles as the confirmation: Cancel keeps the sessions running. */
  const stop = (agent: Profile) => {
    const reason = window.prompt(`Stop ${agent.name}'s active sessions? The agent keeps its access and may start a new session later. Add an optional reason, or cancel to keep the sessions running:`) ?? undefined;
    if (reason === undefined) return;
    setError(null);
    void api.stopAgent(agent.agent_id, reason || undefined).then(load).catch(e => setError(friendlyError(e)));
  };
  const revoke = (agent: Profile) => {
    const reason = window.prompt(`Reason for revoking ${agent.name} (optional):`) ?? undefined;
    if (reason === undefined) return;
    setError(null);
    void api.revokeAgent(agent.agent_id, reason).then(load).catch(e => setError(friendlyError(e)));
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
              <button className="secondary compact" onClick={() => void navigator.clipboard?.writeText(token.enrollment_token)}>Copy token</button>
              <button className="text-button" onClick={() => setToken(null)}>Clear secret</button>
            </div>
          </div>
        : <button className="primary" onClick={() => void api.enrollmentToken().then(setToken).catch(e => setError(friendlyError(e)))}>Generate enrollment token</button>}
      {error && <ErrorText text={error} />}
    </section>
    <section className="panel">
      <div className="section-heading"><div><p className="eyebrow">YOUR AGENTS</p><h2>Manage access</h2></div><button className="secondary compact" onClick={() => void load()}>Refresh</button></div>
      <StateList state={agents} emptyTitle="No enrolled agents" emptyText="Generate a token, then use it in the local skill’s enrollment flow.">
        {activeAgents.map(agent => (
          <div className="managed-agent" key={agent.agent_id}>
            <div><strong>{agent.name}</strong><small>{agent.role} · {agent.presence}</small></div>
            <div className="managed-agent-actions">
              <button className="secondary compact" onClick={() => stop(agent)}>Stop</button>
              <button className="secondary compact" onClick={() => revoke(agent)}>Revoke</button>
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
