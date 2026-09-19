import { describe, expect, it } from 'vitest';
import {
  COS30, SIN30, boxInViewport, clampZoom, diveCamera, fitZoom, footprintScreenBox, hitTest, isoProject, layoutRings, painterSort, ringCountFor, ringSpec,
  screenToWorld, shouldRefitZoom, worldToScreen, MAX_ZOOM, MIN_ZOOM, type Camera, type ScreenBox,
} from './isometricMath';

const view = { width: 1000, height: 800 };
const close = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 6);

describe('isometric projection', () => {
  it('uses the 30° formula isoX = (x − y)·cos(π/6), isoY = (x + y)·sin(π/6) − z', () => {
    const point = isoProject(100, 40, 10);
    close(point.x, 60 * COS30);
    close(point.y, 140 * SIN30 - 10);
  });

  it('maps the camera focal point to the viewport centre and scales by zoom', () => {
    const camera: Camera = { focalX: 0, focalY: 0, zoom: 1 };
    expect(worldToScreen(0, 0, 0, camera, view)).toEqual({ x: 500, y: 400 });
    const zoomed = worldToScreen(100, 0, 0, { focalX: 0, focalY: 0, zoom: 2 }, view);
    close(zoomed.x, 500 + 100 * COS30 * 2);
    close(zoomed.y, 400 + 100 * SIN30 * 2);
  });

  it('screenToWorld inverts worldToScreen on the ground plane for any camera offset and zoom', () => {
    const cameras: Camera[] = [{ focalX: 0, focalY: 0, zoom: 1 }, { focalX: 120, focalY: -75, zoom: 0.4 }, { focalX: -300, focalY: 210, zoom: 2.3 }];
    for (const camera of cameras) for (const [x, y] of [[0, 0], [520, -80], [-1040, 333], [12.5, 780]]) {
      const screen = worldToScreen(x, y, 0, camera, view);
      const world = screenToWorld(screen.x, screen.y, camera, view);
      close(world.x, x);
      close(world.y, y);
    }
  });
});

describe('painter sort', () => {
  it('draws far objects (smaller x + y) first and keeps input order on ties', () => {
    const items = [{ id: 'near', x: 100, y: 100 }, { id: 'far', x: -100, y: -100 }, { id: 'tieA', x: 50, y: -50 }, { id: 'tieB', x: -50, y: 50 }];
    expect(painterSort(items).map(item => item.id)).toEqual(['far', 'tieA', 'tieB', 'near']);
    expect(items[0].id).toBe('near'); // input not mutated
  });

  it('puts the Library (y = −80) behind the Pantheon (y = +80)', () => {
    expect(painterSort([{ id: 'pantheon', x: 0, y: 80 }, { id: 'library', x: 0, y: -80 }]).map(item => item.id)).toEqual(['library', 'pantheon']);
  });
});

