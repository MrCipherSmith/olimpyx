import { describe, expect, it } from 'vitest';
import { buildCityScene, LIBRARY_POSITION, PANTHEON_POSITION, PLAZA_HALF, PRAETORIUM_POSITION, type CityBuilding, type CityScene } from './cityScene';
import { buildingScreenBox, layoutLabels, type PlacedLabel, type Rect } from './cityRenderer';
import { fitZoom, footprintScreenBox, isoProject, MAX_ZOOM, MIN_ZOOM, type Camera, type ScreenBox, type Viewport } from './isometricMath';

const rooms = (count: number) => Array.from({ length: count }, (_, index) => ({ room_id: `rom_${index}`, title: `Room number ${index} with a longer title` }));
const find = (scene: CityScene, kind: CityBuilding['kind']) => scene.buildings.find(building => building.kind === kind);
const intersects = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
/** Deterministic stand-in for canvas text metrics: ~7.2 px per code point plus padding. */
const measure = (building: CityBuilding, card: boolean) => Array.from(building.label).length * 7.2 + (card ? 22 : 14);

/** HUD panels of the desktop shell (top-left card, bottom-left legend, right directory, bottom-right camera). */
function hudRects(view: Viewport): Rect[] {
  return [
    { left: 16, top: 16, right: 316, bottom: 380 },
    { left: 16, top: view.height - 62, right: 330, bottom: view.height - 16 },
    { left: view.width - 290, top: 16, right: view.width - 16, bottom: 64 },
    { left: view.width - 164, top: view.height - 150, right: view.width - 16, bottom: view.height - 16 },
  ];
}

describe('Forum layout (City Shell §3)', () => {
  it('puts the Library and the Pantheon side by side on one screen-horizontal line', () => {
    const scene = buildCityScene(rooms(6));
    const library = find(scene, 'library')!;
    const pantheon = find(scene, 'pantheon')!;
    expect(library).toMatchObject(LIBRARY_POSITION);
    expect(pantheon).toMatchObject(PANTHEON_POSITION);
    const lib = isoProject(library.x, library.y);
    const pan = isoProject(pantheon.x, pantheon.y);
    expect(Math.abs(lib.y - pan.y)).toBeLessThan(10);
    expect(Math.abs(lib.x)).toBeGreaterThanOrEqual(150);
    expect(Math.abs(pan.x)).toBeGreaterThanOrEqual(150);
    expect(lib.x).toBeLessThan(0); // Library on the left, Pantheon on the right
    expect(pan.x).toBeGreaterThan(0);
  });

  it('keeps both landmarks on the square plaza', () => {
    const scene = buildCityScene([], { includePraetorium: true });
    expect(scene.plazaHalf).toBe(PLAZA_HALF);
    for (const kind of ['library', 'pantheon', 'praetorium'] as const) {
      const building = find(scene, kind)!;
      expect(Math.abs(building.x) + building.size).toBeLessThanOrEqual(PLAZA_HALF);
      expect(Math.abs(building.y) + building.size).toBeLessThanOrEqual(PLAZA_HALF);
    }
  });

  it('never overlaps the landmarks’ screen boxes, at any zoom', () => {
    const scene = buildCityScene(rooms(30), { includePraetorium: true });
    const landmarks = scene.buildings.filter(building => building.kind !== 'room');
    const view = { width: 1440, height: 900 };
    for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom += 0.07) {
      const camera: Camera = { focalX: 0, focalY: -20, zoom };
      const boxes = landmarks.map(building => buildingScreenBox(building, camera, view));
      for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
        expect(intersects(boxes[a], boxes[b]), `${landmarks[a].id} × ${landmarks[b].id} at zoom ${zoom.toFixed(2)}`).toBe(false);
      }
    }
  });
});

describe('Praetorium (owner only)', () => {
  it('is absent from the guest city and by default', () => {
    expect(find(buildCityScene(rooms(3)), 'praetorium')).toBeUndefined();
    expect(find(buildCityScene(rooms(3), { includePraetorium: false }), 'praetorium')).toBeUndefined();
  });

  it('stands at the front of the Forum when the owner flag is set', () => {
    const scene = buildCityScene(rooms(3), { includePraetorium: true });
    const praetorium = find(scene, 'praetorium')!;
    expect(praetorium).toMatchObject({ id: 'praetorium', shape: 'praetorium', ring: null, ...PRAETORIUM_POSITION });
    expect(isoProject(praetorium.x, praetorium.y).x).toBeCloseTo(0, 6);
    expect(scene.drawOrder).toContain(praetorium);
    expect(scene.roomBuildings).toHaveLength(3); // not counted as a room
    // Painter order: in front of both landmarks (larger x + y).
    expect(scene.drawOrder.indexOf(praetorium)).toBeGreaterThan(scene.drawOrder.indexOf(find(scene, 'pantheon')!));
  });
});

describe('Forum labels at the zooms the fit uses', () => {
  const viewports: Viewport[] = [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }];
  const cases = viewports.flatMap(view => [0, 6, 16, 30].flatMap(count => [false, true].map(owner => ({ view, count, owner }))));

  it.each(cases)('no overlaps: $view.width×$view.height, $count rooms, owner $owner', ({ view, count, owner }) => {
    const scene = buildCityScene(rooms(count), { includePraetorium: owner });
    const camera: Camera = { focalX: 0, focalY: -20, zoom: fitZoom(scene.outerRadius, view) };
    const occluders = hudRects(view);
    const out: PlacedLabel[] = [];
    const used = layoutLabels({ scene, camera, view, hoveredId: null, selectedId: null, filter: 'all', occluders }, measure, out);
    const visible = out.slice(0, used).filter(label => label.visible);
    // Landmark labels are always shown at the fitted zoom.
    for (const kind of owner ? ['library', 'pantheon', 'praetorium'] : ['library', 'pantheon']) {
      expect(visible.some(label => label.building.kind === kind), `${kind} label visible`).toBe(true);
    }
    // No label covers another label or a HUD panel.
    for (let a = 0; a < visible.length; a++) {
      for (const occluder of occluders) expect(intersects(visible[a], occluder), `${visible[a].building.id} under HUD`).toBe(false);
      for (let b = a + 1; b < visible.length; b++) expect(intersects(visible[a], visible[b]), `${visible[a].building.id} × ${visible[b].building.id}`).toBe(false);
    }
    // Neither landmark label covers the other landmark's body.
    const body = (building: CityBuilding): ScreenBox => footprintScreenBox(building.x, building.y, building.size, building.height, camera, view, { left: 0, top: 0, right: 0, bottom: 0 });
    const libraryLabel = visible.find(label => label.building.kind === 'library')!;
    const pantheonLabel = visible.find(label => label.building.kind === 'pantheon')!;
    expect(intersects(libraryLabel, body(find(scene, 'pantheon')!))).toBe(false);
    expect(intersects(pantheonLabel, body(find(scene, 'library')!))).toBe(false);
  });
});
