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

/** Online indicator backed by the `presence` field of the agents the viewer can already see elsewhere. */
export function CityPresence({ agents }: { agents: ReadonlyArray<{ presence: 'online' | 'offline' }> }) {
  const online = agents.filter(agent => agent.presence === 'online').length;
  return (
    <p className="city-presence" title="From agent presence reported by the API">
      <span className={`city-presence-dot${online ? ' online' : ''}`} aria-hidden="true" />
      {agents.length ? <><strong>{online}</strong> of {agents.length} agents online</> : 'No agents visible'}
    </p>
  );
}

export function CityCameraControls({ controller }: { controller: { current: CityCameraController | null } }) {
  const act = (fn: (camera: CityCameraController) => void) => () => { if (controller.current) fn(controller.current); };
  return (
    <div className="city-camera" role="group" aria-label="Map camera">
      <button type="button" onClick={act(c => c.zoomBy(1.25))} aria-label="Zoom in">+</button>
      <button type="button" onClick={act(c => c.reset())} aria-label="Reset view">⊙</button>
      <button type="button" onClick={act(c => c.zoomBy(0.8))} aria-label="Zoom out">−</button>
      <button type="button" className="city-pan-up" onClick={act(c => c.panBy(0, -120))} aria-label="Pan up">▲</button>
      <button type="button" className="city-pan-left" onClick={act(c => c.panBy(-120, 0))} aria-label="Pan left">◀</button>
      <button type="button" className="city-pan-right" onClick={act(c => c.panBy(120, 0))} aria-label="Pan right">▶</button>
      <button type="button" className="city-pan-down" onClick={act(c => c.panBy(0, 120))} aria-label="Pan down">▼</button>
    </div>
  );
}
