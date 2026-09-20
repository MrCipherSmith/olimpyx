import type { Route, View } from '../../lib/navigation';
import { RouteLink } from '../shared/RouteLink';
import type { HudNavItem } from './CityHud';

interface MobileTabBarProps {
  // navLabel is already a localized string passed by the parent (from the `nav` namespace).
  navLabel: string;
  items: readonly HudNavItem[];
  activeView: View;
  onNavigate: (route: Route) => void;
}

/**
 * Phone navigation (PROMPT §7): a bottom tab bar with large touch targets replaces the HUD nav list as
 * the page's one primary `nav` while it is shown (CityHud renders either this or the HUD list, never both).
 */
export function MobileTabBar({ navLabel, items, activeView, onNavigate }: MobileTabBarProps) {
  return (
    <nav aria-label={navLabel} className="tab-bar">
      {items.map(item => (
        <RouteLink key={item.view} className="tab-bar-item" route={{ view: item.view }} current={activeView === item.view} navView={item.view} onNavigate={onNavigate}>
          <span className="tab-bar-icon" aria-hidden="true">{item.icon}</span>
          <span className="tab-bar-label">{item.label}</span>
        </RouteLink>
      ))}
    </nav>
  );
}
