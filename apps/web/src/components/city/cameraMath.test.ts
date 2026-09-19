import { describe, expect, it } from 'vitest';
import { CITY_FOCAL, DIVE_ZOOM, divePointCamera, easeIn, freeRect, hudSafeFit, lerpCamera, occludersFrom } from './cameraMath';
import { COS30, SIN30, fitZoom, isoProject, worldToScreen, type ScreenBox, type Viewport } from './isometricMath';

const view: Viewport = { width: 1440, height: 900 };
/** The desktop HUD panels: main card (top left), legend (bottom left), directory (top right), camera (bottom right). */
const hud: ScreenBox[] = [
  { left: 20, top: 20, right: 320, bottom: 560 },
  { left: 20, top: 834, right: 260, bottom: 880 },
  { left: 1130, top: 20, right: 1420, bottom: 690 },
  { left: 1292, top: 710, right: 1420, bottom: 880 },
];
const RADIUS = 520;

/** Screen box of the fitted city disc plus building headroom, as fitZoom budgets it. */
function sceneBox(radius: number, camera: ReturnType<typeof hudSafeFit>, viewport: Viewport): ScreenBox {
  const centre = worldToScreen(0, 0, 0, camera, viewport);
  const halfWidth = radius * Math.SQRT2 * COS30 * camera.zoom;
  const halfHeight = (radius * Math.SQRT2 * SIN30 + 110) * camera.zoom;
  return { left: centre.x - halfWidth, right: centre.x + halfWidth, top: centre.y - halfHeight, bottom: centre.y + halfHeight };
}

const intersects = (a: ScreenBox, b: ScreenBox) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe('HUD-safe camera fit', () => {
  it('without HUD panels equals the plain whole-viewport fit centred on the city', () => {
    const camera = hudSafeFit(RADIUS, view, []);
    expect(camera).toEqual({ focalX: CITY_FOCAL.x, focalY: CITY_FOCAL.y, zoom: fitZoom(RADIUS, view) });
  });

  it('keeps the whole scene inside the area no HUD panel covers', () => {
    const camera = hudSafeFit(RADIUS, view, hud);
    const box = sceneBox(RADIUS, camera, view);
    for (const panel of hud) expect(intersects(box, panel)).toBe(false);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(view.width);
    expect(camera.zoom).toBeLessThan(fitZoom(RADIUS, view));
    expect(camera.zoom).toBeGreaterThan(0.3 * fitZoom(RADIUS, view));
  });

  it('centres the city in the free area, between the left and right HUD columns', () => {
    const area = freeRect(view, hud, RADIUS);
    expect(area.left).toBeGreaterThanOrEqual(320);
    expect(area.right).toBeLessThanOrEqual(1130);
    const camera = hudSafeFit(RADIUS, view, hud);
    const centre = worldToScreen(0, 0, 0, camera, view);
    expect(centre.x).toBeCloseTo((area.left + area.right) / 2, 0);
  });

  it('falls back to the whole viewport when panels leave too little room', () => {
    const tiny: Viewport = { width: 400, height: 300 };
    expect(freeRect(tiny, [{ left: 0, top: 0, right: 300, bottom: 250 }], RADIUS)).toEqual({ left: 0, top: 0, right: 400, bottom: 300 });
  });
});

describe('occluders from HUD panel rectangles', () => {
  it('converts to canvas coordinates, clips to the canvas and drops hidden or outside panels', () => {
    const canvas = { left: 10, top: 5, right: 810, bottom: 505, width: 800, height: 500 };
    const boxes = occludersFrom(canvas, [
      { left: 20, top: 15, right: 120, bottom: 115, width: 100, height: 100 },
      { left: 700, top: 400, right: 900, bottom: 600, width: 200, height: 200 },
      { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
      { left: 10, top: 600, right: 200, bottom: 700, width: 190, height: 100 },
    ]);
    expect(boxes).toEqual([{ left: 10, top: 10, right: 110, bottom: 110 }, { left: 690, top: 395, right: 800, bottom: 500 }]);
  });
});

describe('dive camera', () => {
  it('aims at the building point at the dive zoom', () => {
    const iso = isoProject(100, 50, 40);
    expect(divePointCamera({ x: 100, y: 50, z: 40 }, DIVE_ZOOM)).toEqual({ focalX: iso.x, focalY: iso.y, zoom: DIVE_ZOOM });
  });

  it('interpolates between the endpoints with the zoom in log space', () => {
    const from = { focalX: 0, focalY: 0, zoom: 0.5 };
    const to = { focalX: 100, focalY: -50, zoom: 6.5 };
    expect(lerpCamera(from, to, 0)).toEqual(from);
    expect(lerpCamera(from, to, 1).zoom).toBeCloseTo(6.5);
    expect(lerpCamera(from, to, 1).focalX).toBeCloseTo(100);
    expect(lerpCamera(from, to, 0.5).zoom).toBeCloseTo(Math.sqrt(0.5 * 6.5));
    expect(lerpCamera(from, to, 0.5, easeIn).zoom).toBeLessThan(lerpCamera(from, to, 0.5).zoom);
  });
});
