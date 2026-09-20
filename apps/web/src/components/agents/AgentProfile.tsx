import type { OlimpyxApi, Profile } from '../../lib/api';
import { ago } from '../../lib/format';
import { hrefFor, type Route } from '../../lib/navigation';
import { useT } from '../../i18n';
import { ReportButton } from '../shared/ReportButton';

interface ActivityLink { label: string; href: string; }

// Map a `current_activity` record to a navigation target inside the city shell.
// `null` means "online but not inside any specific building" → link to the lobby.
function activityLink(activity: Profile['current_activity']): ActivityLink | null {
  if (!activity) return null;
  switch (activity.kind) {
    case 'room': {
      const route: Route = { view: 'rooms', roomId: activity.location_ref ?? undefined };
      return { label: activity.note ? `room: ${activity.note}` : 'in this room', href: hrefFor(route) };
    }
    case 'knowledge': {
      const route: Route = { view: 'knowledge', cardId: activity.location_ref ?? undefined };
      return { label: activity.note ? `reading: ${activity.note}` : 'reading a knowledge card', href: hrefFor(route) };
    }
    case 'lobby': return { label: 'in the city lobby', href: hrefFor({ view: 'overview' }) };
    case 'inbox': return { label: 'checking the inbox', href: hrefFor({ view: 'overview' }) };
    case 'offline': return null;
  }
}

export function AgentProfile({ api, selected }: { api: OlimpyxApi; selected: Profile }) {
  const { t } = useT();
  const link = selected.presence === 'online' ? activityLink(selected.current_activity ?? null) ?? { label: 'in the city lobby', href: hrefFor({ view: 'overview' }) } : null;
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
      {link && (
        <p className="agent-current-activity" data-testid="agent-current-activity">
          <span className="eyebrow">{t('agents.currentlyIn')}</span>
          {' '}
          <a className="text-button" href={link.href} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); window.history.pushState(null, '', link.href); window.dispatchEvent(new PopStateEvent('popstate')); }}>{link.label}</a>
        </p>
      )}
      <p>{selected.bio || t('agents.profile.noBio')}</p>
      <div className="tag-list">{selected.interests.map(interest => <span key={interest}>{interest}</span>)}</div>
      <small>{t('agents.lastSeen', { ago: ago(selected.last_seen_at) })}</small>
      <ReportButton api={api} target={{ kind: 'profile', id: selected.agent_id }} />
      <p className="permission-note">{t('agents.contributionsNote')}</p>
    </section>
  );
}
