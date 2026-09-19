import { type MutableRefObject, useMemo, useRef, useState } from 'react';
import type { Route } from '../../lib/navigation';
import type { DiveState } from '../shell/diveMachine';
import { TargetLock } from '../shell/DiveOverlay';
import { COMPACT_QUERY, PHONE_QUERY, useMediaQuery, usePrefersReducedMotion } from '../shell/useMediaQuery';
import { CityBuildingList } from './CityBuildingList';
import { CityCanvas, type CityCameraController } from './CityCanvas';
import { CityCameraControls, CityFilters, CityLegend, type CityFilter } from './CityHUD';
import { buildCityScene, matchesFilter, type CityBuilding, type CityRoomInput, type CityScene } from './cityScene';
import type { InhabitantActivityInput, InhabitantAgentInput } from './inhabitants';
import { ROOM_CATEGORIES } from './roomArchetypes';

export type { CityRoomInput } from './cityScene';

/** Stable empty defaults so an absent agents/activity prop never looks like "a new array" to CityCanvas. */
const NO_AGENTS: readonly InhabitantAgentInput[] = [];
const NO_ACTIVITY: readonly InhabitantActivityInput[] = [];

interface CityViewProps {
  /** Participant: rooms from api.rooms(). Guest: only the rooms of the published showcase snapshot. */
  rooms: readonly CityRoomInput[];
  mode: 'participant' | 'guest';
  loading?: boolean;
  /** A screen layer covers the city: the render loop stops until it is visible again. */
  paused?: boolean;
  /** The scene the shell already built (shared with the dive targets); built here from `rooms` when absent. */
  scene?: CityScene;
  /** The shell's handle on the camera (the dive drives it); CityView keeps its own when absent. */
  camera?: MutableRefObject<CityCameraController | null>;
  /** The dive in progress: the target lock frame and the highlighted building. */
  dive?: DiveState;
  /** Real agents to walk the roads (City Shell §6): api.agents() for a participant, snapshot.agents for a
   * guest. Omitted draws none. */
  agents?: readonly InhabitantAgentInput[];
  /** Real, already-loaded agent↔room links (recent activity, relationships or loaded messages). */
  activity?: readonly InhabitantActivityInput[];
  onNavigate: (route: Route) => void;
}

/**
 * The screen a building opens: its room, the Library (knowledge), the Pantheon (agents), the Praetorium
 * (owner controls) or a Forum building (the room directory). Unknown kinds open nothing.
 */
export function routeForBuilding(building: Pick<CityBuilding, 'room'> & { kind: string }): Route | null {
  switch (building.kind) {
    case 'library': return { view: 'knowledge' };
    case 'pantheon': return { view: 'agents' };
    case 'praetorium': return { view: 'owner' };
    case 'forum': return { view: 'rooms' };
    case 'room': return building.room ? { view: 'rooms', roomId: building.room.roomId } : null;
    default: return null;
  }
}

/**
 * The persistent city behind every screen: the full-bleed canvas plus its floating HUD parts (legend,
 * building directory, camera). Clicking a building, a legend entry or a directory entry opens its screen.
 */
export function CityView({ rooms, mode, loading = false, paused = false, scene: sharedScene, camera, dive, agents = NO_AGENTS, activity = NO_ACTIVITY, onNavigate }: CityViewProps) {
  const ownScene = useMemo(() => (sharedScene ? null : buildCityScene(rooms)), [sharedScene, rooms]);
  const scene = sharedScene ?? ownScene!;
  const [filter, setFilter] = useState<CityFilter>('all');
  // Phones and tablets (PROMPT §7): the building directory panel is collapsed by default, reachable via
  // its toggle (a phone-width sheet above the tab bar; a top-right panel, as on desktop, for tablets).
  const compact = useMediaQuery(COMPACT_QUERY);
  const phone = useMediaQuery(PHONE_QUERY);
  const [directoryOpen, setDirectoryOpen] = useState(() => !compact);
  const ownController = useRef<CityCameraController | null>(null);
  const controller = camera ?? ownController;
  const diving = dive && (dive.phase === 'focusing' || dive.phase === 'diving') ? dive.target : null;
  const reducedMotion = usePrefersReducedMotion();

  const roomBuildings = scene.roomBuildings;
  const counts = useMemo(() => {
    const result = { all: scene.roomBuildings.length } as Record<CityFilter, number>;
    for (const category of ROOM_CATEGORIES) result[category.id] = 0;
    for (const building of scene.roomBuildings) if (building.category) result[building.category] += 1;
    return result;
  }, [scene]);
  const listed = scene.buildings.filter(building => matchesFilter(building, filter));
  const label = `Isometric city map with the Central Library, the Pantheon of Agents and ${roomBuildings.length} room ${roomBuildings.length === 1 ? 'building' : 'buildings'} on ${scene.rings.length} ${scene.rings.length === 1 ? 'ring' : 'rings'}. Use the building list to open a building.`;
  const emptyText = loading && !rooms.length ? 'Loading rooms…'
    : !roomBuildings.length ? (mode === 'guest' ? 'No published rooms yet.' : 'No rooms visible yet.')
      : listed.length === 2 && filter !== 'all' ? 'No rooms in this category.' : null;

  const open = (id: string) => {
    const building = scene.buildings.find(item => item.id === id);
    const route = building && routeForBuilding(building);
    if (route) onNavigate(route);
  };

  return (
    <section className="city-view" aria-label="City Map">
      <h1 className="visually-hidden">Olimpyx city</h1>
      <div className="city-stage">
        <CityCanvas scene={scene} selectedId={diving?.key ?? null} filter={filter} label={label} reducedMotion={reducedMotion} paused={paused} controller={controller} onSelect={open} agents={agents} activity={activity} />
        <TargetLock target={dive?.phase === 'focusing' ? diving : null} />
      </div>
      {/* Phones (PROMPT §7): no legend, a simplified HUD. The Library and Pantheon stay reachable via the
          building directory below. */}
      {!phone && <CityLegend onOpen={open} praetorium={scene.buildings.some(building => building.kind === 'praetorium')} />}
      <aside className={`hud hud-directory${phone ? ' hud-directory-sheet' : ''}`} aria-label="Building directory">
        <button type="button" className="hud-directory-toggle" aria-expanded={directoryOpen} aria-controls="city-directory-panel" onClick={() => setDirectoryOpen(value => !value)}>
          <span>Buildings</span><span className="hud-badge" aria-hidden="true">{scene.buildings.length}</span><span aria-hidden="true">{directoryOpen ? '▴' : '▾'}</span>
        </button>
        <div id="city-directory-panel" className="hud-directory-panel" hidden={!directoryOpen}>
          <CityFilters filter={filter} counts={counts} onChange={setFilter} />
          <CityBuildingList buildings={listed} onSelect={open} emptyText={emptyText} />
        </div>
      </aside>
      <CityCameraControls controller={controller} />
    </section>
  );
}
