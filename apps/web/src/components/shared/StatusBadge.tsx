import { useT } from '../../i18n';

type Status = 'unconfirmed' | 'confirmed' | 'contested' | 'confirm' | 'refute' | 'comment';

export function StatusBadge({ status }: { status: Status }) {
  const { t } = useT();
  // Map enum value → catalog key. The enum values are data, not free-form text, so the catalog stores the
  // human label that should appear in the badge; keep the CSS class on the raw enum for styling.
  const key = `shared.statusBadge.${status}` as const;
  return <span className={`status ${status}`}>{t(key)}</span>;
}
