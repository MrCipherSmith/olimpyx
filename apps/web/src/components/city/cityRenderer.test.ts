import { describe, expect, it, vi } from 'vitest';
import { buildingOnScreen, createRenderCache, renderCity, staticLayerStale, truncateLabel, type StaticLayerKey } from './cityRenderer';
import { buildCityScene } from './cityScene';
import { painterSort } from './isometricMath';
import type { CityPalette } from './cityTokens';
import { shouldSkipFrame, DECORATIVE_FRAME_MS } from './cityLoop';

describe('truncateLabel', () => {
  it('collapses whitespace and keeps short labels as is', () => {
    expect(truncateLabel('  Consensus \n\t Hall ')).toBe('Consensus Hall');
  });

  it('truncates by code points and never splits a surrogate pair', () => {
    const emoji = '😀'.repeat(30);
    const result = truncateLabel(emoji, 10);
    expect(Array.from(result)).toHaveLength(10);
    expect(result.endsWith('…')).toBe(true);
    expect(result).toBe(`${'😀'.repeat(9)}…`);
    // No lone surrogates anywhere in the output.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result)).toBe(false);
    expect(truncateLabel('a😀'.repeat(5), 26)).toBe('a😀'.repeat(5)); // 10 code points: untouched
  });

  it('strips bidi embedding, override and isolate controls', () => {
    const controls = '‪‫‬‭‮⁦⁧⁨⁩';
    expect(truncateLabel(`‮gnp.exe${controls} room`)).toBe('gnp.exe room');
    expect(/[‪-‮⁦-⁩]/.test(truncateLabel(`${controls}x`.repeat(20)))).toBe(false);
  });

  it('counts the limit after stripping controls', () => {
    expect(truncateLabel(`${'⁧'.repeat(40)}short`, 10)).toBe('short');
  });
});

describe('scene draw order', () => {
  it('buildCityScene sorts once into painter order and precomputes room data', () => {
    const scene = buildCityScene(Array.from({ length: 12 }, (_, index) => ({ room_id: `rom_${index}`, title: `Room ${index}` })));
    expect(scene.drawOrder.map(building => building.id)).toEqual(painterSort(scene.buildings).map(building => building.id));
    for (let index = 1; index < scene.drawOrder.length; index++) {
      const previous = scene.drawOrder[index - 1];
      const current = scene.drawOrder[index];
      expect(previous.x + previous.y).toBeLessThanOrEqual(current.x + current.y);
    }
    expect(scene.roomBuildings).toHaveLength(12);
    expect(scene.roomAvenues).toHaveLength(12);
    expect(scene.avenues).toHaveLength(16);
    const first = scene.roomBuildings[0];
    expect(scene.roomAvenues[0].cos * scene.roomAvenues[0].length).toBeCloseTo(first.x, 6);
    expect(scene.roomAvenues[0].sin * scene.roomAvenues[0].length).toBeCloseTo(first.y, 6);
  });
});

describe('building culling', () => {
  const scene = buildCityScene([{ room_id: 'rom_a', title: 'A' }]);
  const library = scene.buildings.find(building => building.kind === 'library')!;
  const view = { width: 800, height: 500 };

  it('keeps buildings in view and culls those far outside', () => {
    expect(buildingOnScreen(library, { focalX: 0, focalY: 0, zoom: 1 }, view)).toBe(true);
    expect(buildingOnScreen(library, { focalX: 5000, focalY: 0, zoom: 1 }, view)).toBe(false);
    expect(buildingOnScreen(library, { focalX: 0, focalY: -5000, zoom: 1 }, view)).toBe(false);
  });

  it('keeps the Pantheon while only its light beam reaches into view', () => {
    const pantheon = scene.buildings.find(building => building.kind === 'pantheon')!;
    // Camera placed so the footprint is below the viewport but the beam (up to ~z 360) is not.
    const camera = { focalX: 0, focalY: 40 - 500 / 2 - 60, zoom: 1 };
    expect(buildingOnScreen(pantheon, camera, view)).toBe(true);
  });
});

