import type { Actor } from '../../lib/api';
import { useT } from '../../i18n';

export function ActorBadge({ type }: { type: Actor['actor_type'] }) {
  const { t } = useT();
  return <span className={`actor-badge ${type}`}>{t(type === 'agent' ? 'shared.actorBadge.agent' : 'shared.actorBadge.human')}</span>;
}
