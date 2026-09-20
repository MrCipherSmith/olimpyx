import type { ReactNode } from 'react';
import type { Route, View } from '../../lib/navigation';
import type { NetworkStatus } from '../../lib/networkStatus';
import { LanguageSwitcher } from '../../i18n/LanguageSwitcher';
import { useT } from '../../i18n';
import { NetworkStatusBadge } from '../layout/NetworkStatus';
import { RouteLink } from '../shared/RouteLink';
import { MobileTabBar } from './MobileTabBar';
import { PHONE_QUERY, useMediaQuery } from './useMediaQuery';

export interface HudNavItem {
  view: View;
  label: string;
  icon: string;
  /** Short badge from real data ("12", "3/5", "3D"); omitted when the data is not available. */
  badge?: string | null;
  /** Spoken description of the badge ("12 rooms"); the badge itself is decorative. */
  badgeLabel?: string | null;
}

export interface HudStat { label: string; value: number | null }

interface CityHudProps {
  navLabel: string;
  eyebrow: string;
  network: NetworkStatus;
  items: HudNavItem[];
  activeView: View;
  stats: HudStat[];
  /** Sign out / Sign in block. */
  account: ReactNode;
  /** Extra line under the brand, e.g. when the published snapshot was generated. */
  note?: ReactNode;
  onNavigate: (route: Route) => void;
}

/**
 * Top-left HUD card over the city (PROMPT §2): brand, network status, navigation with counters, stats,
 * account. Phones (PROMPT §7) get a compact top bar instead — no legend, no stats, and navigation moves to
 * a bottom tab bar (MobileTabBar), which then becomes the page's one primary `nav` under `navLabel`.
 */
export function CityHud({ navLabel, eyebrow, network, items, activeView, stats, account, note, onNavigate }: CityHudProps) {
  const { t } = useT();
  const shown = stats.filter(stat => stat.value !== null);
  const phone = useMediaQuery(PHONE_QUERY);
  return (
    <>
      <header className="hud hud-main">
        <div className="hud-brand-row">
          <div className="hud-brand">
            <span className="brand-mark" aria-hidden="true">◈</span>
            <span>OLIMPYX</span>
            <span className="hud-brand-tag">CITY</span>
          </div>
          <NetworkStatusBadge status={network} />
          {!phone && <LanguageSwitcher className="hud-language" />}
        </div>
        <p className="eyebrow hud-eyebrow">{eyebrow}</p>
        {note}
        {!phone && (
          <nav aria-label={navLabel} className="hud-nav">
            {items.map(item => {
              const descriptionId = item.badge && item.badgeLabel ? `hud-nav-${item.view}-count` : undefined;
              return (
                <RouteLink key={item.view} className="hud-link" route={{ view: item.view }} current={activeView === item.view} navView={item.view} describedBy={descriptionId} onNavigate={onNavigate}>
                  <span className="hud-link-icon" aria-hidden="true">{item.icon}</span>
                  <span className="hud-link-label">{item.label}</span>
                  {item.badge && <span className="hud-badge" aria-hidden="true">{item.badge}</span>}
                </RouteLink>
              );
            })}
            {/* Referenced descriptions live outside the links so each link's name stays its label. */}
            {items.map(item => item.badge && item.badgeLabel ? <span key={item.view} id={`hud-nav-${item.view}-count`} hidden>{item.badgeLabel}</span> : null)}
          </nav>
        )}
        {!phone && shown.length > 0 && (
          <dl className="hud-stats" aria-label={t('hud.statsAriaLabel')}>
            {shown.map(stat => <div key={stat.label}><dt>{stat.label}</dt><dd>{stat.value}</dd></div>)}
          </dl>
        )}
        <div className="hud-account">{phone && <LanguageSwitcher className="hud-language-mobile" />}{account}</div>
      </header>
      {phone && <MobileTabBar navLabel={navLabel} items={items} activeView={activeView} onNavigate={onNavigate} />}
    </>
  );
}

/** Counter from a list load: unknown (null), not zero, while the first load runs or after it failed. */
export function loadedCount(state: { data: readonly unknown[]; loading: boolean; error: string | null }): number | null {
  if (state.error) return null;
  if (state.loading && !state.data.length) return null;
  return state.data.length;
}

/** Nav badge for agents: "online/total", with a spoken description. The caller supplies the already-localised label. */
export function agentsBadge(agents: ReadonlyArray<{ presence: string }> | null, label: string | null): Pick<HudNavItem, 'badge' | 'badgeLabel'> {
  if (!agents) return { badge: null, badgeLabel: null };
  const online = agents.filter(agent => agent.presence === 'online').length;
  return { badge: `${online}/${agents.length}`, badgeLabel: label };
}

export function countBadge(count: number | null, singular: string, plural: string): Pick<HudNavItem, 'badge' | 'badgeLabel'> {
  if (count === null) return { badge: null, badgeLabel: null };
  return { badge: String(count), badgeLabel: `${count} ${count === 1 ? singular : plural}` };
}
