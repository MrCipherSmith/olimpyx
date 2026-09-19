import type { CityBuilding } from '../city/cityScene';
import type { Route } from '../../lib/navigation';
import type { DiveTarget } from './diveMachine';

/**
 * Minimal building shape the dive needs. `kind` is read as a plain string so landmarks added later
 * (the owner-only Praetorium, a dedicated Forum building) are found when present and simply skipped
 * when the scene does not have them.
 */
type DiveBuilding = Pick<CityBuilding, 'id' | 'label' | 'x' | 'y' | 'height'> & { kind: string; room?: { roomId: string } | undefined; archetype?: { nameEn: string } | undefined };

const LANDMARKS: Record<string, { name: string; subline: string }> = {
  library: { name: 'Central Library of Knowledge', subline: 'Entering the knowledge vault…' },
  pantheon: { name: 'Pantheon of Agents', subline: 'Entering the agent directory…' },
  praetorium: { name: 'Praetorium', subline: 'Entering owner controls…' },
  forum: { name: 'Forum Centralis', subline: 'Entering the room directory…' },
};

/** Where the camera aims on a building: the upper half of its body, like the prototype's roof lock. */
const ROOF_SHARE = 0.5;

/** Bidi embedding/override (U+202A–U+202E) and isolate (U+2066–U+2069) controls. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * An untrusted building name made safe for the overlay, the target lock and the live announcement: bidi
 * controls cannot reorder the surrounding text ("TARGET LOCKED: …"), whitespace runs collapse.
 */
export function cleanDiveName(text: string): string {
  return text.replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim();
}

function fromBuilding(building: DiveBuilding): DiveTarget {
  const landmark = LANDMARKS[building.kind];
  const name = landmark?.name ?? cleanDiveName(building.label);
  const subline = landmark?.subline ?? (building.archetype ? `Entering ${cleanDiveName(building.archetype.nameEn)}…` : 'Entering the room…');
  return { key: building.id, name, subline, x: building.x, y: building.y, z: building.height * ROOF_SHARE };
}

const byKind = (buildings: readonly DiveBuilding[], kind: string) => buildings.find(building => building.kind === kind);

/**
 * The building a route dives into (PROMPT §4 navigation targets), or null when the scene has no such
 * building yet (the screen then opens without a dive):
 * Knowledge → Library, Agents → Pantheon, Owner controls → Praetorium, a room → its building,
 * Rooms directory → the Forum building if the scene has one, else the forum plaza itself.
 */
export function diveTargetFor(route: Route, buildings: readonly DiveBuilding[]): DiveTarget | null {
  switch (route.view) {
    case 'overview': return null;
    case 'knowledge': { const building = byKind(buildings, 'library'); return building ? fromBuilding(building) : null; }
    case 'agents': { const building = byKind(buildings, 'pantheon'); return building ? fromBuilding(building) : null; }
    case 'owner': { const building = byKind(buildings, 'praetorium'); return building ? fromBuilding(building) : null; }
    case 'rooms': {
      if (route.roomId) {
        const building = buildings.find(item => item.kind === 'room' && item.room?.roomId === route.roomId);
        return building ? fromBuilding(building) : null;
      }
      const forum = byKind(buildings, 'forum');
      return forum ? fromBuilding(forum) : { key: 'forum', ...LANDMARKS.forum, x: 0, y: 0, z: 0 };
    }
  }
}
