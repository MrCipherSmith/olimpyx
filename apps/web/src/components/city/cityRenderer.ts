/**
 * Canvas 2D renderer for the Cyber-Polis (PROMPT §3). Every frame is drawn from the scene, the camera and
 * the resolved design-token palette; the optional render cache only memoises derived pixels (static ground
 * layer, glow sprites, measured labels). Building labels are room titles written by agents (untrusted), so
 * they are only ever drawn with fillText, never interpreted.
 *
 * Hot-path rules: no shadowBlur (glows are pre-rendered sprites), no per-frame sorting (scene.drawOrder),
 * scratch points instead of fresh objects, and off-screen buildings and labels are culled.
 */
import { COS30, SIN30, boxInViewport, footprintScreenBox, worldToScreen, type Camera, type Point, type ScreenBox, type Viewport } from './isometricMath';
import { matchesFilter, sceneFromBuildings, type CityBuilding, type CityScene } from './cityScene';
import type { CityPalette } from './cityTokens';
import type { ArchetypeCategory } from './roomArchetypes';

export interface RenderFrame {
  scene: CityScene;
  camera: Camera;
  view: Viewport;
  palette: CityPalette;
  /** Milliseconds; frozen when motion is reduced. */
  time: number;
  animate: boolean;
  hoveredId: string | null;
  selectedId: string | null;
  filter: ArchetypeCategory | 'all';
  /** Decorative drones and road pulses; 0 disables them. */
  particles: number;
  /** Device pixel ratio of the target canvas (sizes the cached static layer). */
  dpr?: number;
  /** Per-canvas memo of derived pixels; without it everything is drawn directly. */
  cache?: CityRenderCache;
}

type Ctx = CanvasRenderingContext2D;

interface Painter {
  ctx: Ctx;
  frame: RenderFrame;
  /** World → screen; writes into `out` when given (scratch points on the hot path). */
  at: (x: number, y: number, z: number, out?: Point) => Point;
  zoom: number;
}

const ISO_RX = Math.SQRT2 * COS30; // screen x-radius of a world circle of radius 1
const ISO_RY = Math.SQRT2 * SIN30; // screen y-radius of a world circle of radius 1
const TAU = Math.PI * 2;
/** Buildings and labels this far outside the viewport are still drawn (glows, rings and beams overhang). */
const CULL_MARGIN = 48;

const point = (): Point => ({ x: 0, y: 0 });
const pool = (size: number): Point[] => Array.from({ length: size }, point);

/* ------------------------------------------------------------------ render cache */

export interface StaticLayerKey {
  scene: CityScene | null;
  palette: CityPalette | null;
  focalX: number;
  focalY: number;
  zoom: number;
  width: number;
  height: number;
  dpr: number;
}

interface LabelEntry { source: string; text: string; width: number; }

export interface CityRenderCache {
  /** undefined: not created yet; null: offscreen canvases unavailable (draw directly). */
  layer: { canvas: HTMLCanvasElement; ctx: Ctx; key: StaticLayerKey } | null | undefined;
  /** Truncated text and measured width per `${fontSize}|${building id}`. */
  labels: Map<string, LabelEntry>;
}

export function createRenderCache(): CityRenderCache {
  return { layer: undefined, labels: new Map() };
}

/** The ground + roads layer is rebuilt only when the camera, scene, palette, viewport or DPR changed. */
export function staticLayerStale(previous: StaticLayerKey | null, next: StaticLayerKey): boolean {
  return !previous || previous.scene !== next.scene || previous.palette !== next.palette
    || previous.focalX !== next.focalX || previous.focalY !== next.focalY || previous.zoom !== next.zoom
    || previous.width !== next.width || previous.height !== next.height || previous.dpr !== next.dpr;
}

const NEXT_KEY: StaticLayerKey = { scene: null, palette: null, focalX: 0, focalY: 0, zoom: 0, width: 0, height: 0, dpr: 1 };

function createCanvas(): { canvas: HTMLCanvasElement; ctx: Ctx } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
}

/* ------------------------------------------------------------------ entry points */

export function renderCity(ctx: Ctx, frame: RenderFrame): void {
  const { view, camera } = frame;
  const painter = makePainter(ctx, frame, camera, view);
  ctx.save();
  ctx.globalAlpha = 1;
  if (!drawCachedGround(painter)) drawGround(painter);
  if (frame.animate && frame.particles > 0) drawPulses(painter);
  const drawOrder = frame.scene.drawOrder;
  for (let index = 0; index < drawOrder.length; index++) {
    const building = drawOrder[index];
    if (buildingOnScreen(building, camera, view)) drawBuilding(painter, building);
  }
  if (frame.animate && frame.particles > 0) drawDrones(painter);
  drawLabels(painter);
  ctx.restore();
}

