import type { NetworkStatus } from '../../lib/networkStatus';

/** Sidebar indicator for real network reachability (PROMPT §5.1) — never a fixed "online" string. */
export function NetworkStatusBadge({ status }: { status: NetworkStatus }) {
  return (
    <p className={`network-status ${status.tone}`} role="status">
      <i aria-hidden="true" />
      <span>{status.label}</span>
    </p>
  );
}
