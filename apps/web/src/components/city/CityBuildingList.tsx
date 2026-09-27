import { useT } from '../../i18n';
import { accentStyle } from '../shared/accentStyle';
import { landmarkName, type CityBuilding } from './cityScene';
import { archetypeColorVar } from './roomArchetypes';

export function buildingIcon(building: CityBuilding): string {
  if (building.kind === 'library') return '◈';
  if (building.kind === 'pantheon') return '⦾';
  if (building.kind === 'praetorium') return '⛨';
  return building.archetype!.icon;
}

/** `t` is the caller's `useT()` translator, so this stays a plain, testable function. */
export function buildingKindLabel(building: CityBuilding, t: (key: string) => string): string {
  if (building.kind === 'library') return `${t('city.buildings.central_library')} · ${t('city.buildingKind.knowledge')}`;
  if (building.kind === 'pantheon') return `${t('city.buildings.pantheon')} · ${t('city.buildingKind.agents')}`;
  if (building.kind === 'praetorium') return `${t('city.buildings.praetorium')} · ${t('city.buildingKind.ownerControls')}`;
  return `${building.archetype!.nameEn} · ${t(`city.categories.${building.category}`)}`;
}

/**
 * Accessible counterpart of the canvas (PROMPT §3.В): every building is a focusable button, Enter or
 * Space opens its screen. Room titles are untrusted text and rendered as React text only.
 */
export function CityBuildingList({ buildings, onSelect, emptyText }: { buildings: CityBuilding[]; onSelect: (id: string) => void; emptyText: string | null }) {
  const { t } = useT();
  return (
    <nav className="city-directory" aria-label={t('city.buildingList.ariaLabel')}>
      <ul>
        {buildings.map(building => {
          const name = building.kind === 'room' ? building.label : landmarkName(building.kind);
          const kind = buildingKindLabel(building, t);
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
