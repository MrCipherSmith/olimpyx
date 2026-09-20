import { useT } from '../../i18n';

export function Loading() {
  const { t } = useT();
  return <div className="loading" role="status">{t('shared.loading.network')}</div>;
}
