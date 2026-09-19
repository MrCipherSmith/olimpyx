import { describe, expect, it, vi } from 'vitest';
import { buildingOnScreen, cardSubline, clearLabelCache, createRenderCache, labelAt, layoutLabels, renderCity, staticLayerStale, truncateLabel, type LabelLayoutInput, type PlacedLabel, type Rect, type StaticLayerKey } from './cityRenderer';
import { buildCityScene, type CityBuilding } from './cityScene';
import { worldToScreen } from './isometricMath';
import { painterSort } from './isometricMath';
import type { CityPalette } from './cityTokens';
import { shouldSkipFrame, DECORATIVE_FRAME_MS } from './cityLoop';
import { planInhabitants } from './inhabitants';

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

  it('keeps a tall active-room building on screen while its halo (up to 0.8x height) still reaches the viewport, beyond the plain footprint reach', () => {
    // Tall room (telemetry_beacon-sized: size 46, height 150) sitting off-centre at zoom 1.3 — the sort
    // of "zoom > ~1.1" case where the active-building halo (drawBuilding: up to
    // max(size*1.6, height*0.8)*zoom + 14 screen px) reaches noticeably further sideways than the
    // isometric footprint box (reach 70) that culling used to key off alone.
    const tallRoom = { id: 'room:tall', kind: 'room' as const, shape: 'telemetry_beacon' as const, label: 'Beacon', color: 'gold' as const, x: 0, y: 0, size: 46, height: 150, ring: 0, angle: 0 };
    const zoom = 1.3;
    // Solved so the plain footprint box (reach 70, +CULL_MARGIN) sits just outside the viewport's right
    // edge, but a box that also covers the halo's reach still overlaps it.
    const camera = { focalX: -446.1538, focalY: 0, zoom };
    expect(buildingOnScreen(tallRoom, camera, view)).toBe(true);
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

  it('bypasses the static-layer cache while the camera is animating or being dragged, drawing the ground directly instead of rebuilding and blitting it every frame', () => {
    const gradient = { addColorStop: vi.fn() };
    const makeCtx = (calls: Record<string, number>) => new Proxy({ measureText: () => { calls.measureText = (calls.measureText ?? 0) + 1; return { width: 40 }; }, createRadialGradient: () => gradient, createLinearGradient: () => gradient } as Record<string, unknown>, {
      get: (target, prop: string) => (prop in target ? target[prop] : () => { calls[prop] = (calls[prop] ?? 0) + 1; }),
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    const layerCalls: Record<string, number> = {};
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => makeCtx(layerCalls) as never);
    try {
      const calls: Record<string, number> = {};
      const ctx = makeCtx(calls);
      const rooms = buildCityScene(Array.from({ length: 4 }, (_, index) => ({ room_id: `rom_${index}`, title: `Room ${index}` })));
      const cache = createRenderCache();
      const baseFrame = { scene: rooms, view: { width: 800, height: 500 }, palette: { ground: '#000' } as CityPalette, time: 0, animate: false, hoveredId: null, selectedId: null, filter: 'all' as const, particles: 0, dpr: 1, cache };

      // Two consecutive frames with a moving camera (as during a dive animation or a drag): the offscreen
      // layer must never be touched — a rebuild-then-blit every frame would cost more than drawing direct.
      renderCity(ctx, { ...baseFrame, camera: { focalX: 5, focalY: 0, zoom: 1 }, cameraMoving: true });
      expect(cache.layer).toBeUndefined();
      expect(calls.fillRect).toBeGreaterThan(0); // ground painted straight onto the main context
      const directPaints = calls.fillRect;

      renderCity(ctx, { ...baseFrame, camera: { focalX: 10, focalY: 0, zoom: 1 }, cameraMoving: true });
      expect(cache.layer).toBeUndefined();
      expect(calls.fillRect).toBeGreaterThan(directPaints);
      expect(layerCalls.clearRect).toBeUndefined(); // the offscreen layer was never created

      // Once idle again, the cache is (re)built and then reused normally.
      renderCity(ctx, { ...baseFrame, camera: { focalX: 10, focalY: 0, zoom: 1 } });
      expect(layerCalls.clearRect).toBe(1);
      renderCity(ctx, { ...baseFrame, camera: { focalX: 10, focalY: 0, zoom: 1 } });
      expect(layerCalls.clearRect).toBe(1); // reused, not rebuilt
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

/** Canvas stand-in that records calls and the arguments of fillText; offscreen canvases get their own recorder. */
function recordingCtx(calls: Record<string, number>, texts: string[] = [], assigned = new Set<string>()) {
  const gradient = { addColorStop: vi.fn() };
  return new Proxy({
    measureText: (text: string) => { calls.measureText = (calls.measureText ?? 0) + 1; return { width: Array.from(text).length * 7 }; },
    fillText: (text: string) => { texts.push(text); },
    createRadialGradient: () => gradient, createLinearGradient: () => gradient,
  } as Record<string, unknown>, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => { calls[prop] = (calls[prop] ?? 0) + 1; }),
    set: (target, prop: string, value) => { assigned.add(prop); target[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

const measure = (building: CityBuilding, card: boolean) => Array.from(building.label).length * 7 + (card ? 22 : 14);
const intersects = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe('label placement', () => {
  const view = { width: 1000, height: 700 };
  const camera = { focalX: 0, focalY: -20, zoom: 0.8 };
  const scene = buildCityScene([{ room_id: 'rom_a', title: 'Alpha room' }]);
  const base: LabelLayoutInput = { scene, camera, view, hoveredId: null, selectedId: null, filter: 'all' };
  const layout = (extra: Partial<LabelLayoutInput> = {}) => {
    const out: PlacedLabel[] = [];
    const count = layoutLabels({ ...base, ...extra }, measure, out);
    return out.slice(0, count);
  };
  const byId = (labels: PlacedLabel[], id: string) => labels.find(label => label.building.id === id)!;

  it('centres an unobstructed label on its anchor above the roof', () => {
    const library = byId(layout(), 'library');
    const anchor = worldToScreen(library.building.x, library.building.y, library.building.height + 26, camera, view);
    expect(library.visible).toBe(true);
    expect((library.left + library.right) / 2).toBeCloseTo(anchor.x, 6);
    expect((library.top + library.bottom) / 2).toBeCloseTo(anchor.y, 6);
  });

  it('nudges a label off a HUD occluder and never draws it underneath', () => {
    const free = byId(layout(), 'library');
    const occluder: Rect = { left: free.left - 10, top: free.top - 4, right: free.right + 10, bottom: free.bottom + 4 };
    const moved = byId(layout({ occluders: [occluder] }), 'library');
    expect(moved.visible).toBe(true);
    expect(intersects(moved, occluder)).toBe(false);
    expect(moved.bottom).toBeLessThanOrEqual(occluder.top); // moved up first
  });

  it('escapes sideways from a tall occluder and hides the label when nothing fits', () => {
    const free = byId(layout(), 'library');
    const column: Rect = { left: free.left - 20, top: -2000, right: free.left + 30, bottom: 2000 };
    const sideways = byId(layout({ occluders: [column] }), 'library');
    expect(sideways.visible).toBe(true);
    expect(intersects(sideways, column)).toBe(false);
    expect(sideways.top).toBeCloseTo(free.top, 6);
    const everything: Rect = { left: -5000, top: -5000, right: 5000, bottom: 5000 };
    expect(layout({ occluders: [everything] }).every(label => !label.visible)).toBe(true);
  });

  it('never lets two labels overlap: the lower-priority one is nudged or hidden', () => {
    // Zoomed far out, every label converges on the centre of the screen.
    const labels = layout({ camera: { focalX: 0, focalY: 0, zoom: MIN_TEST_ZOOM } });
    const visible = labels.filter(label => label.visible);
    for (let a = 0; a < visible.length; a++) for (let b = a + 1; b < visible.length; b++) expect(intersects(visible[a], visible[b])).toBe(false);
    expect(byId(labels, 'library').visible).toBe(true);
    expect(byId(labels, 'pantheon').visible).toBe(true);
  });

  it('places the hover card first, as a taller card, and keeps room labels hidden when zoomed out unless active', () => {
    const far = { focalX: 0, focalY: -20, zoom: 0.2 };
    expect(layout({ camera: far }).some(label => label.building.id === 'room:rom_a')).toBe(false);
    const hovered = layout({ camera: far, hoveredId: 'room:rom_a' });
    expect(hovered[0].building.id).toBe('room:rom_a');
    expect(hovered[0].card).toBe(true);
    expect(hovered[0].bottom - hovered[0].top).toBe(36);
    // Selection alone also gets the card when nothing is hovered; hover wins otherwise.
    expect(layout({ selectedId: 'library' })[0]).toMatchObject({ card: true, active: true });
    expect(layout({ selectedId: 'library', hoveredId: 'pantheon' })[0].building.id).toBe('pantheon');
  });
});

const MIN_TEST_ZOOM = 0.1;

describe('label layout cache', () => {
  const scene = buildCityScene(Array.from({ length: 6 }, (_, index) => ({ room_id: `rom_${index}`, title: `Room ${index}` })));
  const palette = { ground: '#000' } as CityPalette;
  const occluders: Rect[] = [{ left: 0, top: 0, right: 200, bottom: 60 }];
  const withCanvas = (run: (ctx: CanvasRenderingContext2D, calls: Record<string, number>) => void) => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recordingCtx({}) as never);
    const calls: Record<string, number> = {};
    try { run(recordingCtx(calls), calls); } finally { spy.mockRestore(); }
  };

  it('lays building labels out once for identical frames and again only when an input changes', () => {
    withCanvas(ctx => {
      const cache = createRenderCache();
      const frame = { scene, camera: { focalX: 0, focalY: -20, zoom: 0.8 }, view: { width: 1000, height: 700 }, palette, time: 0, animate: true, hoveredId: null, selectedId: null, filter: 'all' as const, particles: 0, dpr: 1, cache, occluders };
      renderCity(ctx, frame);
      expect(cache.layoutRuns).toBe(1);
      const boxes = cache.placed.slice(0, cache.placedCount).map(label => ({ id: label.building.id, left: label.left, top: label.top, visible: label.visible }));
      for (let tick = 1; tick <= 5; tick++) renderCity(ctx, { ...frame, time: tick * 33 }); // decorative frames
      expect(cache.layoutRuns).toBe(1);
      expect(cache.placed.slice(0, cache.placedCount).map(label => ({ id: label.building.id, left: label.left, top: label.top, visible: label.visible }))).toEqual(boxes);
      renderCity(ctx, { ...frame, hoveredId: 'library' });
      expect(cache.layoutRuns).toBe(2);
      renderCity(ctx, { ...frame, hoveredId: 'library', time: 99 });
      expect(cache.layoutRuns).toBe(2);
      renderCity(ctx, { ...frame, camera: { focalX: 4, focalY: -20, zoom: 0.8 } });
      expect(cache.layoutRuns).toBe(3);
      renderCity(ctx, { ...frame, camera: { focalX: 4, focalY: -20, zoom: 0.8 }, occluders: [...occluders] });
      expect(cache.layoutRuns).toBe(4);
      renderCity(ctx, { ...frame, camera: { focalX: 4, focalY: -20, zoom: 0.8 }, occluders: [...occluders], selectedId: 'pantheon' });
      renderCity(ctx, { ...frame, camera: { focalX: 4, focalY: -20, zoom: 0.8 }, filter: 'science' as const });
      renderCity(ctx, { ...frame, view: { width: 999, height: 700 } });
      expect(cache.layoutRuns).toBe(7);
    });
  });

  it('clearLabelCache drops labels, name tags, cards and the "+N" tag and forces a relayout', () => {
    withCanvas(ctx => {
      const cache = createRenderCache();
      const inhabitants = planInhabitants(Array.from({ length: 42 }, (_, index) => ({ agent_id: `a${String(index).padStart(2, '0')}`, name: `Agent ${index}`, presence: 'online' as const })), [], scene, 0);
      const frame = { scene, camera: { focalX: 0, focalY: -20, zoom: 0.8 }, view: { width: 1000, height: 700 }, palette, time: 0, animate: false, hoveredId: 'library', selectedId: null, filter: 'all' as const, particles: 0, dpr: 1, cache, inhabitants };
      renderCity(ctx, frame);
      expect(cache.labels.size).toBeGreaterThan(0);
      expect(cache.cards.size).toBe(1);
      expect(cache.figureLabels.size).toBeGreaterThan(0);
      expect(cache.overflow.count).toBe(2);
      clearLabelCache(cache);
      expect(cache.labels.size + cache.cards.size + cache.figureLabels.size).toBe(0);
      expect(cache.overflow.count).toBe(-1);
      renderCity(ctx, frame);
      expect(cache.layoutRuns).toBe(2);
    });
  });

  it('measures the "+N" overflow tag only when N changes', () => {
    const measured: string[] = [];
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recordingCtx({}) as never);
    try {
      const base = recordingCtx({});
      const ctx = new Proxy(base as unknown as Record<string, unknown>, {
        get: (target, prop: string) => (prop === 'measureText' ? (text: string) => { measured.push(text); return { width: text.length * 7 }; } : target[prop]),
        set: (target, prop: string, value) => { target[prop] = value; return true; },
      }) as unknown as CanvasRenderingContext2D;
      const cache = createRenderCache();
      const agents = (count: number) => Array.from({ length: count }, (_, index) => ({ agent_id: `a${String(index).padStart(2, '0')}`, name: `Agent ${index}`, presence: 'online' as const }));
      const frame = { scene, camera: { focalX: 0, focalY: -20, zoom: 0.8 }, view: { width: 1000, height: 700 }, palette, time: 0, animate: false, hoveredId: null, selectedId: null, filter: 'all' as const, particles: 0, dpr: 1, cache, inhabitants: planInhabitants(agents(43), [], scene, 0) };
      renderCity(ctx, frame);
      renderCity(ctx, { ...frame, time: 40 });
      renderCity(ctx, { ...frame, time: 80 });
      expect(measured.filter(text => text === '+3')).toHaveLength(1);
      renderCity(ctx, { ...frame, inhabitants: planInhabitants(agents(44), [], scene, 0) });
      expect(measured.filter(text => text === '+4')).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('hover card', () => {
  const [room] = buildCityScene([
    { room_id: 'rom_a', title: 'A', description: '[archetype:senate_rotunda] x', message_count: 42 },
  ]).roomBuildings;

  it('uses only real data in the subline: archetype plus message_count when present', () => {
    expect(cardSubline(room)).toBe('Senate Rotunda · 42 messages');
    expect(cardSubline({ ...room, room: { ...room.room!, messageCount: 1 } })).toBe('Senate Rotunda · 1 message');
    expect(cardSubline({ ...room, room: { ...room.room!, messageCount: null } })).toBe('Senate Rotunda');
    const scene = buildCityScene([], { includePraetorium: true });
    expect(scene.buildings.filter(building => building.kind !== 'room').map(cardSubline)).toEqual(['Knowledge', 'Agents', 'Owner controls']);
  });

  it('draws the card text with fillText only, bidi-stripped and truncated, and measures it once', () => {
    const title = `\u202Eevil\u2066 ${'long '.repeat(20)}`;
    const scene = buildCityScene([{ room_id: 'rom_x', title, message_count: 7 }]);
    const [building] = scene.roomBuildings;
    const texts: string[] = [];
    const calls: Record<string, number> = {};
    const layerCalls: Record<string, number> = {};
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recordingCtx(layerCalls) as never);
    try {
      const ctx = recordingCtx(calls, texts);
      const cache = createRenderCache();
      const iso = worldToScreen(building.x, building.y, 0, { focalX: 0, focalY: 0, zoom: 1 }, { width: 0, height: 0 });
      const frame = { scene, camera: { focalX: iso.x, focalY: iso.y - 100, zoom: 1 }, view: { width: 900, height: 600 }, palette: { ground: '#000' } as CityPalette, time: 0, animate: false, hoveredId: building.id, selectedId: null, filter: 'all' as const, particles: 0, dpr: 1, cache };
      renderCity(ctx, frame);
      const cardTitle = texts.find(text => text.startsWith('evil'))!;
      expect(cardTitle).toBeDefined();
      expect(/[\u202A-\u202E\u2066-\u2069]/.test(texts.join(''))).toBe(false);
      expect(Array.from(cardTitle).length).toBeLessThanOrEqual(32);
      expect(texts).toContain(`${building.archetype!.nameEn} · 7 messages`);
      const measured = calls.measureText;
      renderCity(ctx, { ...frame, time: 50 });
      expect(calls.measureText).toBe(measured); // card and tags come from the cache
      // The label hit test sees the card where it was drawn.
      const card = cache.placed[0];
      expect(card.card).toBe(true);
      expect(labelAt(cache, (card.left + card.right) / 2, (card.top + card.bottom) / 2)).toBe(building.id);
      expect(labelAt(cache, -500, -500)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Praetorium rendering', () => {
  it('renders the owner city (plaza, Praetorium, details) without shadowBlur and passes occluders through', () => {
    const assigned = new Set<string>();
    const calls: Record<string, number> = {};
    const layerCalls: Record<string, number> = {};
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recordingCtx(layerCalls, [], assigned) as never);
    try {
      const texts: string[] = [];
      const ctx = recordingCtx(calls, texts, assigned);
      const scene = buildCityScene(Array.from({ length: 12 }, (_, index) => ({ room_id: `rom_${index}`, title: `Room ${index}` })), { includePraetorium: true });
      const cache = createRenderCache();
      const view = { width: 1200, height: 800 };
      renderCity(ctx, { scene, camera: { focalX: 0, focalY: -20, zoom: 0.9 }, view, palette: { ground: '#000' } as CityPalette, time: 1234, animate: true, hoveredId: 'praetorium', selectedId: null, filter: 'all', particles: 4, dpr: 1, cache, occluders: [{ left: 0, top: 0, right: 1200, bottom: 60 }] });
      expect(assigned.has('shadowBlur')).toBe(false);
      expect(texts).toContain('Преторий');
      expect(texts).toContain('Owner controls');
      for (let index = 0; index < cache.placedCount; index++) {
        const label = cache.placed[index];
        if (label.visible) expect(intersects(label, { left: 0, top: 0, right: 1200, bottom: 60 })).toBe(false);
      }
      expect(layerCalls.clearRect).toBe(1); // plaza lives in the cached ground layer
    } finally {
      spy.mockRestore();
    }
  });
});

describe('inhabitants (agents on the roads, City Shell §6)', () => {
  const scene = buildCityScene([{ room_id: 'rom_a', title: 'Room A' }]);
  const view = { width: 800, height: 500 };
  const camera = { focalX: 0, focalY: 0, zoom: 0.6 };
  const palette = { ground: '#000', cyan: '#0ff', textMuted: '#888', text: '#fff', panel: '#111', gold: '#fa0' } as CityPalette;

  it('draws a glyph and a real name tag for online and offline agents, without shadowBlur', () => {
    const assigned = new Set<string>();
    const calls: Record<string, number> = {};
    const layerCalls: Record<string, number> = {};
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recordingCtx(layerCalls, [], assigned) as never);
    try {
      const texts: string[] = [];
      const ctx = recordingCtx(calls, texts, assigned);
      const cache = createRenderCache();
      const inhabitants = planInhabitants(
        [{ agent_id: 'a1', name: 'Athena', presence: 'online' }, { agent_id: 'a2', name: 'Boreas', presence: 'offline' }],
        [], scene, 0,
      );
      renderCity(ctx, { scene, camera, view, palette, time: 0, animate: false, hoveredId: null, selectedId: null, filter: 'all', particles: 0, dpr: 1, cache, inhabitants });
      expect(assigned.has('shadowBlur')).toBe(false);
      expect(texts).toContain('Athena');
      expect(texts).toContain('Boreas');
    } finally {
      spy.mockRestore();
    }
  });

  it('never invents a metric: no figures are drawn without a plan, and nothing crashes when the frame omits `inhabitants`', () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recordingCtx({}) as never);
    try {
      const ctx = recordingCtx({});
      const cache = createRenderCache();
      expect(() => renderCity(ctx, { scene, camera, view, palette, time: 0, animate: false, hoveredId: null, selectedId: null, filter: 'all', particles: 0, dpr: 1, cache })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('shows a single "+N" near the Pantheon for real agents beyond the cap, never a per-agent count', () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recordingCtx({}) as never);
    try {
      const texts: string[] = [];
      const ctx = recordingCtx({}, texts);
      const cache = createRenderCache();
      const agents = Array.from({ length: 45 }, (_, index) => ({ agent_id: `a${String(index).padStart(2, '0')}`, name: `Agent ${index}`, presence: 'online' as const }));
      const inhabitants = planInhabitants(agents, [], scene, 0);
      expect(inhabitants.overflow).toBe(5);
      renderCity(ctx, { scene, camera, view, palette, time: 0, animate: false, hoveredId: null, selectedId: null, filter: 'all', particles: 0, dpr: 1, cache, inhabitants });
      expect(texts).toContain('+5');
      expect(texts.filter(text => text === '+5')).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('culls a figure far outside the viewport instead of drawing it off-screen', () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recordingCtx({}) as never);
    try {
      const texts: string[] = [];
      const ctx = recordingCtx({}, texts);
      const cache = createRenderCache();
      // No activity: the online agent wanders Pantheon <-> forum, both near world (0, 0)-(125, -125) — a
      // camera panned thousands of units away leaves it, and its label, off-screen.
      const inhabitants = planInhabitants([{ agent_id: 'a1', name: 'Athena', presence: 'online' }], [], scene, 0);
      renderCity(ctx, { scene, camera: { focalX: 20000, focalY: 20000, zoom: 1 }, view, palette, time: 0, animate: false, hoveredId: null, selectedId: null, filter: 'all', particles: 0, dpr: 1, cache, inhabitants });
      expect(texts).not.toContain('Athena');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps a figure static across frames when the clock is frozen (reduced motion)', () => {
    const inhabitants = planInhabitants([{ agent_id: 'a1', name: 'Athena', presence: 'online' }], [], scene, 0);
    /** Renders one frame at `time` into its own recording context and returns the figure's glyph
     * position: the last arc() call (inhabitants draw last, after every building shape). */
    const glyphAt = (time: number) => {
      const positions: Array<{ x: number; y: number }> = [];
      const gradient = { addColorStop: vi.fn() };
      const layerSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recordingCtx({}) as never);
      const ctx = new Proxy({
        measureText: () => ({ width: 40 }),
        createRadialGradient: () => gradient, createLinearGradient: () => gradient,
        arc: (x: number, y: number) => { positions.push({ x, y }); },
      } as Record<string, unknown>, {
        get: (target, prop: string) => (prop in target ? target[prop] : () => {}),
        set: () => true,
      }) as unknown as CanvasRenderingContext2D;
      try {
        renderCity(ctx, { scene, camera, view, palette, time, animate: false, hoveredId: null, selectedId: null, filter: 'all', particles: 0, dpr: 1, cache: createRenderCache(), inhabitants });
      } finally {
        layerSpy.mockRestore();
      }
      expect(positions.length).toBeGreaterThan(0);
      return positions.at(-1);
    };
    const frozenTime = 4000; // reduced motion: the caller freezes frame.time instead of advancing it
    expect(glyphAt(frozenTime)).toEqual(glyphAt(frozenTime));
    // Cross-check: the figure does move once the clock actually advances.
    expect(glyphAt(frozenTime + 5000)).not.toEqual(glyphAt(frozenTime));
  });
});
