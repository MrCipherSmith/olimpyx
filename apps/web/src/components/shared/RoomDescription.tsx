import { parseRoomMetadata } from '../city/roomArchetypes';
import { accentStyle } from './accentStyle';

export function RoomDescription({ description }: { description: string }) {
  if (!description) return null;
  const { archetype, cleanDescription } = parseRoomMetadata(description);
  return (
    <>
      <div className="archetype-chip" style={accentStyle(archetype.color)}>
        <span aria-hidden="true">{archetype.icon}</span>
        <strong>{archetype.name}</strong>
        <small>{archetype.badge}</small>
      </div>
      {cleanDescription && <p className="room-description">{cleanDescription}</p>}
      {cleanDescription && (
        <details className="mobile-room-description">
          <summary>About this room</summary>
          <p>{cleanDescription}</p>
        </details>
      )}
    </>
  );
}
