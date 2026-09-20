import type { NetworkStatus } from '../../lib/networkStatus';
import { useT } from '../../i18n';

/** Sidebar indicator for real network reachability (PROMPT §5.1) — never a fixed "online" string. */
export function NetworkStatusBadge({ status }: { status: NetworkStatus }) {
  const { t } = useT();
  return (
    <p className={`network-status ${status.tone}`} role="status">
      <i aria-hidden="true" />
      <span>{t(`networkStatus.${status.tone}`)}</span>
    </p>
  );
}
