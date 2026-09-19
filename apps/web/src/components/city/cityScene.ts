import { layoutRings, painterSort, ringCountFor, ringSpec } from './isometricMath';
import { resolveRoomArchetype, type ArchetypeCategory, type ArchetypeColor, type ArchetypeId, type RoomArchetype } from './roomArchetypes';

/** Minimal room shape the city needs; both participant `Room` and guest `PublicRoom` satisfy it. */
export interface CityRoomInput { room_id: string; title: string; description?: string | null; message_count?: number; }

export type CityLandmarkKind = 'library' | 'pantheon' | 'praetorium';
export type CityShape = CityLandmarkKind | ArchetypeId;

export interface CityBuilding {
  id: string;
  kind: CityLandmarkKind | 'room';
  shape: CityShape;
  label: string;
  color: ArchetypeColor;
  /** World position of the footprint centre. */
  x: number;
  y: number;
  /** Half extent of the footprint along the world axes. */
  size: number;
  height: number;
  ring: number | null;
  angle: number | null;
  archetype?: RoomArchetype;
  category?: ArchetypeCategory;
  room?: { roomId: string; title: string; description: string; messageCount: number | null };
}

/** A straight road from the forum edge outwards along a precomputed direction. */
export interface CityAvenue { cos: number; sin: number; length: number; }

export interface CityScene {
  buildings: CityBuilding[];
  /** `buildings` in painter order (far first), sorted once per scene; renderer and hit test walk it. */
  drawOrder: CityBuilding[];
  /** Room buildings only, in input order. */
  roomBuildings: CityBuilding[];
  /** Four cardinal avenues to the city edge followed by one avenue per room (same order as roomBuildings). */
  avenues: CityAvenue[];
  /** The per-room subset of `avenues`, used by the decorative road pulses. */
  roomAvenues: CityAvenue[];
  rings: number[];
  forumRadius: number;
  /** Half side of the square Forum platform (world units); 0 when the scene has no plaza (preview). */
  plazaHalf: number;
  outerRadius: number;
}

export interface CitySceneOptions {
  /** Owner only: adds the Praetorium (entrance to Owner controls). Guests never get it. */
  includePraetorium?: boolean;
}

/** Derived scene data shared by buildCityScene and the single-building preview. */
export function sceneFromBuildings(buildings: CityBuilding[], rings: number[], forumRadius: number, outerRadius: number, plazaHalf = 0): CityScene {
  const roomBuildings = buildings.filter(building => building.kind === 'room');
  const edge = outerRadius + 140;
  const cardinal: CityAvenue[] = [0, 1, 2, 3].map(index => { const angle = index * Math.PI / 2 + Math.PI / 4; return { cos: Math.cos(angle), sin: Math.sin(angle), length: edge }; });
  const roomAvenues: CityAvenue[] = roomBuildings.filter(building => building.angle !== null)
    .map(building => ({ cos: Math.cos(building.angle!), sin: Math.sin(building.angle!), length: Math.hypot(building.x, building.y) }));
  return { buildings, drawOrder: painterSort(buildings), roomBuildings, avenues: [...cardinal, ...roomAvenues], roomAvenues, rings, forumRadius, plazaHalf, outerRadius };
}

/**
 * Forum Centralis (City Shell §3): the Library and the Pantheon stand side by side on one horizontal line of
 * the screen. Both sit on x + y = 0, so their isoY is equal, and |isoX| = 250·cos30 ≈ 216.5 (the prototype's
 * (−135, 75) / (135, −75) rotated onto the screen horizontal). The owner-only Praetorium stands at the front
 * of the plaza on the screen's vertical axis (isoX = 0), clear of both.
 */
export const LIBRARY_POSITION = { x: -125, y: 125 } as const;
export const PANTHEON_POSITION = { x: 125, y: -125 } as const;
export const PRAETORIUM_POSITION = { x: 92, y: 92 } as const;
export const FORUM_RADIUS = 240;
/** Half side of the square Forum platform; its corners (arches) sit on the screen axes. */
export const PLAZA_HALF = 200;

export const LANDMARK_NAMES: Record<CityLandmarkKind, string> = {
  library: 'Central Library',
  pantheon: 'Pantheon of Agents',
  praetorium: 'Praetorium',
};

export const ROOM_HEIGHT: Record<ArchetypeId, number> = {
  lab_observatory: 96, archive_data_vault: 70, crypto_proving_grounds: 62,
  senate_rotunda: 84, forum_agora: 46, tribunal_chamber: 74,
  cyber_forge: 80, neural_matrix_spire: 140, telemetry_beacon: 150,
  command_citadel: 88, surveillance_panopticon: 104, logistics_nexus: 52,
};

export function buildCityScene(rooms: readonly CityRoomInput[], options: CitySceneOptions = {}): CityScene {
  const slots = layoutRings(rooms.length);
  const buildings: CityBuilding[] = [
    { id: 'library', kind: 'library', shape: 'library', label: 'Центральная Библиотека', color: 'indigo', ...LIBRARY_POSITION, size: 56, height: 150, ring: null, angle: null },
    { id: 'pantheon', kind: 'pantheon', shape: 'pantheon', label: 'Пантеон Агентов', color: 'gold', ...PANTHEON_POSITION, size: 58, height: 118, ring: null, angle: null },
  ];
  if (options.includePraetorium === true) {
    buildings.push({ id: 'praetorium', kind: 'praetorium', shape: 'praetorium', label: 'Преторий', color: 'amber', ...PRAETORIUM_POSITION, size: 44, height: 100, ring: null, angle: null });
  }
  rooms.forEach((room, index) => {
    const slot = slots[index];
    const { archetype, description } = resolveRoomArchetype(room);
    buildings.push({
      id: `room:${room.room_id}`,
      kind: 'room',
      shape: archetype.id,
      label: room.title,
      color: archetype.color,
      x: slot.x,
      y: slot.y,
      size: 46,
      height: ROOM_HEIGHT[archetype.id],
      ring: slot.ring,
      angle: slot.angle,
      archetype,
      category: archetype.category,
      room: { roomId: room.room_id, title: room.title, description, messageCount: typeof room.message_count === 'number' ? room.message_count : null },
    });
  });
  const ringCount = ringCountFor(rooms.length);
  // Ring 0 is always drawn as a road, even before the first room exists.
  const rings = Array.from({ length: Math.max(1, ringCount) }, (_, index) => ringSpec(index).radius);
  return sceneFromBuildings(buildings, rings, FORUM_RADIUS, rings.at(-1)!, PLAZA_HALF);
}

/** Whether a building passes the HUD category filter; the Forum landmarks are always shown. */
export function matchesFilter(building: CityBuilding, filter: ArchetypeCategory | 'all'): boolean {
  return filter === 'all' || building.kind !== 'room' || building.category === filter;
}
