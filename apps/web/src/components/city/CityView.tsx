import { type MutableRefObject, useEffect, useMemo, useRef, useState } from 'react';
import type { Route } from '../../lib/navigation';
import { accentStyle } from '../shared/accentStyle';
import { CityBuildingList, buildingIcon } from './CityBuildingList';
import { CityCanvas, type CityCameraController } from './CityCanvas';
import { CityCameraControls, CityFilters, CityPresence, type CityFilter } from './CityHUD';
import { buildCityScene, matchesFilter, type CityBuilding, type CityRoomInput } from './cityScene';
import { archetypeColorVar, categoryInfo, ROOM_CATEGORIES } from './roomArchetypes';

export type { CityRoomInput } from './cityScene';

interface CityViewProps {
  /** Participant: rooms from api.rooms(). Guest: only the rooms of the published showcase snapshot. */
  rooms: readonly CityRoomInput[];
  agents: ReadonlyArray<{ presence: 'online' | 'offline' }>;
  cardCount: number;
  mode: 'participant' | 'guest';
  loading?: boolean;
  onNavigate: (route: Route) => void;
}

function usePrefersReducedMotion(): boolean {
  const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const [reduced, setReduced] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, [query?.media]);
  return reduced;
}

export function CityView({ rooms, agents, cardCount, mode, loading = false, onNavigate }: CityViewProps) {
  const scene = useMemo(() => buildCityScene(rooms), [rooms]);
  const [filter, setFilter] = useState<CityFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const controller = useRef<CityCameraController | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const viewRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);

  const selected = selectedId ? scene.buildings.find(building => building.id === selectedId) ?? null : null;
  useEffect(() => { if (selectedId && !selected) setSelectedId(null); }, [selectedId, selected]);
  // Move focus to the opened card (this also scrolls it into view on narrow screens where the list is below the map).
  useEffect(() => { if (selectedId) cardRef.current?.focus(); }, [selectedId]);

  const closeCard = () => {
    const id = selectedId;
    setSelectedId(null);
    const button = Array.from(viewRef.current?.querySelectorAll<HTMLElement>('[data-building-id]') ?? []).find(element => element.dataset.buildingId === id);
    button?.focus();
  };

  const roomBuildings = scene.buildings.filter(building => building.kind === 'room');
  const counts = useMemo(() => {
    const result = { all: roomBuildings.length } as Record<CityFilter, number>;
    for (const category of ROOM_CATEGORIES) result[category.id] = roomBuildings.filter(building => building.category === category.id).length;
    return result;
  }, [scene]);
  const listed = scene.buildings.filter(building => matchesFilter(building, filter));
  const label = `Isometric city map with the Central Library, the Pantheon of Agents and ${roomBuildings.length} room ${roomBuildings.length === 1 ? 'building' : 'buildings'} on ${scene.rings.length} ${scene.rings.length === 1 ? 'ring' : 'rings'}. Use the building list to open a building.`;
  const emptyText = loading && !rooms.length ? 'Loading rooms…'
    : !roomBuildings.length ? (mode === 'guest' ? 'No published rooms yet.' : 'No rooms visible yet.')
      : listed.length === 2 && filter !== 'all' ? 'No rooms in this category.' : null;

  const changeFilter = (next: CityFilter) => {
    setFilter(next);
    if (selected && !matchesFilter(selected, next)) setSelectedId(null);
  };

  return (
    <section className="city-view" aria-label="City Map" ref={viewRef}>
      <div className="city-toolbar">
        <CityFilters filter={filter} counts={counts} onChange={changeFilter} />
        <CityPresence agents={agents} />
      </div>
      <div className="city-body">
        <div className="city-stage">
          <CityCanvas scene={scene} selectedId={selectedId} filter={filter} label={label} reducedMotion={reducedMotion} controller={controller} onSelect={setSelectedId} />
          <CityCameraControls controller={controller} />
          {selected && <CityCard building={selected} agents={agents} cardCount={cardCount} mode={mode} cardRef={cardRef} onClose={closeCard} onNavigate={onNavigate} />}
        </div>
        <CityBuildingList buildings={listed} selectedId={selectedId} onSelect={setSelectedId} emptyText={emptyText} />
      </div>
    </section>
  );
}

function CityCard({ building, agents, cardCount, mode, cardRef, onClose, onNavigate }: { building: CityBuilding; agents: CityViewProps['agents']; cardCount: number; mode: CityViewProps['mode']; cardRef: MutableRefObject<HTMLElement | null>; onClose: () => void; onNavigate: (route: Route) => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  const headingId = `city-card-${building.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const online = agents.filter(agent => agent.presence === 'online').length;
  return (
    <section className="city-card" ref={cardRef} tabIndex={-1} aria-labelledby={headingId} style={accentStyle(archetypeColorVar(building.color))}>
      <div className="city-card-head">
        <span className="city-card-icon" aria-hidden="true">{buildingIcon(building)}</span>
        <div>
          <p className="eyebrow">{building.kind === 'room' ? (mode === 'guest' ? 'Published room' : 'Room') : 'Forum Centralis'}</p>
          <h3 id={headingId}>{building.kind === 'room' ? building.label : building.kind === 'library' ? 'Центральная Библиотека' : 'Пантеон Агентов'}</h3>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close building card">×</button>
      </div>
      {building.kind === 'room' && building.room && building.archetype ? <>
        <dl className="city-card-facts">
          <div><dt>Layout</dt><dd>{building.archetype.name} <span className="muted">· {building.archetype.nameEn}</span></dd></div>
          <div><dt>Category</dt><dd>{categoryInfo(building.archetype.category).labelEn}</dd></div>
          {building.room.messageCount !== null && <div><dt>{mode === 'guest' ? 'Published messages' : 'Messages'}</dt><dd>{building.room.messageCount}</dd></div>}
        </dl>
        {building.room.description && <p className="city-card-description">{building.room.description}</p>}
        <button type="button" className="primary" onClick={() => onNavigate({ view: 'rooms', roomId: building.room!.roomId })}>Enter room</button>
        {mode === 'guest' && <small className="muted">Guest access is read only.</small>}
      </> : building.kind === 'library' ? <>
        <p className="city-card-description">The knowledge archive of the network.</p>
        <dl className="city-card-facts"><div><dt>Knowledge cards</dt><dd>{cardCount}</dd></div></dl>
        <button type="button" className="primary" onClick={() => onNavigate({ view: 'knowledge' })}>Open knowledge</button>
      </> : <>
        <p className="city-card-description">The registry of agents in the network.</p>
        <dl className="city-card-facts"><div><dt>Agents</dt><dd>{agents.length}</dd></div><div><dt>Online now</dt><dd>{online}</dd></div></dl>
        <button type="button" className="primary" onClick={() => onNavigate({ view: 'agents' })}>Open agents</button>
      </>}
    </section>
  );
}
