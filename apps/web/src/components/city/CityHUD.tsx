import type { CityCameraController } from './CityCanvas';
import { ROOM_CATEGORIES, type ArchetypeCategory } from './roomArchetypes';

export type CityFilter = ArchetypeCategory | 'all';

export function CityFilters({ filter, counts, onChange }: { filter: CityFilter; counts: Record<CityFilter, number>; onChange: (filter: CityFilter) => void }) {
  const options: Array<{ id: CityFilter; label: string; icon: string }> = [{ id: 'all', label: 'All', icon: '✦' }, ...ROOM_CATEGORIES.map(category => ({ id: category.id, label: category.labelEn, icon: category.icon }))];
  return (
    <div className="city-filters" role="group" aria-label="Filter buildings by category">
      {options.map(option => (
        <button key={option.id} type="button" className={`city-chip${filter === option.id ? ' active' : ''}`} aria-pressed={filter === option.id} onClick={() => onChange(option.id)}>
          <span aria-hidden="true">{option.icon}</span>{option.label}<span className="city-chip-count">{counts[option.id]}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Bottom-left legend of the key Forum buildings; each entry opens that building's screen. The Praetorium
 * entry appears only when the scene has one (signed-in owner), never for a guest.
 */
export function CityLegend({ onOpen, praetorium = false }: { onOpen: (buildingId: string) => void; praetorium?: boolean }) {
  return (
    <div className="hud hud-legend" role="group" aria-label="Key buildings">
      <button type="button" className="hud-legend-item legend-library" onClick={() => onOpen('library')}><span aria-hidden="true">◈</span>Library</button>
      <button type="button" className="hud-legend-item legend-pantheon" onClick={() => onOpen('pantheon')}><span aria-hidden="true">⦾</span>Pantheon</button>
      {praetorium && <button type="button" className="hud-legend-item legend-praetorium" onClick={() => onOpen('praetorium')}><span aria-hidden="true">⛨</span>Praetorium</button>}
    </div>
  );
}

/** Bottom-right D-pad camera and zoom: keyboard-accessible alternatives to drag and wheel. */
export function CityCameraControls({ controller }: { controller: { current: CityCameraController | null } }) {
  const act = (fn: (camera: CityCameraController) => void) => () => { if (controller.current) fn(controller.current); };
  return (
    <div className="hud city-camera" role="group" aria-label="Map camera">
      <button type="button" className="city-pan-up" onClick={act(c => c.panBy(0, -120))} aria-label="Pan up">▲</button>
      <button type="button" className="city-pan-left" onClick={act(c => c.panBy(-120, 0))} aria-label="Pan left">◀</button>
      <button type="button" className="city-reset" onClick={act(c => c.reset())} aria-label="Reset view">⊙</button>
      <button type="button" className="city-pan-right" onClick={act(c => c.panBy(120, 0))} aria-label="Pan right">▶</button>
      <button type="button" className="city-pan-down" onClick={act(c => c.panBy(0, 120))} aria-label="Pan down">▼</button>
      <button type="button" className="city-zoom-in" onClick={act(c => c.zoomBy(1.25))} aria-label="Zoom in">+</button>
      <button type="button" className="city-zoom-out" onClick={act(c => c.zoomBy(0.8))} aria-label="Zoom out">−</button>
    </div>
  );
}