/** Static single-building render used by the archetype preview in the create-room dialog. */
export function renderBuildingPreview(ctx: Ctx, building: CityBuilding, view: Viewport, palette: CityPalette): void {
  const zoom = Math.min(view.width / 190, view.height / 200);
  const camera: Camera = { focalX: 0, focalY: -building.height * 0.45 - 10, zoom };
  const frame: RenderFrame = { scene: sceneFromBuildings([building], [], 0, 0), camera, view, palette, time: 0, animate: false, hoveredId: null, selectedId: null, filter: 'all', particles: 0 };
  const painter: Painter = { ctx, frame, zoom, at: (x, y, z, out) => worldToScreen(x - building.x, y - building.y, z, camera, view, out) };
  ctx.save();
  ctx.clearRect(0, 0, view.width, view.height);
  isoEllipse(ctx, painter.at(building.x, building.y, 0), building.size * 1.4, zoom);
  ctx.globalAlpha = 0.5; ctx.strokeStyle = palette[building.color]; ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  drawBuilding(painter, building);
  ctx.restore();
}

function makePainter(ctx: Ctx, frame: RenderFrame, camera: Camera, view: Viewport): Painter {
  return { ctx, frame, zoom: camera.zoom, at: (x, y, z, out) => worldToScreen(x, y, z, camera, view, out) };
}

/* ------------------------------------------------------------------ culling */

const BOX: ScreenBox = { left: 0, top: 0, right: 0, bottom: 0 };

/** World reach (footprint radius incl. decorations) and top height of what a building may paint. */
function buildingExtent(building: CityBuilding): { reach: number; top: number } {
  if (building.kind === 'library') return LIBRARY_EXTENT;
  if (building.kind === 'pantheon') return PANTHEON_EXTENT;
  ROOM_EXTENT.top = building.height + 30;
  return ROOM_EXTENT;
}
const LIBRARY_EXTENT = { reach: 90, top: 200 };
const PANTHEON_EXTENT = { reach: 70, top: 380 }; // includes the light beam above the oculus
const ROOM_EXTENT = { reach: 70, top: 0 };

/** Whether any pixel of the building can land inside the viewport (plus CULL_MARGIN). */
export function buildingOnScreen(building: CityBuilding, camera: Camera, view: Viewport): boolean {
  const { reach, top } = buildingExtent(building);
  return boxInViewport(footprintScreenBox(building.x, building.y, reach, top, camera, view, BOX), view, CULL_MARGIN);
}

/* ------------------------------------------------------------------ ground */

/** Blits the cached ground + roads layer; returns false when no offscreen canvas is available. */
function drawCachedGround(painter: Painter): boolean {
  const { ctx, frame } = painter;
  const cache = frame.cache;
  if (!cache) return false;
  if (cache.layer === undefined) {
    const created = createCanvas();
    cache.layer = created ? { ...created, key: { ...NEXT_KEY, width: -1 } } : null;
  }
  const layer = cache.layer;
  if (!layer) return false;
  const dpr = frame.dpr ?? 1;
  const { view, camera } = frame;
  NEXT_KEY.scene = frame.scene; NEXT_KEY.palette = frame.palette;
  NEXT_KEY.focalX = camera.focalX; NEXT_KEY.focalY = camera.focalY; NEXT_KEY.zoom = camera.zoom;
  NEXT_KEY.width = view.width; NEXT_KEY.height = view.height; NEXT_KEY.dpr = dpr;
  if (staticLayerStale(layer.key, NEXT_KEY)) {
    const width = Math.max(1, Math.round(view.width * dpr));
    const height = Math.max(1, Math.round(view.height * dpr));
    if (layer.canvas.width !== width) layer.canvas.width = width;
    if (layer.canvas.height !== height) layer.canvas.height = height;
    layer.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layer.ctx.clearRect(0, 0, view.width, view.height);
    layer.ctx.save();
    drawGround({ ...painter, ctx: layer.ctx });
    layer.ctx.restore();
    Object.assign(layer.key, NEXT_KEY);
  }
  ctx.globalAlpha = 1;
  ctx.drawImage(layer.canvas, 0, 0, view.width, view.height);
  return true;
}

function drawGround(painter: Painter) {
  const { ctx, frame } = painter;
  ctx.globalAlpha = 1;
  ctx.fillStyle = frame.palette.ground;
  ctx.fillRect(0, 0, frame.view.width, frame.view.height);
  drawAtmosphere(painter);
  drawRoads(painter);
}

function drawAtmosphere({ ctx, frame, at, zoom }: Painter) {
  const centre = at(0, 0, 0);
  const radius = Math.max(40, (frame.scene.outerRadius + 300) * zoom);
  const glow = ctx.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, radius);
  glow.addColorStop(0, frame.palette.cyan);
  glow.addColorStop(1, 'transparent');
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, frame.view.width, frame.view.height);
  ctx.globalAlpha = 1;
}

function isoEllipse(ctx: Ctx, centre: Point, radius: number, zoom: number) {
  ctx.beginPath();
  ctx.ellipse(centre.x, centre.y, Math.max(0.1, radius * ISO_RX * zoom), Math.max(0.1, radius * ISO_RY * zoom), 0, 0, TAU);
}

