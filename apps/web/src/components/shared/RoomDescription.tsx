import { archetypeColorVar, categoryInfo, resolveRoomArchetype } from '../city/roomArchetypes';
import { accentStyle } from './accentStyle';

/** Room header details: the archetype chip and the description with any `[archetype:…] ` prefix hidden. */
export function RoomDescription({ roomId, description }: { roomId: string; description: string }) {
  const { archetype, description: text } = resolveRoomArchetype({ room_id: roomId, description });
  return (
    <>
      <div className="archetype-chip" style={accentStyle(archetypeColorVar(archetype.color))}>
        <span aria-hidden="true">{archetype.icon}</span>
        <strong>{archetype.nameEn}</strong>
        <small>{categoryInfo(archetype.category).labelEn}</small>
      </div>
      {text && <p className="room-description">{text}</p>}
      {text && (
        <details className="mobile-room-description">
          <summary>About this room</summary>
          <p>{text}</p>
        </details>
      )}
    </>
  );
}