describe('static layer cache', () => {
  const scene = buildCityScene([]);
  const palette = {} as CityPalette;
  const key: StaticLayerKey = { scene, palette, focalX: 0, focalY: 0, zoom: 1, width: 800, height: 500, dpr: 2 };

  it('is stale only when camera, scene, palette, viewport or DPR change', () => {
    expect(staticLayerStale(null, key)).toBe(true);
    expect(staticLayerStale(key, { ...key })).toBe(false);
    for (const change of [{ focalX: 1 }, { focalY: 1 }, { zoom: 1.1 }, { width: 801 }, { height: 499 }, { dpr: 1 }, { scene: buildCityScene([]) }, { palette: {} as CityPalette }]) {
      expect(staticLayerStale(key, { ...key, ...change })).toBe(true);
    }
  });

  it('renders without shadowBlur, redraws the ground only when stale and measures labels once', () => {
    const gradient = { addColorStop: vi.fn() };
    const assigned = new Set<string>();
    const makeCtx = (calls: Record<string, number>) => new Proxy({ measureText: () => { calls.measureText = (calls.measureText ?? 0) + 1; return { width: 40 }; }, createRadialGradient: () => gradient, createLinearGradient: () => gradient } as Record<string, unknown>, {
      get: (target, prop: string) => (prop in target ? target[prop] : () => { calls[prop] = (calls[prop] ?? 0) + 1; }),
      set: (target, prop: string, value) => { assigned.add(prop); target[prop] = value; return true; },
    }) as unknown as CanvasRenderingContext2D;
    // Offscreen canvases (static layer, glow sprites) get their own recorder.
    const layerCalls: Record<string, number> = {};
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => makeCtx(layerCalls) as never);
    try {
      const calls: Record<string, number> = {};
      const ctx = makeCtx(calls);
      const rooms = buildCityScene(Array.from({ length: 4 }, (_, index) => ({ room_id: `rom_${index}`, title: `Room ${index}` })));
      const cache = createRenderCache();
      const frame = { scene: rooms, camera: { focalX: 0, focalY: 0, zoom: 1 }, view: { width: 800, height: 500 }, palette: { ground: '#000' } as CityPalette, time: 0, animate: true, hoveredId: 'library', selectedId: 'room:rom_0', filter: 'all' as const, particles: 4, dpr: 1, cache };
      renderCity(ctx, frame);
      const groundPaints = layerCalls.clearRect;
      const measured = calls.measureText;
      expect(groundPaints).toBe(1);
      expect(measured).toBeGreaterThan(0);
      renderCity(ctx, { ...frame, time: 100 });
      expect(layerCalls.clearRect).toBe(1); // ground layer reused, not repainted
      expect(calls.measureText).toBe(measured); // label widths cached
      renderCity(ctx, { ...frame, camera: { focalX: 10, focalY: 0, zoom: 1 } });
      expect(layerCalls.clearRect).toBe(2); // camera moved: ground rebuilt
      expect(assigned.has('shadowBlur')).toBe(false);
      expect(calls.drawImage).toBeGreaterThan(3); // ground layer blits + glow sprites
    } finally {
      spy.mockRestore();
    }
  });
});

describe('decorative frame cap', () => {
  it('skips purely decorative frames inside the ~30 fps window only', () => {
    const base = { now: 1000, lastDraw: 1000 - DECORATIVE_FRAME_MS + 5, dirty: false, animating: false, dragging: false };
    expect(shouldSkipFrame(base)).toBe(true);
    expect(shouldSkipFrame({ ...base, now: 1000 + 10, lastDraw: 1000 - DECORATIVE_FRAME_MS })).toBe(false);
    expect(shouldSkipFrame({ ...base, dirty: true })).toBe(false);
    expect(shouldSkipFrame({ ...base, animating: true })).toBe(false);
    expect(shouldSkipFrame({ ...base, dragging: true })).toBe(false);
  });
});
