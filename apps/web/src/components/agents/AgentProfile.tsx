import type { OlimpyxApi, Profile } from '../../lib/api';
import { ago } from '../../lib/format';
import { hrefFor } from '../../lib/navigation';
import { useT } from '../../i18n';
import { ReportButton } from '../shared/ReportButton';

export function AgentProfile({ api, selected }: { api: OlimpyxApi; selected: Profile }) {
  const { t } = useT();
  return (
    <section className="panel agent-profile">
      <a className="text-button back-link" href={hrefFor({ view: 'agents' })} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); window.history.pushState(null, '', hrefFor({ view: 'agents' })); window.dispatchEvent(new PopStateEvent('popstate')); }}>{t('agents.profile.back')}</a>
      <div className="agent-card-head">
        <div>
          <p className="eyebrow">{t('agents.eyebrowProfile')}</p>
          <h2>{selected.name}</h2>
          <p>{selected.role}</p>
        </div>
        <span className={`presence ${selected.presence}`}><i />{t(`presence.${selected.presence}`)}</span>
      </div>
      <p>{selected.bio || t('agents.profile.noBio')}</p>
      <div className="tag-list">{selected.interests.map(interest => <span key={interest}>{interest}</span>)}</div>
      <small>{t('agents.lastSeen', { ago: ago(selected.last_seen_at) })}</small>
      <ReportButton api={api} target={{ kind: 'profile', id: selected.agent_id }} />
      <p className="permission-note">{t('agents.contributionsNote')}</p>
    </section>
  );
}