function drawRoads(painter: Painter) {
  const { ctx, frame, at, zoom } = painter;
  const { palette, scene } = frame;
  const centre = at(0, 0, 0);
  const from = point();
  const to = point();

  // Radial avenues: four cardinal ones to the city edge plus one per room building (precomputed in the scene).
  for (const avenue of scene.avenues) {
    at(avenue.cos * scene.forumRadius, avenue.sin * scene.forumRadius, 0, from);
    at(avenue.cos * avenue.length, avenue.sin * avenue.length, 0, to);
    strokeLine(ctx, from, to, palette.panel, 1, Math.max(2, 16 * zoom));
    strokeLine(ctx, from, to, palette.cyan, 0.28, Math.max(0.6, 1.2 * zoom));
  }

  // Ring roads.
  for (const radius of scene.rings) {
    isoEllipse(ctx, centre, radius, zoom);
    ctx.globalAlpha = 1; ctx.strokeStyle = palette.panel; ctx.lineWidth = Math.max(2, 18 * zoom); ctx.stroke();
    ctx.globalAlpha = 0.35; ctx.strokeStyle = palette.cyan; ctx.lineWidth = Math.max(0.6, 1.4 * zoom);
    ctx.setLineDash([10 * zoom, 12 * zoom]); ctx.stroke(); ctx.setLineDash([]);
  }

  // Forum Centralis plaza.
  isoEllipse(ctx, centre, scene.forumRadius, zoom);
  ctx.globalAlpha = 0.85; ctx.fillStyle = palette.raised; ctx.fill();
  ctx.globalAlpha = 0.55; ctx.strokeStyle = palette.gold; ctx.lineWidth = Math.max(0.8, 2 * zoom); ctx.stroke();
  isoEllipse(ctx, centre, scene.forumRadius * 0.82, zoom);
  ctx.globalAlpha = 0.25; ctx.setLineDash([4 * zoom, 6 * zoom]); ctx.stroke(); ctx.setLineDash([]);
  // Via Sacra between the Library and the Pantheon.
  strokeLine(ctx, at(0, -150, 0, from), at(0, 150, 0, to), palette.gold, 0.35, Math.max(1, 6 * zoom));
  ctx.globalAlpha = 1;
}