describe('ring layout', () => {
  it('uses R0 520/6, R1 780/10, R2 1040/14', () => {
    expect([0, 1, 2].map(ringSpec)).toEqual([{ radius: 520, capacity: 6 }, { radius: 780, capacity: 10 }, { radius: 1040, capacity: 14 }]);
  });

  it('fills rings in order and places every slot on its radius', () => {
    const slots = layoutRings(30);
    expect(slots.filter(slot => slot.ring === 0)).toHaveLength(6);
    expect(slots.filter(slot => slot.ring === 1)).toHaveLength(10);
    expect(slots.filter(slot => slot.ring === 2)).toHaveLength(14);
    for (const slot of slots) close(Math.hypot(slot.x, slot.y), slot.radius);
  });

  it('spaces n items evenly and shifts ring i by i·π/n', () => {
    const slots = layoutRings(16).filter(slot => slot.ring === 1);
    const step = (2 * Math.PI) / 10;
    slots.forEach((slot, index) => close(slot.angle, -Math.PI / 2 + index * step + Math.PI / 10));
    const ring0 = layoutRings(6);
    close(ring0[0].angle, -Math.PI / 2);
  });

  it('keeps neighbouring rings off a shared avenue when fully populated', () => {
    const slots = layoutRings(30);
    const norm = (angle: number) => ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const ring0 = slots.filter(slot => slot.ring === 0).map(slot => norm(slot.angle));
    const ring1 = slots.filter(slot => slot.ring === 1).map(slot => norm(slot.angle));
    for (const a of ring0) for (const b of ring1) expect(Math.abs(a - b)).toBeGreaterThan(0.05);
  });

  it('>30 rooms: adds further rings with the same radius and capacity step so nothing is hidden', () => {
    const slots = layoutRings(31);
    expect(slots).toHaveLength(31);
    expect(slots[30]).toMatchObject({ ring: 3, radius: 1300, count: 1 });
    expect(ringSpec(3)).toEqual({ radius: 1300, capacity: 18 });
    const big = layoutRings(100);
    expect(big).toHaveLength(100);
    expect(ringCountFor(100)).toBe(big.at(-1)!.ring + 1);
    expect(new Set(big.map(slot => `${slot.ring}:${slot.slot}`)).size).toBe(100);
  });

  it('handles empty and partial rings', () => {
    expect(layoutRings(0)).toEqual([]);
    expect(ringCountFor(0)).toBe(0);
    const three = layoutRings(3);
    expect(three.every(slot => slot.ring === 0 && slot.count === 3)).toBe(true);
    close(three[1].angle - three[0].angle, (2 * Math.PI) / 3);
  });
});

describe('camera helpers', () => {
  it('clamps zoom', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
  });

  it('fitZoom keeps the outer ring inside the viewport', () => {
    const zoom = fitZoom(1040, view);
    const camera = { focalX: 0, focalY: 0, zoom };
    for (let index = 0; index < 32; index++) {
      const angle = (index / 32) * 2 * Math.PI;
      const point = worldToScreen(Math.cos(angle) * 1040, Math.sin(angle) * 1040, 0, camera, view);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(view.width);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(view.height);
    }
    expect(fitZoom(1040, { width: 0, height: 0 })).toBe(1);
  });

  it('dives in two monotonic phases: glide first, then zoom, ending exactly on target', () => {
    const from = { focalX: 0, focalY: 0, zoom: 0.5 };
    const to = { focalX: 300, focalY: -120, zoom: 1.5 };
    const half = diveCamera(from, to, 0.5);
    expect(half).toEqual({ focalX: 300, focalY: -120, zoom: 0.5 });
    expect(diveCamera(from, to, 1)).toEqual(to);
    expect(diveCamera(from, to, 0)).toEqual(from);
    let previous = diveCamera(from, to, 0);
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const next = diveCamera(from, to, t);
      expect(next.focalX).toBeGreaterThanOrEqual(previous.focalX - 1e-9);
      expect(next.zoom).toBeGreaterThanOrEqual(previous.zoom - 1e-9);
      previous = next;
    }
  });

  it('hit-tests the frontmost building under the pointer', () => {
    const camera = { focalX: 0, focalY: 0, zoom: 1 };
    const back = { id: 'back', x: 0, y: 0, size: 40, height: 100 };
    const front = { id: 'front', x: 20, y: 20, size: 40, height: 100 };
    const centre = worldToScreen(0, 0, 20, camera, view);
    expect(hitTest(painterSort([front, back]), centre.x, centre.y, camera, view)?.id).toBe('front');
    expect(hitTest([back], 0, 0, camera, view)).toBeNull();
  });

  it('walks the draw order back to front and returns the first (topmost) hit', () => {
    const camera = { focalX: 0, focalY: 0, zoom: 1 };
    const a = { id: 'a', x: 0, y: 0, size: 40, height: 100 };
    const b = { id: 'b', x: 0, y: 0, size: 40, height: 100 }; // same spot: the later entry is drawn on top
    const centre = worldToScreen(0, 0, 20, camera, view);
    expect(hitTest([a, b], centre.x, centre.y, camera, view)?.id).toBe('b');
    expect(hitTest([b, a], centre.x, centre.y, camera, view)?.id).toBe('a');
    // Early return: items before the hit are never inspected.
    const touched: string[] = [];
    const spy = (item: typeof a) => new Proxy(item, { get: (target, key) => { if (key === 'x') touched.push(target.id); return target[key as keyof typeof a]; } });
    hitTest([spy({ ...a, id: 'first' }), spy({ ...b, id: 'last' })], centre.x, centre.y, camera, view);
    expect(touched).toEqual(['last']);
  });

  it('matches painterSort order: a hit on overlapping buildings picks the nearer one', () => {
    const camera = { focalX: 0, focalY: 0, zoom: 1 };
    const items = [{ id: 'near', x: 30, y: 30, size: 46, height: 80 }, { id: 'far', x: -30, y: -30, size: 46, height: 80 }];
    const middle = worldToScreen(0, 0, 40, camera, view);
    expect(hitTest(painterSort(items), middle.x, middle.y, camera, view)?.id).toBe('near');
  });
});

