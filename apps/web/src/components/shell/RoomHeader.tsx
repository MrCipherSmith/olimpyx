import { archetypeColorVar, categoryInfo, resolveRoomArchetype } from '../city/roomArchetypes';
import { accentStyle } from '../shared/accentStyle';
import { useT } from '../../i18n';
import { PHONE_QUERY, useMediaQuery } from './useMediaQuery';

/**
 * Room screen header parts (PROMPT §5): the archetype badge in its colour, online agents in the network
 * from real `presence` (omitted while unknown) and the access badge. No knowledge/quorum indicator: no data for it.
 */
export function RoomBadges({ room, agents, access }: { room: { room_id: string; description?: string | null }; agents: ReadonlyArray<{ presence: string }> | null; access: 'guest' | 'participant' }) {
  const { t } = useT();
  const { archetype } = resolveRoomArchetype(room);
  // Presence is network-wide (no per-room membership on the client): say so rather than imply the room.
  const presence = agents ? { online: agents.filter(agent => agent.presence === 'online').length, total: agents.length } : null;
  return (
    <>
      {/* aria-label carries the accessible name unconditionally so the phone rule below (shell.css) can hide
          the visible text label without losing it — aria-label wins over the (still-present) child text,
          so nothing changes for assistive tech at any width. */}
      <span className="archetype-badge" style={accentStyle(archetypeColorVar(archetype.color))} title={categoryInfo(archetype.category).labelEn} aria-label={archetype.nameEn}>
        <span aria-hidden="true">{archetype.icon}</span> <span className="archetype-badge-label">{archetype.nameEn}</span>
      </span>
      {presence && <span className={`screen-online${presence.online ? ' online' : ''}`}><i aria-hidden="true" />{t('rooms.header.presenceCount', { online: presence.online, total: presence.total })}</span>}
      <span className="public-badge">{t(access === 'guest' ? 'rooms.header.accessGuest' : 'rooms.header.accessParticipant')}</span>
    </>
  );
}

/**
 * The room description with any `[archetype:…] ` prefix hidden; untrusted text, rendered as text only. On
 * a phone (PROMPT §7) it collapses behind a `<details>` disclosure to keep the header compact, so the
 * message history clears the 55%-of-viewport contract.
 */
export function RoomSubline({ room }: { room: { room_id: string; description?: string | null } }) {
  const { t } = useT();
  const { description } = resolveRoomArchetype(room);
  const phone = useMediaQuery(PHONE_QUERY);
  if (!description) return null;
  if (!phone) return <p className="room-description">{description}</p>;
  return (
    <details className="room-description-details">
      <summary>{t('rooms.header.descriptionSummary')}</summary>
      <p className="room-description">{description}</p>
    </details>
  );
}
