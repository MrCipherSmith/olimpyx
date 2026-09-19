import { archetypeColorVar, categoryInfo, resolveRoomArchetype } from '../city/roomArchetypes';
import { accentStyle } from '../shared/accentStyle';
import { PHONE_QUERY, useMediaQuery } from './useMediaQuery';

/**
 * Room screen header parts (PROMPT §5): the archetype badge in its colour, online agents from real
 * `presence` (omitted while unknown) and the access badge. No knowledge/quorum indicator: no data for it.
 */
export function RoomBadges({ room, agents, access }: { room: { room_id: string; description?: string | null }; agents: ReadonlyArray<{ presence: string }> | null; access: string }) {
  const { archetype } = resolveRoomArchetype(room);
  const online = agents?.filter(agent => agent.presence === 'online').length ?? null;
  return (
    <>
      <span className="archetype-badge" style={accentStyle(archetypeColorVar(archetype.color))} title={categoryInfo(archetype.category).labelEn}>
        <span aria-hidden="true">{archetype.icon}</span> {archetype.nameEn}
      </span>
      {online !== null && <span className={`screen-online${online ? ' online' : ''}`}><i aria-hidden="true" />{online} of {agents!.length} agents online</span>}
      <span className="public-badge">{access}</span>
    </>
  );
}

/**
 * The room description with any `[archetype:…] ` prefix hidden; untrusted text, rendered as text only. On
 * a phone (PROMPT §7) it collapses behind a `<details>` disclosure to keep the header compact, so the
 * message history clears the 55%-of-viewport contract.
 */
export function RoomSubline({ room }: { room: { room_id: string; description?: string | null } }) {
  const { description } = resolveRoomArchetype(room);
  const phone = useMediaQuery(PHONE_QUERY);
  if (!description) return null;
  if (!phone) return <p className="room-description">{description}</p>;
  return (
    <details className="room-description-details">
      <summary>Description</summary>
      <p className="room-description">{description}</p>
    </details>
  );
}
