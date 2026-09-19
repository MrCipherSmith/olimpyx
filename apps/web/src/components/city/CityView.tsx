import { useEffect, useMemo, useRef, useState } from 'react';
import type { Route } from '../../lib/navigation';
import { CityBuildingList } from './CityBuildingList';
import { CityCanvas, type CityCameraController } from './CityCanvas';
import { CityCameraControls, CityFilters, CityLegend, type CityFilter } from './CityHUD';
import { buildCityScene, matchesFilter, type CityBuilding, type CityRoomInput } from './cityScene';
import { ROOM_CATEGORIES } from './roomArchetypes';

export type { CityRoomInput } from './cityScene';

interface CityViewProps {
  /** Participant: rooms from api.rooms(). Guest: only the rooms of the published showcase snapshot. */
  rooms: readonly CityRoomInput[];
  mode: 'participant' | 'guest';
  loading?: boolean;
  /** A screen layer covers the city: the render loop stops until it is visible again. */
  paused?: boolean;
  onNavigate: (route: Route) => void;
}

function usePrefersReducedMotion(): boolean {
  // One MediaQueryList per mount instead of a new matchMedia() on every render.
  const query = useMemo(() => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null), []);
  const [reduced, setReduced] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, [query]);
  return reduced;
}

/** The screen a building opens: its room, the Library (knowledge) or the Pantheon (agents). */
export function routeForBuilding(building: CityBuilding): Route {
  if (building.kind === 'library') return { view: 'knowledge' };
  if (building.kind === 'pantheon') return { view: 'agents' };
  return { view: 'rooms', roomId: building.room!.roomId };
}

/**
 * The persistent city behind every screen: the full-bleed canvas plus its floating HUD parts (legend,
 * building directory, camera). Clicking a building, a legend entry or a directory entry opens its screen.
 */
export function CityView({ rooms, mode, loading = false, paused = false, onNavigate }: CityViewProps) {
  const scene = useMemo(() => buildCityScene(rooms), [rooms]);
  const [filter, setFilter] = useState<CityFilter>('all');
  const [directoryOpen, setDirectoryOpen] = useState(true);
  const controller = useRef<CityCameraController | null>(null);
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
    if (building) onNavigate(routeForBuilding(building));
  };

  return (
    <section className="city-view" aria-label="City Map">
      <h1 className="visually-hidden">Olimpyx city</h1>
      <div className="city-stage">
        <CityCanvas scene={scene} selectedId={null} filter={filter} label={label} reducedMotion={reducedMotion} paused={paused} controller={controller} onSelect={open} />
      </div>
      <CityLegend onOpen={open} />
      <aside className="hud hud-directory" aria-label="Building directory">
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
