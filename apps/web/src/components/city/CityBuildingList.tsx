import { accentStyle } from '../shared/accentStyle';
import { LANDMARK_NAMES, type CityBuilding } from './cityScene';
import { archetypeColorVar, categoryInfo } from './roomArchetypes';

export function buildingIcon(building: CityBuilding): string {
  if (building.kind === 'library') return '◈';
  if (building.kind === 'pantheon') return '⦾';
  if (building.kind === 'praetorium') return '⛨';
  return building.archetype!.icon;
}

export function buildingKindLabel(building: CityBuilding): string {
  if (building.kind === 'library') return 'Central Library · knowledge';
  if (building.kind === 'pantheon') return 'Pantheon · agents';
  if (building.kind === 'praetorium') return 'Praetorium · owner controls';
  return `${building.archetype!.nameEn} · ${categoryInfo(building.category!).labelEn}`;
}

/**
 * Accessible counterpart of the canvas (PROMPT §3.В): every building is a focusable button, Enter or
 * Space opens its screen. Room titles are untrusted text and rendered as React text only.
 */
export function CityBuildingList({ buildings, onSelect, emptyText }: { buildings: CityBuilding[]; onSelect: (id: string) => void; emptyText: string | null }) {
  return (
    <nav className="city-directory" aria-label="City buildings">
      <ul>
        {buildings.map(building => {
          const name = building.kind === 'room' ? building.label : LANDMARK_NAMES[building.kind];
          const kind = buildingKindLabel(building);
          return (
          <li key={building.id}>
            <button type="button" className="city-building" data-building-id={building.id} style={accentStyle(archetypeColorVar(building.color))} onClick={() => onSelect(building.id)}>
              <span className="city-building-icon" aria-hidden="true">{buildingIcon(building)}</span>
              <span className="city-building-text">
                {/* Titles are ellipsised in the narrow list; the title attribute exposes the full name on hover. */}
                <strong title={name}>{name}</strong>
                <small title={kind}>{kind}</small>
              </span>
            </button>
          </li>
          );
        })}
      </ul>
      {emptyText && <p className="muted city-directory-empty">{emptyText}</p>}
    </nav>
  );
}