function strokeLine(ctx: Ctx, from: Point, to: Point, color: string, alpha: number, width: number) {
  ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ decorative motion (not metrics) */

const MOTION_POINT = point();

function drawPulses({ ctx, frame, at, zoom }: Painter) {
  const avenues = frame.scene.roomAvenues;
  const count = Math.min(avenues.length, frame.particles);
  const forum = frame.scene.forumRadius;
  ctx.fillStyle = frame.palette.cyan;
  for (let index = 0; index < count; index++) {
    const avenue = avenues[index];
    const progress = ((frame.time * 0.00012) + index * 0.37) % 1;
    const distance = forum + (avenue.length - forum) * progress;
    const spot = at(avenue.cos * distance, avenue.sin * distance, 0, MOTION_POINT);
    ctx.globalAlpha = 0.7 * Math.sin(progress * Math.PI);
    ctx.beginPath(); ctx.arc(spot.x, spot.y, Math.max(1, 3 * zoom), 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

const DEFAULT_DRONE_RINGS: number[] = [];

function drawDrones({ ctx, frame, at, zoom }: Painter) {
  let rings = frame.scene.rings;
  if (!rings.length) { DEFAULT_DRONE_RINGS[0] = frame.scene.forumRadius + 120; rings = DEFAULT_DRONE_RINGS; }
  for (let index = 0; index < frame.particles; index++) {
    const radius = rings[index % rings.length] + ((index * 53) % 60) - 30;
    const speed = (index % 2 ? 1 : -1) * (0.00005 + (index % 5) * 0.000012);
    ctx.fillStyle = index % 3 === 0 ? frame.palette.gold : frame.palette.cyan;
    for (let trail = 3; trail >= 0; trail--) {
      const angle = index * 2.399 + (frame.time - trail * 70) * speed;
      const spot = at(Math.cos(angle) * radius, Math.sin(angle) * radius, 170 + Math.sin(frame.time * 0.001 + index) * 14, MOTION_POINT);
      ctx.globalAlpha = trail === 0 ? 0.95 : 0.25 / trail;
      const size = Math.max(1.2, (trail === 0 ? 4 : 2.5) * zoom);
      ctx.beginPath(); ctx.moveTo(spot.x, spot.y - size); ctx.lineTo(spot.x + size, spot.y); ctx.lineTo(spot.x, spot.y + size); ctx.lineTo(spot.x - size, spot.y); ctx.closePath(); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ glow sprites (no shadowBlur per frame) */

const GLOW_SPRITE_SIZE = 64;
/** One radial-gradient sprite per colour, rendered once and reused via drawImage. */
const glowSprites = new Map<string, HTMLCanvasElement | null>();

function glowSprite(color: string): HTMLCanvasElement | null {
  let sprite = glowSprites.get(color);
  if (sprite === undefined) {
    sprite = null;
    const created = createCanvas();
    if (created) {
      const half = GLOW_SPRITE_SIZE / 2;
      created.canvas.width = GLOW_SPRITE_SIZE;
      created.canvas.height = GLOW_SPRITE_SIZE;
      try {
        const gradient = created.ctx.createRadialGradient(half, half, 0, half, half, half);
        gradient.addColorStop(0, color);
        gradient.addColorStop(0.35, color);
        gradient.addColorStop(1, 'transparent');
        created.ctx.globalAlpha = 1;
        created.ctx.fillStyle = gradient;
        created.ctx.fillRect(0, 0, GLOW_SPRITE_SIZE, GLOW_SPRITE_SIZE);
        sprite = created.canvas;
      } catch {
        sprite = null; // unparsable colour: no halo, the solid dot still renders
      }
    }
    glowSprites.set(color, sprite);
  }
  return sprite;
}

function drawGlow(ctx: Ctx, color: string, x: number, y: number, radius: number, alpha: number) {
  const sprite = glowSprite(color);
  if (!sprite || radius <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
}

/* ------------------------------------------------------------------ solids */

interface Style { color: string; fill: number; stroke: number; }

function face(ctx: Ctx, points: readonly Point[], count: number, base: string, style: Style, shade: number) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < count; index++) ctx.lineTo(points[index].x, points[index].y);
  ctx.closePath();
  ctx.globalAlpha = 1; ctx.fillStyle = base; ctx.fill();
  ctx.globalAlpha = style.fill * shade; ctx.fillStyle = style.color; ctx.fill();
  ctx.globalAlpha = style.stroke; ctx.strokeStyle = style.color; ctx.stroke();
  ctx.globalAlpha = 1;
}

const QUAD = pool(4);

/** Axis-aligned box: draws the two faces facing the viewer (+x, +y) and the top. */
function box(p: Painter, style: Style, x: number, y: number, z: number, hx: number, hy: number, h: number) {
  const { at, ctx, frame } = p;
  const top = z + h;
  at(x + hx, y - hy, z, QUAD[0]); at(x + hx, y + hy, z, QUAD[1]); at(x + hx, y + hy, top, QUAD[2]); at(x + hx, y - hy, top, QUAD[3]);
  face(ctx, QUAD, 4, frame.palette.panel, style, 0.55);
  at(x - hx, y + hy, z, QUAD[0]); at(x + hx, y + hy, z, QUAD[1]); at(x + hx, y + hy, top, QUAD[2]); at(x - hx, y + hy, top, QUAD[3]);
  face(ctx, QUAD, 4, frame.palette.panel, style, 0.8);
  at(x - hx, y - hy, top, QUAD[0]); at(x + hx, y - hy, top, QUAD[1]); at(x + hx, y + hy, top, QUAD[2]); at(x - hx, y + hy, top, QUAD[3]);
  face(ctx, QUAD, 4, frame.palette.raised, style, 1);
}

const CYL_BOTTOM = point();
const CYL_TOP = point();

function cylinder(p: Painter, style: Style, x: number, y: number, z: number, r: number, h: number) {
  const { ctx, at, zoom, frame } = p;
  const bottom = at(x, y, z, CYL_BOTTOM);
  const top = at(x, y, z + h, CYL_TOP);
  const rx = r * ISO_RX * zoom;
  const ry = r * ISO_RY * zoom;
  ctx.beginPath();
  ctx.moveTo(bottom.x - rx, top.y);
  ctx.lineTo(bottom.x - rx, bottom.y);
  ctx.ellipse(bottom.x, bottom.y, rx, ry, 0, Math.PI, 0, true);
  ctx.lineTo(bottom.x + rx, top.y);
  ctx.closePath();
  ctx.globalAlpha = 1; ctx.fillStyle = frame.palette.panel; ctx.fill();
  ctx.globalAlpha = style.fill * 0.65; ctx.fillStyle = style.color; ctx.fill();
  ctx.globalAlpha = style.stroke; ctx.strokeStyle = style.color; ctx.stroke();
  ctx.beginPath(); ctx.ellipse(top.x, top.y, rx, ry, 0, 0, TAU);
  ctx.globalAlpha = 1; ctx.fillStyle = frame.palette.raised; ctx.fill();
  ctx.globalAlpha = style.fill; ctx.fillStyle = style.color; ctx.fill();
  ctx.globalAlpha = style.stroke; ctx.stroke();
  ctx.globalAlpha = 1;
}

const DOME_BASE = point();

function dome(p: Painter, style: Style, x: number, y: number, z: number, r: number, rise = 0.85) {
  const { ctx, at, zoom, frame } = p;
  const base = at(x, y, z, DOME_BASE);
  const rx = r * ISO_RX * zoom;
  ctx.beginPath();
  ctx.ellipse(base.x, base.y, rx, r * ISO_RY * zoom, 0, 0, Math.PI);
  ctx.ellipse(base.x, base.y, rx, r * rise * zoom * 1.1, 0, Math.PI, TAU);
  ctx.closePath();
  ctx.globalAlpha = 1; ctx.fillStyle = frame.palette.raised; ctx.fill();
  ctx.globalAlpha = style.fill * 1.4; ctx.fillStyle = style.color; ctx.fill();
  ctx.globalAlpha = style.stroke; ctx.strokeStyle = style.color; ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Unit-circle corner tables per (sides, turn), with the viewer-facing side faces flagged once. */
interface PrismTable { cos: number[]; sin: number[]; front: boolean[]; }
const prismTables = new Map<string, PrismTable>();

function prismTable(sides: number, turn: number): PrismTable {
  const key = `${sides}:${turn}`;
  let table = prismTables.get(key);
  if (!table) {
    const angles = Array.from({ length: sides }, (_, index) => turn + (index * TAU) / sides);
    table = {
      cos: angles.map(Math.cos),
      sin: angles.map(Math.sin),
      // Side faces whose outward normal points towards the viewer (+x +y).
      front: angles.map((angle, index) => {
        const normal = (angle + angles[(index + 1) % sides]) / 2 + (index === sides - 1 ? Math.PI : 0);
        return Math.cos(normal) + Math.sin(normal) > 0;
      }),
    };
    prismTables.set(key, table);
  }
  return table;
}

const POLY = pool(8);

function prism(p: Painter, style: Style, x: number, y: number, z: number, r: number, h: number, sides: number, turn = 0) {
  const { at, ctx, frame } = p;
  const table = prismTable(sides, turn);
  for (let index = 0; index < sides; index++) {
    if (!table.front[index]) continue;
    const next = (index + 1) % sides;
    const ax = x + table.cos[index] * r; const ay = y + table.sin[index] * r;
    const bx = x + table.cos[next] * r; const by = y + table.sin[next] * r;
    at(ax, ay, z, QUAD[0]); at(bx, by, z, QUAD[1]); at(bx, by, z + h, QUAD[2]); at(ax, ay, z + h, QUAD[3]);
    face(ctx, QUAD, 4, frame.palette.panel, style, 0.7);
  }
  for (let index = 0; index < sides; index++) at(x + table.cos[index] * r, y + table.sin[index] * r, z + h, POLY[index]);
  face(ctx, POLY, sides, frame.palette.raised, style, 1);
}

const MAST_FROM = point();
const MAST_TO = point();

function mast(p: Painter, color: string, x: number, y: number, z0: number, z1: number, width: number, alpha = 0.9) {
  strokeLine(p.ctx, p.at(x, y, z0, MAST_FROM), p.at(x, y, z1, MAST_TO), color, alpha, Math.max(0.6, width * p.zoom));
}

const GLOW_POINT = point();

/** Glowing beacon: cached halo sprite plus a solid core (replaces a per-frame shadowBlur of 12px). */
function glowDot(p: Painter, color: string, spot: Point, radius: number, alpha: number) {
  const { ctx } = p;
  const core = Math.max(1, radius * p.zoom);
  drawGlow(ctx, color, spot.x, spot.y, core + 12, alpha * 0.85);
  ctx.globalAlpha = alpha; ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(spot.x, spot.y, core, 0, TAU); ctx.fill();
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ buildings */

const BUILDING_STYLE: Style = { color: '', fill: 0, stroke: 0 };
const FOOTPRINT_STYLE: Style = { color: '', fill: 0.08, stroke: 0.25 };
const HALO_POINT = point();

function drawBuilding(p: Painter, building: CityBuilding) {
  const { ctx, frame } = p;
  const active = building.id === frame.selectedId || building.id === frame.hoveredId;
  const visible = matchesFilter(building, frame.filter);
  const color = frame.palette[building.color];
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(0.7, (active ? 2.2 : 1.2) * p.zoom);
  // Filtered-out rooms are drawn as faint footprints only.
  if (!visible) {
    ctx.globalAlpha = 0.25;
    FOOTPRINT_STYLE.color = color;
    box(p, FOOTPRINT_STYLE, building.x, building.y, 0, building.size * 0.8, building.size * 0.8, 6);
    ctx.restore();
    return;
  }
  if (building.id === frame.selectedId) {
    isoEllipse(ctx, p.at(building.x, building.y, 0, HALO_POINT), building.size * 1.35, p.zoom);
    ctx.globalAlpha = 0.9; ctx.strokeStyle = color; ctx.setLineDash([6 * p.zoom, 5 * p.zoom]); ctx.stroke(); ctx.setLineDash([]);
  }
  if (active) {
    // Halo behind the active building (replaces shadowBlur 14 on every face).
    const centre = p.at(building.x, building.y, building.height * 0.45, HALO_POINT);
    drawGlow(ctx, color, centre.x, centre.y, Math.max(building.size * 1.6, building.height * 0.8) * p.zoom + 14, 0.35);
    ctx.globalAlpha = 1;
  }
  BUILDING_STYLE.color = color;
  BUILDING_STYLE.fill = active ? 0.34 : 0.22;
  BUILDING_STYLE.stroke = active ? 1 : 0.8;
  SHAPES[building.shape](p, BUILDING_STYLE, building);
  ctx.restore();
}

type ShapeDrawer = (p: Painter, style: Style, b: CityBuilding) => void;

const DERIVED_STYLE: Style = { color: '', fill: 0, stroke: 0 };
/** Scratch copy of `s` with a different fill (avoids `{ ...s, fill }` per frame). */
function withFill(s: Style, fill: number): Style {
  DERIVED_STYLE.color = s.color; DERIVED_STYLE.stroke = s.stroke; DERIVED_STYLE.fill = fill;
  return DERIVED_STYLE;
}

const SHAPE_POINT = point();

const SHAPES: Record<CityBuilding['shape'], ShapeDrawer> = {
  library: drawLibrary,
  pantheon: drawPantheon,
  lab_observatory(p, s, { x, y }) {
    box(p, s, x, y, 0, 36, 36, 40);
    cylinder(p, s, x, y, 40, 22, 30);
    dome(p, s, x, y, 70, 22);
    const top = p.at(x, y, 108, SHAPE_POINT);
    const tilt = p.frame.time * 0.0006;
    p.ctx.globalAlpha = s.stroke; p.ctx.strokeStyle = s.color;
    p.ctx.beginPath(); p.ctx.ellipse(top.x, top.y, 16 * p.zoom, 6 * p.zoom, tilt, 0, TAU); p.ctx.stroke();
    mast(p, s.color, x, y, 88, 108, 1.5);
  },
  archive_data_vault(p, s, { x, y }) {
    box(p, s, x, y, 0, 40, 40, 62);
    for (const z of VAULT_RING_Z) { isoEllipse(p.ctx, p.at(x, y, z, SHAPE_POINT), 60, p.zoom); p.ctx.globalAlpha = 0.6; p.ctx.strokeStyle = s.color; p.ctx.stroke(); }
    p.ctx.globalAlpha = 1;
  },
  crypto_proving_grounds(p, s, { x, y }) {
    prism(p, s, x, y, 0, 46, 14, 6, Math.PI / 6);
    for (let index = 0; index < 3; index++) box(p, s, x + PYLON_COS[index] * 30, y + PYLON_SIN[index] * 30, 14, 5, 5, 44);
    glowDot(p, s.color, p.at(x, y, 40, GLOW_POINT), 5, 0.9);
  },
  senate_rotunda(p, s, { x, y }) {
    box(p, s, x, y, 0, 42, 42, 8);
    cylinder(p, s, x, y, 8, 34, 38);
    dome(p, s, x, y, 46, 34);
  },
  forum_agora(p, s, { x, y }) {
    cylinder(p, s, x, y, 0, 46, 8);
    cylinder(p, s, x, y, 8, 34, 8);
    cylinder(p, s, x, y, 16, 20, 6);
    mast(p, s.color, x, y, 22, 46, 3);
    glowDot(p, s.color, p.at(x, y, 48, GLOW_POINT), 4, 0.9);
  },
  tribunal_chamber(p, s, { x, y }) {
    box(p, s, x, y, 0, 44, 44, 14);
    box(p, s, x, y, 14, 32, 32, 14);
    box(p, s, x, y, 28, 20, 20, 32);
    strokeLine(p.ctx, p.at(x - 22, y + 22, 72, MAST_FROM), p.at(x + 22, y - 22, 72, MAST_TO), s.color, 0.95, Math.max(1, 2 * p.zoom));
    mast(p, s.color, x, y, 60, 74, 2);
  },
  cyber_forge(p, s, { x, y }) {
    cylinder(p, s, x - 22, y - 14, 0, 8, 80);
    cylinder(p, s, x + 6, y - 22, 0, 8, 70);
    box(p, s, x, y + 6, 0, 44, 26, 44);
    const flicker = p.frame.animate ? 0.6 + 0.4 * Math.abs(Math.sin(p.frame.time * 0.004)) : 0.8;
    glowDot(p, s.color, p.at(x - 22, y - 14, 84, GLOW_POINT), 4, flicker);
  },
  neural_matrix_spire(p, s, { x, y }) {
    box(p, s, x, y, 0, 30, 30, 44);
    box(p, s, x, y, 44, 21, 21, 40);
    box(p, s, x, y, 84, 12, 12, 36);
    mast(p, s.color, x, y, 120, 146, 1.5);
    glowDot(p, s.color, p.at(x, y, 148, GLOW_POINT), 3, 0.9);
  },
  telemetry_beacon(p, s, { x, y }) {
    box(p, s, x, y, 0, 28, 28, 10);
    box(p, withFill(s, s.fill * 0.4), x, y, 10, 8, 8, 124);
    const pulse = p.frame.animate ? 0.5 + 0.5 * Math.abs(Math.sin(p.frame.time * 0.002)) : 0.9;
    glowDot(p, s.color, p.at(x, y, 140, GLOW_POINT), 6, pulse);
  },
  command_citadel(p, s, { x, y }) {
    box(p, s, x - 40, y - 40, 0, 9, 9, 56);
    box(p, s, x, y, 0, 44, 44, 32);
    box(p, s, x, y, 32, 18, 18, 56);
    box(p, s, x + 40, y - 40, 0, 9, 9, 56);
    box(p, s, x - 40, y + 40, 0, 9, 9, 56);
    box(p, s, x + 40, y + 40, 0, 9, 9, 56);
  },
  surveillance_panopticon(p, s, { x, y }) {
    cylinder(p, s, x, y, 0, 44, 28);
    cylinder(p, s, x, y, 28, 10, 72);
    const eye = p.at(x, y, 100, GLOW_POINT);
    const sweep = p.frame.time * 0.0008;
    p.ctx.globalAlpha = 0.18; p.ctx.fillStyle = s.color;
    p.ctx.beginPath(); p.ctx.moveTo(eye.x, eye.y);
    p.ctx.ellipse(eye.x, eye.y + 30 * p.zoom, 80 * p.zoom, 36 * p.zoom, 0, sweep, sweep + 0.5); p.ctx.closePath(); p.ctx.fill();
    glowDot(p, s.color, eye, 5, 0.95);
  },
  logistics_nexus(p, s, { x, y }) {
    box(p, s, x, y, 0, 46, 10, 14);
    box(p, s, x, y, 0, 10, 46, 14);
    box(p, s, x, y, 14, 20, 20, 30);
  },
};

const VAULT_RING_Z = [18, 44] as const;
const PYLON_COS = [0, 1, 2].map(index => Math.cos(Math.PI / 6 + index * (TAU / 3)));
const PYLON_SIN = [0, 1, 2].map(index => Math.sin(Math.PI / 6 + index * (TAU / 3)));

// Library core: rhombicuboctahedron seen corner-on (octagonal silhouette + central square), unit tables.
const LIB_OUTER_COS = Array.from({ length: 8 }, (_, index) => Math.cos(Math.PI / 8 + index * Math.PI / 4));
const LIB_OUTER_SIN = Array.from({ length: 8 }, (_, index) => Math.sin(Math.PI / 8 + index * Math.PI / 4));
const LIB_INNER_COS = Array.from({ length: 4 }, (_, index) => Math.cos(Math.PI / 4 + index * Math.PI / 2));
const LIB_INNER_SIN = Array.from({ length: 4 }, (_, index) => Math.sin(Math.PI / 4 + index * Math.PI / 2));
/** Holographic rings around the core: [scale, squash, tilt]. */
const LIB_RINGS: ReadonlyArray<readonly [number, number, number]> = [[1.55, 0.38, 0.25], [1.35, 0.3, -0.45], [1.8, 0.22, 0.05]];
const LIB_OUTER = pool(8);
const LIB_INNER = pool(4);
const LIB_CENTRE = point();

function drawLibrary(p: Painter, s: Style, { x, y }: CityBuilding) {
  const { ctx, frame, zoom } = p;
  box(p, s, x, y, 0, 46, 46, 14);
  box(p, s, x, y, 14, 30, 30, 24);
  const centre = p.at(x, y, 100, LIB_CENTRE);
  const radius = 52 * zoom;
  for (let index = 0; index < 8; index++) { LIB_OUTER[index].x = centre.x + LIB_OUTER_COS[index] * radius; LIB_OUTER[index].y = centre.y + LIB_OUTER_SIN[index] * radius * 0.92; }
  for (let index = 0; index < 4; index++) { LIB_INNER[index].x = centre.x + LIB_INNER_COS[index] * radius * 0.55; LIB_INNER[index].y = centre.y + LIB_INNER_SIN[index] * radius * 0.5; }
  face(ctx, LIB_OUTER, 8, frame.palette.raised, withFill(s, s.fill * 1.4), 1);
  ctx.globalAlpha = 0.75; ctx.strokeStyle = s.color;
  ctx.beginPath();
  ctx.moveTo(LIB_INNER[0].x, LIB_INNER[0].y);
  for (let index = 1; index < 4; index++) ctx.lineTo(LIB_INNER[index].x, LIB_INNER[index].y);
  ctx.closePath();
  for (let index = 0; index < 4; index++) {
    const inner = LIB_INNER[index]; const a = LIB_OUTER[(index * 2 + 7) % 8]; const b = LIB_OUTER[index * 2]; const c = LIB_OUTER[index * 2 + 1];
    ctx.moveTo(a.x, a.y); ctx.lineTo(inner.x, inner.y); ctx.lineTo(b.x, b.y); ctx.moveTo(inner.x, inner.y); ctx.lineTo(c.x, c.y);
  }
  ctx.stroke();
  glowDot(p, s.color, centre, 7, 0.9);
  // Holographic rings rotating around the core.
  const spin = frame.time * 0.0004;
  for (let index = 0; index < LIB_RINGS.length; index++) {
    const [scale, squash, tilt] = LIB_RINGS[index];
    ctx.save();
    ctx.globalAlpha = 0.55 - index * 0.12; ctx.strokeStyle = s.color; ctx.lineWidth = Math.max(0.7, 1.4 * zoom);
    ctx.setLineDash([14 * zoom, 8 * zoom]); ctx.lineDashOffset = -spin * 400 * (index % 2 ? -1 : 1);
    ctx.beginPath(); ctx.ellipse(centre.x, centre.y, radius * scale, radius * scale * squash, tilt + Math.sin(spin + index) * 0.08, 0, TAU); ctx.stroke();
    ctx.restore();
  }
}

// Pantheon colonnade: 16 columns on a circle, split once into the back and front halves.
const COLUMN_COUNT = 16;
const COLUMN_COS = Array.from({ length: COLUMN_COUNT }, (_, index) => Math.cos((index * Math.PI) / 8));
const COLUMN_SIN = Array.from({ length: COLUMN_COUNT }, (_, index) => Math.sin((index * Math.PI) / 8));
const COLUMN_FRONT = COLUMN_COS.map((cos, index) => cos + COLUMN_SIN[index] > 0);
const PANTHEON_ENTABLATURE = point();
const PANTHEON_OCULUS = point();
const PANTHEON_DOME: Style = { color: '', fill: 0.32, stroke: 0.95 };

function drawPantheon(p: Painter, s: Style, { x, y }: CityBuilding) {
  const { ctx, frame, zoom } = p;
  const gold = frame.palette.gold;
  const columnRadius = 42;
  const baseZ = 16;
  const topZ = 70;
  // Stylobate.
  box(p, s, x, y, 0, 60, 60, 8);
  box(p, s, x, y, 8, 52, 52, 8);
  const drawColumns = (front: boolean) => {
    for (let index = 0; index < COLUMN_COUNT; index++) {
      if (COLUMN_FRONT[index] !== front) continue;
      const cx = x + COLUMN_COS[index] * columnRadius;
      const cy = y + COLUMN_SIN[index] * columnRadius;
      strokeLine(ctx, p.at(cx, cy, baseZ, MAST_FROM), p.at(cx, cy, topZ, MAST_TO), gold, front ? 0.95 : 0.5, Math.max(1, 4 * zoom));
    }
  };
  drawColumns(false);
  cylinder(p, withFill(s, s.fill * 0.6), x, y, baseZ, 32, topZ - baseZ);
  drawColumns(true);
  // Entablature ring, golden dome and oculus.
  isoEllipse(ctx, p.at(x, y, topZ, PANTHEON_ENTABLATURE), columnRadius + 5, zoom);
  ctx.globalAlpha = 0.9; ctx.strokeStyle = gold; ctx.lineWidth = Math.max(1, 3 * zoom); ctx.stroke(); ctx.globalAlpha = 1;
  PANTHEON_DOME.color = gold;
  dome(p, PANTHEON_DOME, x, y, topZ, 40, 0.8);
  const oculus = p.at(x, y, topZ + 40 * 0.8 * 1.1, PANTHEON_OCULUS);
  ctx.beginPath(); ctx.ellipse(oculus.x, oculus.y, 7 * zoom, 3 * zoom, 0, 0, TAU);
  ctx.globalAlpha = 1; ctx.fillStyle = frame.palette.ground; ctx.fill(); ctx.strokeStyle = gold; ctx.stroke();
  // Light beam rising from the oculus.
  const beamHeight = 240 * zoom;
  const beam = ctx.createLinearGradient(oculus.x, oculus.y, oculus.x, oculus.y - beamHeight);
  beam.addColorStop(0, gold);
  beam.addColorStop(1, 'transparent');
  ctx.globalAlpha = frame.animate ? 0.28 + 0.08 * Math.sin(frame.time * 0.0015) : 0.3;
  ctx.fillStyle = beam;
  ctx.fillRect(oculus.x - 6 * zoom, oculus.y - beamHeight, 12 * zoom, beamHeight);
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ labels */

/** Bidi embedding/override (U+202A–U+202E) and isolate (U+2066–U+2069) controls. */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

/**
 * Canvas label text for an untrusted room title: bidi controls are stripped (so a title cannot reorder the
 * rest of the label), whitespace is collapsed, and truncation counts code points so surrogate pairs
 * (emoji, astral characters) are never split.
 */
export function truncateLabel(text: string, max = 26): string {
  const clean = text.replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : clean;
}

const LABEL_FONT_FAMILY = '"Space Grotesk", system-ui, sans-serif';
const LABEL_FONTS: Record<11 | 12, string> = {
  11: `600 11px ${LABEL_FONT_FAMILY}`,
  12: `600 12px ${LABEL_FONT_FAMILY}`,
};
const LABEL_ANCHOR = point();
const LABEL_PADDING = 14;

function labelFor(ctx: Ctx, cache: CityRenderCache | undefined, building: CityBuilding, fontSize: number): LabelEntry {
  const key = `${fontSize}|${building.id}`;
  const cached = cache?.labels.get(key);
  if (cached && cached.source === building.label) return cached;
  const text = truncateLabel(building.label);
  const entry: LabelEntry = { source: building.label, text, width: ctx.measureText(text).width + LABEL_PADDING };
  cache?.labels.set(key, entry);
  return entry;
}

function drawLabels(p: Painter) {
  const { ctx, frame, zoom } = p;
  const { view } = frame;
  const showRoomLabels = zoom >= 0.32;
  const fontSize = zoom < 0.5 ? 11 : 12;
  const height = fontSize + 8;
  ctx.font = LABEL_FONTS[fontSize];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const drawOrder = frame.scene.drawOrder;
  for (let index = 0; index < drawOrder.length; index++) {
    const building = drawOrder[index];
    const active = building.id === frame.selectedId || building.id === frame.hoveredId;
    if (!matchesFilter(building, frame.filter)) continue;
    if (building.kind === 'room' && !showRoomLabels && !active) continue;
    const anchor = p.at(building.x, building.y, building.height + 26, LABEL_ANCHOR);
    // Cheap reject before measuring: labels are at most a few hundred pixels wide.
    if (anchor.y + height / 2 < -CULL_MARGIN || anchor.y - height / 2 > view.height + CULL_MARGIN) continue;
    const label = labelFor(ctx, frame.cache, building, fontSize);
    const width = label.width;
    if (anchor.x + width / 2 < -CULL_MARGIN || anchor.x - width / 2 > view.width + CULL_MARGIN) continue;
    ctx.globalAlpha = active ? 0.95 : 0.78;
    ctx.fillStyle = frame.palette.panel;
    ctx.beginPath(); ctx.roundRect(anchor.x - width / 2, anchor.y - height / 2, width, height, 5); ctx.fill();
    ctx.strokeStyle = frame.palette[building.color]; ctx.lineWidth = 1; ctx.globalAlpha = active ? 1 : 0.55; ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = active ? frame.palette.text : frame.palette.textMuted;
    ctx.fillText(label.text, anchor.x, anchor.y + 0.5);
  }
}