describe('worldToScreen scratch output', () => {
  it('writes into the provided point and returns it', () => {
    const camera = { focalX: 12, focalY: -7, zoom: 0.8 };
    const out = { x: 0, y: 0 };
    const result = worldToScreen(100, -40, 25, camera, view, out);
    expect(result).toBe(out);
    expect(out).toEqual(worldToScreen(100, -40, 25, camera, view));
  });
});

describe('culling predicate', () => {
  const camera = { focalX: 0, focalY: 0, zoom: 1 };
  const box: ScreenBox = { left: 0, top: 0, right: 0, bottom: 0 };

  it('keeps a building at the centre and one overhanging the edge', () => {
    expect(boxInViewport(footprintScreenBox(0, 0, 50, 100, camera, view, box), view)).toBe(true);
    const edge = { left: -30, top: 100, right: 10, bottom: 200 };
    expect(boxInViewport(edge, view)).toBe(true);
  });

  it('rejects boxes fully outside the viewport, unless within the margin', () => {
    expect(boxInViewport({ left: -80, top: 100, right: -20, bottom: 200 }, view)).toBe(false);
    expect(boxInViewport({ left: -80, top: 100, right: -20, bottom: 200 }, view, 48)).toBe(true);
    expect(boxInViewport({ left: 1100, top: 100, right: 1200, bottom: 200 }, view, 48)).toBe(false);
    expect(boxInViewport({ left: 100, top: 900, right: 200, bottom: 1000 }, view, 48)).toBe(false);
    expect(boxInViewport({ left: 100, top: -400, right: 200, bottom: -100 }, view, 48)).toBe(false);
  });

  it('footprint box contains the projected footprint and the top of the building', () => {
    const b = footprintScreenBox(300, -100, 50, 120, { focalX: 40, focalY: 10, zoom: 0.7 }, view, box);
    const cam = { focalX: 40, focalY: 10, zoom: 0.7 };
    for (let index = 0; index < 16; index++) {
      const angle = (index / 16) * 2 * Math.PI;
      for (const z of [0, 120]) {
        const p = worldToScreen(300 + Math.cos(angle) * 50, -100 + Math.sin(angle) * 50, z, cam, view);
        expect(p.x).toBeGreaterThanOrEqual(b.left - 1e-9);
        expect(p.x).toBeLessThanOrEqual(b.right + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(b.top - 1e-9);
        expect(p.y).toBeLessThanOrEqual(b.bottom + 1e-9);
      }
    }
  });
});

describe('zoom re-fit condition', () => {
  it('re-fits on first scene and when the ring footprint changes, not for a new rooms array of the same size', () => {
    const one = { outerRadius: 520, rings: [520] };
    expect(shouldRefitZoom(null, one)).toBe(true);
    expect(shouldRefitZoom(one, { outerRadius: 520, rings: [520] })).toBe(false);
    expect(shouldRefitZoom(one, { outerRadius: 780, rings: [520, 780] })).toBe(true);
    expect(shouldRefitZoom({ outerRadius: 780, rings: [520, 780] }, one)).toBe(true);
  });
});
