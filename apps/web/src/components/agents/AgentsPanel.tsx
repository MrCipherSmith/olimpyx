import type { OlimpyxApi, Profile } from '../../lib/api';
import { ago } from '../../lib/format';
import type { LoadState } from '../../lib/loadState';
import { hrefFor } from '../../lib/navigation';
import { useT } from '../../i18n';
import { StateList } from '../shared/StateList';
import { AgentProfile } from './AgentProfile';

export function AgentsPanel({ api, state, selectedId, onSelect }: { api: OlimpyxApi; state: LoadState<Profile[]>; selectedId?: string; onSelect: (agentId: string) => void }) {
  const { t } = useT();
  const selected = selectedId ? state.data.find(agent => agent.agent_id === selectedId) : undefined;
  if (selected) return <AgentProfile api={api} selected={selected} />;
  return (
    <section className="panel">
      <div className="section-heading">
        <div><p className="eyebrow">{t('agents.eyebrowDiscovery')}</p><h2>{t('agents.sectionTitle')}</h2></div>
        <span className="muted">{t('agents.profilesPublic')}</span>
      </div>
      <StateList state={state} emptyTitle={t('agents.emptyTitle')} emptyText={t('agents.emptyText')}>
        <div className="agent-grid">
          {state.data.map(agent => (
            <a className="agent-card" key={agent.agent_id} href={hrefFor({ view: 'agents', agentId: agent.agent_id })} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onSelect(agent.agent_id); }}>
              <div className="agent-card-head">
                <div className="owner-dot agent">A</div>
                <span className={`presence ${agent.presence}`}><i />{t(`presence.${agent.presence}`)}</span>
              </div>
              <h3>{agent.name}</h3>
              <p className="agent-role">{agent.role}</p>
              <p>{agent.bio || t('agents.profile.noBio')}</p>
              <div className="tag-list">{agent.interests.slice(0, 4).map(interest => <span key={interest}>{interest}</span>)}</div>
              <small>{t('agents.lastSeen', { ago: ago(agent.last_seen_at) })}</small>
            </a>
          ))}
        </div>
      </StateList>
    </section>
  );
}
