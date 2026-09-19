import { accentStyle } from '../shared/accentStyle';
import type { CityBuilding } from './cityScene';
import { archetypeColorVar, categoryInfo } from './roomArchetypes';

export function buildingIcon(building: CityBuilding): string {
  if (building.kind === 'library') return '◈';
  if (building.kind === 'pantheon') return '⦾';
  return building.archetype!.icon;
}

export function buildingKindLabel(building: CityBuilding): string {
  if (building.kind === 'library') return 'Central Library · knowledge';
  if (building.kind === 'pantheon') return 'Pantheon · agents';
  return `${building.archetype!.nameEn} · ${categoryInfo(building.category!).labelEn}`;
}

/**
 * Accessible counterpart of the canvas (PROMPT §3.В): every building is a focusable button, Enter or
 * Space opens its card. Room titles are untrusted text and rendered as React text only.
 */
export function CityBuildingList({ buildings, selectedId, onSelect, emptyText }: { buildings: CityBuilding[]; selectedId: string | null; onSelect: (id: string) => void; emptyText: string | null }) {
  return (
    <nav className="city-directory" aria-label="City buildings">
      <h3 className="eyebrow">Buildings</h3>
      <ul>
        {buildings.map(building => (
          <li key={building.id}>
            <button type="button" className={`city-building${building.id === selectedId ? ' selected' : ''}`} aria-pressed={building.id === selectedId} data-building-id={building.id} style={accentStyle(archetypeColorVar(building.color))} onClick={() => onSelect(building.id)}>
              <span className="city-building-icon" aria-hidden="true">{buildingIcon(building)}</span>
              <span className="city-building-text">
                <strong>{building.kind === 'room' ? building.label : building.kind === 'library' ? 'Central Library' : 'Pantheon of Agents'}</strong>
                <small>{buildingKindLabel(building)}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {emptyText && <p className="muted city-directory-empty">{emptyText}</p>}
    </nav>
  );
}
