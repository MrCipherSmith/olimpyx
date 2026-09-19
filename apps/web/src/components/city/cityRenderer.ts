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
import { inhabitantPosition, type InhabitantFigure, type InhabitantPlan } from './inhabitants';
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
  /** True while the camera is diving or being dragged: every frame's camera differs, so rebuilding and
   * blitting the static layer would cost more than drawing the ground directly. The cache stays untouched
   * (not even invalidated) and is picked back up on the next idle/decorative frame. */
  cameraMoving?: boolean;
  /** Screen rects (CSS px, canvas coordinates) of HUD panels over the canvas; labels are moved off them. */
  occluders?: readonly Rect[];
  /** Real agents walking the avenues (City Shell §6); absent/null draws none. */
  inhabitants?: InhabitantPlan | null;
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

/** Truncated label text plus its measured width at each label font size (NaN until measured). */
interface LabelEntry { source: string; text: string; width11: number; width12: number; }
/** Truncated agent name tag and its measured width. */
interface FigureLabelEntry { source: string; text: string; width: number; }

/** Everything the building-label layout depends on; the layout is reused while none of it changes. */
export interface LabelLayoutKey {
  scene: CityScene | null;
  focalX: number;
  focalY: number;
  zoom: number;
  width: number;
  height: number;
  hoveredId: string | null;
  selectedId: string | null;
  filter: ArchetypeCategory | 'all' | null;
  occluders: readonly Rect[] | null;
}

export interface CityRenderCache {
  /** undefined: not created yet; null: offscreen canvases unavailable (draw directly). */
  layer: { canvas: HTMLCanvasElement; ctx: Ctx; key: StaticLayerKey } | null | undefined;
  /** Truncated text and measured widths per building id (no per-frame key strings). */
  labels: Map<string, LabelEntry>;
  /** Truncated name tag and measured width per inhabitant (agent) id. */
  figureLabels: Map<string, FigureLabelEntry>;
  /** Measured hover cards per building id (re-measured when the label or the subline changes). */
  cards: Map<string, CardEntry>;
  /** Label boxes of the last layout (a pool reused across frames); read by labelAt() for label clicks. */
  placed: PlacedLabel[];
  placedCount: number;
  /** Inputs of the layout in `placed`; `valid: false` forces the next frame to lay the labels out again. */
  layoutKey: LabelLayoutKey & { valid: boolean };
  /** How many times the building-label layout actually ran (diagnostics and tests). */
  layoutRuns: number;
  /** Inhabitant name-tag boxes of the last frame (a pool reused every frame), so they never overlap a
   * building label or each other; see drawInhabitants(). */
  figureBoxes: Rect[];
  /** The "+N" overflow tag: text and width, re-measured only when N changes. */
  overflow: { count: number; text: string; width: number };
}

export function createRenderCache(): CityRenderCache {
  return {
    layer: undefined, labels: new Map(), figureLabels: new Map(), cards: new Map(), placed: [], placedCount: 0,
    layoutKey: { valid: false, scene: null, focalX: 0, focalY: 0, zoom: 0, width: 0, height: 0, hoveredId: null, selectedId: null, filter: null, occluders: null },
    layoutRuns: 0, figureBoxes: [], overflow: { count: -1, text: '', width: 0 },
  };
}

/**
 * Drops every measured label, card and name tag (after a scene change, so entries of removed buildings and
 * agents never pile up, or once the display font has loaded and the old widths are wrong) and forces the next
 * frame to lay the labels out again.
 */
export function clearLabelCache(cache: CityRenderCache): void {
  cache.labels.clear();
  cache.figureLabels.clear();
  cache.cards.clear();
  cache.overflow.count = -1;
  cache.layoutKey.valid = false;
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
  // Short-circuits before drawCachedGround() is even called, so a moving camera never touches (or
  // invalidates) the offscreen layer at all.
  if (frame.cameraMoving || !drawCachedGround(painter)) drawGround(painter);
  if (frame.animate && frame.particles > 0) drawPulses(painter);
  const drawOrder = frame.scene.drawOrder;
  for (let index = 0; index < drawOrder.length; index++) {
    const building = drawOrder[index];
    if (buildingOnScreen(building, camera, view)) drawBuilding(painter, building);
  }
  if (frame.animate && frame.particles > 0) drawDrones(painter);
  drawLabels(painter);
  if (frame.inhabitants) drawInhabitants(painter, frame.inhabitants);
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

/** Matches footprintScreenBox's own half-width scale, so a screen-space radius can be turned back
 * into an equivalent world "reach" that produces that same half-width once footprintScreenBox
 * re-applies the factor. */
const ISO_HALFWIDTH_FACTOR = Math.SQRT2 * COS30;

/** World reach (footprint radius incl. decorations) and top height of what a building may paint. */
function buildingExtent(building: CityBuilding): { reach: number; top: number } {
  if (building.kind === 'library') return LIBRARY_EXTENT;
  if (building.kind === 'pantheon') return PANTHEON_EXTENT;
  if (building.kind === 'praetorium') return PRAETORIUM_EXTENT;
  // The active/hovered-building halo (drawBuilding, below) is a screen-space circle of radius up to
  // max(size*1.6, height*0.8)*zoom — at zoom above ~1.1 that reaches further sideways than the plain
  // footprint reach (70) scaled by the isometric width factor, so a tall room near the viewport edge
  // could have its halo clipped by culling that only knew about the footprint. Fold the halo's reach
  // into the box so it stays fully covered.
  const haloReach = Math.max(building.size * 1.6, building.height * 0.8) / ISO_HALFWIDTH_FACTOR;
  ROOM_EXTENT.reach = Math.max(70, haloReach);
  ROOM_EXTENT.top = building.height + 30;
  return ROOM_EXTENT;
}
const LIBRARY_EXTENT = { reach: 90, top: 200 };
const PANTHEON_EXTENT = { reach: 70, top: 380 }; // includes the light beam above the oculus
const PRAETORIUM_EXTENT = { reach: 70, top: 150 }; // includes the standard and its glow
const ROOM_EXTENT = { reach: 70, top: 0 };

/** Conservative screen box of everything a building may paint (silhouette, halo, beam), written into `out`. */
export function buildingScreenBox(building: CityBuilding, camera: Camera, view: Viewport, out: ScreenBox = { left: 0, top: 0, right: 0, bottom: 0 }): ScreenBox {
  const { reach, top } = buildingExtent(building);
  return footprintScreenBox(building.x, building.y, reach, top, camera, view, out);
}

/** Whether any pixel of the building can land inside the viewport (plus CULL_MARGIN). */
export function buildingOnScreen(building: CityBuilding, camera: Camera, view: Viewport): boolean {
  return boxInViewport(buildingScreenBox(building, camera, view, BOX), view, CULL_MARGIN);
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
  // Avenues start under the square plaza (drawn afterwards) so none leaves a gap at its edge.
  const avenueStart = scene.plazaHalf > 0 ? scene.plazaHalf * 0.9 : scene.forumRadius;
  for (const avenue of scene.avenues) {
    at(avenue.cos * avenueStart, avenue.sin * avenueStart, 0, from);
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

  drawPlaza(painter);
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ Forum plaza (static layer) */

/** How far the platform's side faces drop below the ground plane, so buildings stand flush on its top. */
const PLAZA_DEPTH = 10;
const PLAZA_TILE = 40;
const PLAZA_QUAD = pool(4);
const PLAZA_FROM = point();
const PLAZA_TO = point();
const PLAZA_STYLE: Style = { color: '', fill: 0.05, stroke: 0.4 };

/**
 * Forum Centralis after the prototype's drawRomanForumPlaza: a square raised platform with a paving grid,
 * arches on its four corners, a lit Via Sacra between the Library and the Pantheon (plus a spur to the
 * Praetorium when the owner sees one) and the golden milestone at the centre. Part of the cached ground layer.
 */
function drawPlaza(painter: Painter) {
  const { ctx, frame, at, zoom } = painter;
  const { palette, scene } = frame;
  const half = scene.plazaHalf;
  const centre = at(0, 0, 0);
  if (half <= 0) {
    // Legacy round forum for scenes without a plaza.
    isoEllipse(ctx, centre, scene.forumRadius, zoom);
    ctx.globalAlpha = 0.85; ctx.fillStyle = palette.raised; ctx.fill();
    ctx.globalAlpha = 0.55; ctx.strokeStyle = palette.gold; ctx.lineWidth = Math.max(0.8, 2 * zoom); ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(0.8, 1.5 * zoom);
  PLAZA_STYLE.color = palette.cyan;
  // Side faces facing the viewer (+x, +y), dropping below the ground plane.
  at(half, -half, -PLAZA_DEPTH, PLAZA_QUAD[0]); at(half, half, -PLAZA_DEPTH, PLAZA_QUAD[1]); at(half, half, 0, PLAZA_QUAD[2]); at(half, -half, 0, PLAZA_QUAD[3]);
  face(ctx, PLAZA_QUAD, 4, palette.panel, PLAZA_STYLE, 0.6);
  at(-half, half, -PLAZA_DEPTH, PLAZA_QUAD[0]); at(half, half, -PLAZA_DEPTH, PLAZA_QUAD[1]); at(half, half, 0, PLAZA_QUAD[2]); at(-half, half, 0, PLAZA_QUAD[3]);
  face(ctx, PLAZA_QUAD, 4, palette.panel, PLAZA_STYLE, 1);
  // Top slab with a golden inlay rim.
  at(-half, -half, 0, PLAZA_QUAD[0]); at(half, -half, 0, PLAZA_QUAD[1]); at(half, half, 0, PLAZA_QUAD[2]); at(-half, half, 0, PLAZA_QUAD[3]);
  ctx.beginPath();
  ctx.moveTo(PLAZA_QUAD[0].x, PLAZA_QUAD[0].y);
  for (let index = 1; index < 4; index++) ctx.lineTo(PLAZA_QUAD[index].x, PLAZA_QUAD[index].y);
  ctx.closePath();
  ctx.globalAlpha = 0.92; ctx.fillStyle = palette.raised; ctx.fill();
  ctx.globalAlpha = 0.65; ctx.strokeStyle = palette.gold; ctx.lineWidth = Math.max(0.8, 2 * zoom); ctx.stroke();
  // Paving grid.
  ctx.beginPath();
  for (let offset = -half + PLAZA_TILE; offset < half; offset += PLAZA_TILE) {
    at(offset, -half, 0, PLAZA_FROM); at(offset, half, 0, PLAZA_TO);
    ctx.moveTo(PLAZA_FROM.x, PLAZA_FROM.y); ctx.lineTo(PLAZA_TO.x, PLAZA_TO.y);
    at(-half, offset, 0, PLAZA_FROM); at(half, offset, 0, PLAZA_TO);
    ctx.moveTo(PLAZA_FROM.x, PLAZA_FROM.y); ctx.lineTo(PLAZA_TO.x, PLAZA_TO.y);
  }
  ctx.globalAlpha = 0.08; ctx.strokeStyle = palette.cyan; ctx.lineWidth = 1; ctx.stroke();
  // Inner compass circle (kept from the round forum).
  isoEllipse(ctx, centre, half * 0.86, zoom);
  ctx.globalAlpha = 0.25; ctx.strokeStyle = palette.gold; ctx.lineWidth = Math.max(0.6, 1.2 * zoom);
  ctx.setLineDash([4 * zoom, 6 * zoom]); ctx.stroke(); ctx.setLineDash([]);
  drawViaSacra(painter);
  // Golden milestone (Milliarium Aureum) at the centre.
  strokeLine(ctx, centre, at(0, 0, 30, PLAZA_TO), palette.gold, 0.95, Math.max(1, 4 * zoom));
  glowDot(painter, palette.gold, PLAZA_TO, 4, 0.95);
  // Arches on the four corners.
  const inset = half - 14;
  for (let index = 0; index < 4; index++) drawArch(painter, index & 1 ? inset : -inset, index & 2 ? inset : -inset);
  ctx.globalAlpha = 1;
}

function drawArch({ ctx, frame, at, zoom }: Painter, x: number, y: number) {
  const base = at(x, y, 0, PLAZA_FROM);
  const spread = 11 * zoom;
  const rise = 18 * zoom;
  ctx.beginPath();
  ctx.moveTo(base.x - spread, base.y); ctx.lineTo(base.x - spread, base.y - rise);
  ctx.arc(base.x, base.y - rise, spread, Math.PI, 0);
  ctx.lineTo(base.x + spread, base.y);
  ctx.globalAlpha = 0.8; ctx.strokeStyle = frame.palette.cyan; ctx.lineWidth = Math.max(0.8, 2.4 * zoom); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(base.x - spread * 1.35, base.y - rise - spread); ctx.lineTo(base.x + spread * 1.35, base.y - rise - spread);
  ctx.globalAlpha = 0.9; ctx.strokeStyle = frame.palette.gold; ctx.lineWidth = Math.max(0.8, 2 * zoom); ctx.stroke();
  ctx.globalAlpha = 1;
}

const LAMP_POINT = point();

/** The lit road between the Library and the Pantheon, with lamps on both sides; a spur leads to the Praetorium. */
function drawViaSacra(painter: Painter) {
  const { ctx, frame, at, zoom } = painter;
  const { palette, scene } = frame;
  let library: CityBuilding | null = null;
  let pantheon: CityBuilding | null = null;
  let praetorium: CityBuilding | null = null;
  for (const building of scene.buildings) {
    if (building.kind === 'library') library = building;
    else if (building.kind === 'pantheon') pantheon = building;
    else if (building.kind === 'praetorium') praetorium = building;
  }
  if (praetorium) {
    at(0, 0, 0, PLAZA_FROM); at(praetorium.x, praetorium.y, 0, PLAZA_TO);
    strokeLine(ctx, PLAZA_FROM, PLAZA_TO, palette.amber, 0.22, Math.max(1, 14 * zoom));
    strokeLine(ctx, PLAZA_FROM, PLAZA_TO, palette.amber, 0.7, Math.max(0.6, 1.4 * zoom));
  }
  if (!library || !pantheon) return;
  at(library.x, library.y, 0, PLAZA_FROM); at(pantheon.x, pantheon.y, 0, PLAZA_TO);
  strokeLine(ctx, PLAZA_FROM, PLAZA_TO, palette.gold, 0.22, Math.max(2, 24 * zoom));
  ctx.setLineDash([8 * zoom, 8 * zoom]);
  strokeLine(ctx, PLAZA_FROM, PLAZA_TO, palette.gold, 0.85, Math.max(0.8, 2.4 * zoom));
  ctx.setLineDash([]);
  // Lamps every ~40 world units on both kerbs (perpendicular offset along the world (1, 1) diagonal).
  const dx = pantheon.x - library.x;
  const dy = pantheon.y - library.y;
  const steps = Math.max(1, Math.round(Math.hypot(dx, dy) / 40));
  const length = Math.hypot(dx, dy) || 1;
  const kerbX = (-dy / length) * 17;
  const kerbY = (dx / length) * 17;
  for (let step = 1; step < steps; step++) {
    const t = step / steps;
    for (const side of KERB_SIDES) {
      at(library.x + dx * t + kerbX * side, library.y + dy * t + kerbY * side, 6, LAMP_POINT);
      // Halo scales with the zoom (unlike glowDot's fixed one) so the lamps never swell into blobs far out.
      drawGlow(ctx, palette.gold, LAMP_POINT.x, LAMP_POINT.y, Math.max(1.5, 8 * zoom), 0.55);
      ctx.globalAlpha = 0.9; ctx.fillStyle = palette.gold;
      ctx.beginPath(); ctx.arc(LAMP_POINT.x, LAMP_POINT.y, Math.max(0.6, 1.8 * zoom), 0, TAU); ctx.fill();
    }
  }
}
const KERB_SIDES = [-1, 1] as const;

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
const SHAPE_POINT_B = point();

/* Detail helpers in the prototype's spirit: cheap strokes batched into a single path each. */

/** Horizontal light bands across the two viewer-facing faces of a box footprint (window strips, LED rails). */
function bands(p: Painter, color: string, x: number, y: number, hx: number, hy: number, heights: readonly number[], alpha = 0.55) {
  const { ctx, at } = p;
  ctx.beginPath();
  for (const z of heights) {
    at(x + hx, y - hy, z, MAST_FROM); at(x + hx, y + hy, z, MAST_TO);
    ctx.moveTo(MAST_FROM.x, MAST_FROM.y); ctx.lineTo(MAST_TO.x, MAST_TO.y);
    at(x - hx, y + hy, z, MAST_FROM);
    ctx.lineTo(MAST_FROM.x, MAST_FROM.y);
  }
  ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = Math.max(0.5, 1 * p.zoom); ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Vertical pilasters on the front half of a cylinder or drum. */
function pilasters(p: Painter, color: string, x: number, y: number, r: number, z0: number, z1: number, count: number) {
  const { ctx, at } = p;
  ctx.beginPath();
  for (let index = 0; index < count; index++) {
    // Spread over the front half (angles −45°…135° face the viewer).
    const angle = -Math.PI / 4 + ((index + 0.5) * Math.PI) / count;
    const px = x + Math.cos(angle) * r; const py = y + Math.sin(angle) * r;
    at(px, py, z0, MAST_FROM); at(px, py, z1, MAST_TO);
    ctx.moveTo(MAST_FROM.x, MAST_FROM.y); ctx.lineTo(MAST_TO.x, MAST_TO.y);
  }
  ctx.globalAlpha = 0.75; ctx.strokeStyle = color; ctx.lineWidth = Math.max(0.6, 1.8 * p.zoom); ctx.stroke();
  ctx.globalAlpha = 1;
}

const APEX = point();

/** Square pyramid roof: the two viewer-facing triangles. */
function pyramid(p: Painter, style: Style, x: number, y: number, z: number, hx: number, h: number) {
  const { at, ctx, frame } = p;
  at(x, y, z + h, APEX);
  at(x + hx, y - hx, z, QUAD[0]); at(x + hx, y + hx, z, QUAD[1]); QUAD[2].x = APEX.x; QUAD[2].y = APEX.y;
  face(ctx, QUAD, 3, frame.palette.panel, style, 0.6);
  at(x - hx, y + hx, z, QUAD[0]); at(x + hx, y + hx, z, QUAD[1]); QUAD[2].x = APEX.x; QUAD[2].y = APEX.y;
  face(ctx, QUAD, 3, frame.palette.raised, style, 1);
}

/** Floating quorum ring with validator nodes (prototype's Consensus Chamber); nodes orbit only when animated. */
function quorumRing(p: Painter, color: string, nodeColor: string, x: number, y: number, z: number, radius: number) {
  const { ctx, frame, zoom } = p;
  const centre = p.at(x, y, z, SHAPE_POINT_B);
  const rx = radius * zoom; const ry = rx * 0.42;
  const spin = frame.time * 0.0009;
  ctx.globalAlpha = 0.85; ctx.strokeStyle = color; ctx.lineWidth = Math.max(0.6, 1.6 * zoom);
  ctx.beginPath(); ctx.ellipse(centre.x, centre.y, rx, ry, 0, 0, TAU); ctx.stroke();
  ctx.globalAlpha = 0.95; ctx.fillStyle = nodeColor;
  ctx.beginPath();
  const dot = Math.max(1, 2.6 * zoom);
  for (let node = 0; node < 5; node++) {
    const angle = spin + (node * TAU) / 5;
    const nx = centre.x + Math.cos(angle) * rx; const ny = centre.y + Math.sin(angle) * ry;
    ctx.moveTo(nx + dot, ny); ctx.arc(nx, ny, dot, 0, TAU);
  }
  ctx.fill();
  ctx.globalAlpha = 1;
}

const SHAPES: Record<CityBuilding['shape'], ShapeDrawer> = {
  library: drawLibrary,
  pantheon: drawPantheon,
  praetorium: drawPraetorium,
  lab_observatory(p, s, { x, y }) {
    box(p, s, x, y, 0, 36, 36, 40);
    bands(p, s.color, x, y, 36, 36, LAB_BANDS);
    cylinder(p, s, x, y, 40, 22, 30);
    pilasters(p, s.color, x, y, 22, 42, 68, 4);
    dome(p, s, x, y, 70, 22);
    const top = p.at(x, y, 108, SHAPE_POINT);
    const tilt = p.frame.time * 0.0006;
    p.ctx.globalAlpha = s.stroke; p.ctx.strokeStyle = s.color;
    p.ctx.beginPath(); p.ctx.ellipse(top.x, top.y, 16 * p.zoom, 6 * p.zoom, tilt, 0, TAU); p.ctx.stroke();
    mast(p, s.color, x, y, 88, 108, 1.5);
    glowDot(p, p.frame.palette.text, top, 1.6, 0.9);
  },
  archive_data_vault(p, s, { x, y }) {
    box(p, s, x, y, 0, 40, 40, 62);
    bands(p, s.color, x, y, 40, 40, VAULT_BANDS, 0.35);
    for (const z of VAULT_RING_Z) { isoEllipse(p.ctx, p.at(x, y, z, SHAPE_POINT), 60, p.zoom); p.ctx.globalAlpha = 0.6; p.ctx.strokeStyle = s.color; p.ctx.stroke(); }
    glowDot(p, s.color, p.at(x, y, 62, GLOW_POINT), 3, 0.8);
    p.ctx.globalAlpha = 1;
  },
  crypto_proving_grounds(p, s, { x, y }) {
    prism(p, s, x, y, 0, 46, 14, 6, Math.PI / 6);
    for (let index = 0; index < 3; index++) box(p, s, x + PYLON_COS[index] * 30, y + PYLON_SIN[index] * 30, 14, 5, 5, 44);
    // Proof links between the pylon tips.
    const { ctx } = p;
    ctx.beginPath();
    for (let index = 0; index <= 3; index++) {
      const tip = p.at(x + PYLON_COS[index % 3] * 30, y + PYLON_SIN[index % 3] * 30, 58, SHAPE_POINT);
      if (index === 0) ctx.moveTo(tip.x, tip.y); else ctx.lineTo(tip.x, tip.y);
    }
    ctx.globalAlpha = 0.6; ctx.strokeStyle = s.color; ctx.lineWidth = Math.max(0.6, 1.2 * p.zoom); ctx.stroke(); ctx.globalAlpha = 1;
    glowDot(p, s.color, p.at(x, y, 40, GLOW_POINT), 5, 0.9);
  },
  senate_rotunda(p, s, { x, y }) {
    box(p, s, x, y, 0, 42, 42, 8);
    cylinder(p, s, x, y, 8, 34, 38);
    pilasters(p, p.frame.palette.gold, x, y, 34, 10, 44, 6);
    dome(p, s, x, y, 46, 34);
    glowDot(p, p.frame.palette.gold, p.at(x, y, 46 + 34 * 0.85 * 1.1, GLOW_POINT), 2.5, 0.9);
  },
  forum_agora(p, s, { x, y }) {
    cylinder(p, s, x, y, 0, 46, 8);
    cylinder(p, s, x, y, 8, 34, 8);
    cylinder(p, s, x, y, 16, 20, 6);
    pilasters(p, s.color, x, y, 40, 8, 16, 7);
    mast(p, s.color, x, y, 22, 46, 3);
    glowDot(p, s.color, p.at(x, y, 48, GLOW_POINT), 4, 0.9);
  },
  tribunal_chamber(p, s, { x, y }) {
    box(p, s, x, y, 0, 44, 44, 14);
    box(p, s, x, y, 14, 32, 32, 14);
    box(p, s, x, y, 28, 20, 20, 32);
    bands(p, s.color, x, y, 20, 20, TRIBUNAL_BANDS);
    strokeLine(p.ctx, p.at(x - 22, y + 22, 72, MAST_FROM), p.at(x + 22, y - 22, 72, MAST_TO), s.color, 0.95, Math.max(1, 2 * p.zoom));
    mast(p, s.color, x, y, 60, 74, 2);
    quorumRing(p, s.color, p.frame.palette.emerald, x, y, 90, 24);
  },
  cyber_forge(p, s, { x, y }) {
    cylinder(p, s, x - 22, y - 14, 0, 8, 80);
    cylinder(p, s, x + 6, y - 22, 0, 8, 70);
    box(p, s, x, y + 6, 0, 44, 26, 44);
    bands(p, s.color, x, y + 6, 44, 26, FORGE_BANDS, 0.4);
    drawCrane(p, s.color, x + 26, y + 22, 44);
    const flicker = p.frame.animate ? 0.6 + 0.4 * Math.abs(Math.sin(p.frame.time * 0.004)) : 0.8;
    glowDot(p, s.color, p.at(x - 22, y - 14, 84, GLOW_POINT), 4, flicker);
  },
  neural_matrix_spire(p, s, { x, y }) {
    box(p, s, x, y, 0, 30, 30, 44);
    bands(p, s.color, x, y, 30, 30, SPIRE_BANDS_LOW);
    box(p, s, x, y, 44, 21, 21, 40);
    bands(p, s.color, x, y, 21, 21, SPIRE_BANDS_MID);
    box(p, s, x, y, 84, 12, 12, 36);
    mast(p, s.color, x, y, 120, 146, 1.5);
    glowDot(p, s.color, p.at(x, y, 148, GLOW_POINT), 3, 0.9);
  },
  telemetry_beacon(p, s, { x, y }) {
    box(p, s, x, y, 0, 28, 28, 10);
    box(p, withFill(s, s.fill * 0.4), x, y, 10, 8, 8, 124);
    // Lattice cross-bracing on the mast's front faces.
    const { ctx } = p;
    ctx.beginPath();
    for (let z = 10; z < 130; z += 20) {
      at2(p, x + 8, y - 8, z, x + 8, y + 8, z + 20); at2(p, x + 8, y + 8, z, x + 8, y - 8, z + 20);
      at2(p, x - 8, y + 8, z, x + 8, y + 8, z + 20); at2(p, x + 8, y + 8, z, x - 8, y + 8, z + 20);
    }
    ctx.globalAlpha = 0.45; ctx.strokeStyle = s.color; ctx.lineWidth = Math.max(0.5, 0.9 * p.zoom); ctx.stroke(); ctx.globalAlpha = 1;
    const pulse = p.frame.animate ? 0.5 + 0.5 * Math.abs(Math.sin(p.frame.time * 0.002)) : 0.9;
    glowDot(p, s.color, p.at(x, y, 140, GLOW_POINT), 6, pulse);
  },
  command_citadel(p, s, { x, y }) {
    box(p, s, x - 40, y - 40, 0, 9, 9, 56);
    box(p, s, x, y, 0, 44, 44, 32);
    bands(p, s.color, x, y, 44, 44, CITADEL_BANDS, 0.4);
    box(p, s, x, y, 32, 18, 18, 56);
    box(p, s, x + 40, y - 40, 0, 9, 9, 56);
    box(p, s, x - 40, y + 40, 0, 9, 9, 56);
    box(p, s, x + 40, y + 40, 0, 9, 9, 56);
    // Shield grid between the front tower tops, with emitters (prototype's security bastion).
    const { ctx } = p;
    const a = p.at(x - 40, y + 40, 62, MAST_FROM); ctx.beginPath(); ctx.moveTo(a.x, a.y);
    const b = p.at(x + 40, y + 40, 62, MAST_FROM); ctx.lineTo(b.x, b.y);
    const c = p.at(x + 40, y - 40, 62, MAST_FROM); ctx.lineTo(c.x, c.y);
    ctx.globalAlpha = 0.7; ctx.strokeStyle = s.color; ctx.lineWidth = Math.max(0.6, 1.6 * p.zoom); ctx.stroke(); ctx.globalAlpha = 1;
    for (let index = 0; index < 4; index++) glowDot(p, s.color, p.at(x + CORNER_X[index] * 40, y + CORNER_Y[index] * 40, 62, GLOW_POINT), 2, 0.9);
    mast(p, s.color, x, y, 88, 108, 1.4);
  },
  surveillance_panopticon(p, s, { x, y }) {
    cylinder(p, s, x, y, 0, 44, 28);
    pilasters(p, s.color, x, y, 44, 4, 24, 9);
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
    // Landing pad on the hub roof and running lights along the transit arms.
    isoEllipse(p.ctx, p.at(x, y, 44, SHAPE_POINT), 13, p.zoom);
    p.ctx.globalAlpha = 0.7; p.ctx.strokeStyle = s.color; p.ctx.stroke();
    const run = p.frame.animate ? (p.frame.time * 0.0004) % 1 : 0.5;
    for (let index = 0; index < 4; index++) {
      const distance = 14 + run * 30;
      glowDot(p, s.color, p.at(x + CROSS_X[index] * distance, y + CROSS_Y[index] * distance, 15, GLOW_POINT), 1.8, 0.85);
    }
    p.ctx.globalAlpha = 1;
  },
};

/** Adds a segment (world → screen) to the current path. */
function at2(p: Painter, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  p.at(x0, y0, z0, MAST_FROM); p.at(x1, y1, z1, MAST_TO);
  p.ctx.moveTo(MAST_FROM.x, MAST_FROM.y); p.ctx.lineTo(MAST_TO.x, MAST_TO.y);
}

/** Construction crane (prototype's Foundry): mast, a slowly slewing jib and a hanging voxel. */
function drawCrane(p: Painter, color: string, x: number, y: number, z: number) {
  const { ctx, frame, zoom } = p;
  const top = p.at(x, y, z + 50, SHAPE_POINT);
  mast(p, color, x, y, z, z + 50, 2.4);
  const angle = frame.animate ? frame.time * 0.0005 : 0.6;
  const arm = 30 * zoom;
  const endX = top.x + Math.cos(angle) * arm; const endY = top.y + Math.sin(angle) * arm * 0.5;
  ctx.beginPath();
  ctx.moveTo(top.x - Math.cos(angle) * 10 * zoom, top.y - Math.sin(angle) * 5 * zoom); ctx.lineTo(endX, endY);
  ctx.moveTo(endX, endY); ctx.lineTo(endX, endY + 16 * zoom);
  ctx.globalAlpha = 0.9; ctx.strokeStyle = frame.palette.gold; ctx.lineWidth = Math.max(0.6, 1.6 * zoom); ctx.stroke();
  const voxel = 7 * zoom;
  ctx.beginPath(); ctx.rect(endX - voxel / 2, endY + 16 * zoom, voxel, voxel);
  ctx.globalAlpha = 0.6; ctx.fillStyle = frame.palette.cyan; ctx.fill();
  ctx.globalAlpha = 0.9; ctx.strokeStyle = frame.palette.cyan; ctx.stroke();
  ctx.globalAlpha = 1;
}

const LAB_BANDS = [14, 26] as const;
const VAULT_BANDS = [10, 30, 52] as const;
const TRIBUNAL_BANDS = [40, 50] as const;
const FORGE_BANDS = [16, 30] as const;
const SPIRE_BANDS_LOW = [12, 24, 36] as const;
const SPIRE_BANDS_MID = [56, 70] as const;
const CITADEL_BANDS = [12, 22] as const;
const CORNER_X = [-1, 1, -1, 1] as const;
const CORNER_Y = [-1, -1, 1, 1] as const;
const CROSS_X = [1, -1, 0, 0] as const;
const CROSS_Y = [0, 0, 1, -1] as const;

/* The Praetorium: owner-only slate-and-gold citadel at the front of the Forum (entrance to Owner controls). */
const PRAETORIUM_WALL: Style = { color: '', fill: 0.2, stroke: 0.85 };
const PRAETORIUM_GOLD: Style = { color: '', fill: 0.32, stroke: 0.95 };

function drawPraetorium(p: Painter, s: Style, { x, y }: CityBuilding) {
  const { palette } = p.frame;
  const active = s.fill > 0.3;
  PRAETORIUM_WALL.color = palette.slate; PRAETORIUM_WALL.fill = active ? 0.3 : 0.2;
  PRAETORIUM_GOLD.color = s.color;
  const gold = palette.gold;
  // Stepped plinth.
  box(p, PRAETORIUM_GOLD, x, y, 0, 52, 52, 6);
  box(p, PRAETORIUM_WALL, x, y, 6, 46, 46, 8);
  // Back and side towers, the keep, then the front tower (painter order within the building).
  praetoriumTower(p, x - 34, y - 34); praetoriumTower(p, x + 34, y - 34); praetoriumTower(p, x - 34, y + 34);
  box(p, PRAETORIUM_WALL, x, y, 14, 28, 28, 44);
  bands(p, gold, x, y, 28, 28, PRAETORIUM_BANDS, 0.7);
  // Gate on the front (+y) face.
  const gate = p.at(x, y + 28, 14, SHAPE_POINT);
  const { ctx, zoom } = p;
  ctx.beginPath(); ctx.moveTo(gate.x - 7 * zoom, gate.y + 2 * zoom); ctx.lineTo(gate.x - 7 * zoom, gate.y - 14 * zoom);
  ctx.arc(gate.x, gate.y - 14 * zoom, 7 * zoom, Math.PI, 0); ctx.lineTo(gate.x + 7 * zoom, gate.y + 2 * zoom);
  ctx.globalAlpha = 0.9; ctx.fillStyle = palette.ground; ctx.fill(); ctx.strokeStyle = gold; ctx.lineWidth = Math.max(0.6, 1.4 * zoom); ctx.stroke(); ctx.globalAlpha = 1;
  pyramid(p, PRAETORIUM_GOLD, x, y, 58, 28, 24);
  praetoriumTower(p, x + 34, y + 34);
  // Standard with a golden crest.
  mast(p, gold, x, y, 82, 104, 1.6);
  glowDot(p, gold, p.at(x, y, 106, GLOW_POINT), 4, 0.95);
}
const PRAETORIUM_BANDS = [26, 40, 52] as const;

function praetoriumTower(p: Painter, x: number, y: number) {
  cylinder(p, PRAETORIUM_WALL, x, y, 14, 8, 50);
  dome(p, PRAETORIUM_GOLD, x, y, 64, 8, 0.9);
}

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
const CARD_TITLE_FONT = `700 12px ${LABEL_FONT_FAMILY}`;
const CARD_SUB_FONT = `500 10px ${LABEL_FONT_FAMILY}`;
const LABEL_PADDING = 14;
const CARD_PADDING = 22;
const CARD_HEIGHT = 36;
/** Room labels are hidden below this zoom unless their building is hovered or selected. */
export const ROOM_LABEL_MIN_ZOOM = 0.32;
/** World height above a building's roof at which its label is anchored. */
const LABEL_LIFT = 26;

/** A screen-space rectangle in CSS pixels of the canvas (same edges as a DOMRect). */
export interface Rect { left: number; top: number; right: number; bottom: number; }

const LANDMARK_SUBLINES: Record<Exclude<CityBuilding['kind'], 'room'>, string> = {
  library: 'Knowledge',
  pantheon: 'Agents',
  praetorium: 'Owner controls',
};

/**
 * Second line of the hover card, from real data only: the archetype name, plus `message_count` when the API
 * returned one for the room; landmarks name the screen they open. Never an invented metric.
 */
export function cardSubline(building: CityBuilding): string {
  if (building.kind !== 'room') return LANDMARK_SUBLINES[building.kind];
  const name = building.archetype?.nameEn ?? '';
  const count = building.room?.messageCount;
  if (typeof count !== 'number' || !Number.isFinite(count)) return name;
  const whole = Math.max(0, Math.floor(count));
  const messages = `${whole} ${whole === 1 ? 'message' : 'messages'}`;
  return name ? `${name} · ${messages}` : messages;
}

interface CardEntry { building: CityBuilding; source: string; subSource: string; title: string; sub: string; width: number; }

/** Cached truncated label of a building, with its width at `fontSize` measured on first use. */
function labelFor(ctx: Ctx, cache: CityRenderCache | undefined, building: CityBuilding, fontSize: 11 | 12): LabelEntry {
  let entry = cache?.labels.get(building.id);
  if (!entry || entry.source !== building.label) {
    entry = { source: building.label, text: truncateLabel(building.label), width11: NaN, width12: NaN };
    cache?.labels.set(building.id, entry);
  }
  if (Number.isNaN(fontSize === 11 ? entry.width11 : entry.width12)) {
    ctx.font = LABEL_FONTS[fontSize];
    const width = ctx.measureText(entry.text).width + LABEL_PADDING;
    if (fontSize === 11) entry.width11 = width; else entry.width12 = width;
  }
  return entry;
}

const labelWidth = (entry: LabelEntry, fontSize: 11 | 12) => (fontSize === 11 ? entry.width11 : entry.width12);

function cardFor(ctx: Ctx, cache: CityRenderCache | undefined, building: CityBuilding): CardEntry {
  const cached = cache?.cards.get(building.id);
  // Buildings are immutable per scene: the same object means the same label and subline (no per-frame string).
  if (cached && cached.building === building) return cached;
  const sub = cardSubline(building);
  if (cached && cached.source === building.label && cached.subSource === sub) { cached.building = building; return cached; }
  const title = truncateLabel(building.label, 32);
  const subText = truncateLabel(sub, 40);
  ctx.font = CARD_TITLE_FONT;
  const titleWidth = ctx.measureText(title).width;
  ctx.font = CARD_SUB_FONT;
  const subWidth = ctx.measureText(subText).width;
  const entry: CardEntry = { building, source: building.label, subSource: sub, title, sub: subText, width: Math.max(titleWidth, subWidth) + CARD_PADDING };
  cache?.cards.set(building.id, entry);
  return entry;
}

/* ------------------------------------------------------------------ label placement */

/** One label box produced by layoutLabels; `left/top/right/bottom` is where it is drawn when `visible`. */
export interface PlacedLabel extends Rect {
  building: CityBuilding;
  /** Screen point where the label would sit undisturbed (above the roof). */
  anchorX: number;
  anchorY: number;
  /** The hover card (name + subline) instead of the plain name tag. */
  card: boolean;
  active: boolean;
  visible: boolean;
}

export interface LabelLayoutInput {
  scene: CityScene;
  camera: Camera;
  view: Viewport;
  hoveredId: string | null;
  selectedId: string | null;
  filter: ArchetypeCategory | 'all';
  /** Screen rects of HUD panels over the canvas; labels are nudged off them or hidden. */
  occluders?: readonly Rect[];
}

/** Measures a label (plain name tag, or the hover card when `card`); returns the box width in CSS px. */
export type LabelMeasure = (building: CityBuilding, card: boolean) => number;

const LABEL_GAP = 3;
const OCCLUDER_GAP = 6;
/** Vertical nudges tried in order, in label steps: in place, up 1–3 steps, one step down. */
const NUDGES = [0, -1, -2, -3, 1] as const;
const NO_OCCLUDERS: readonly Rect[] = [];

function overlaps(left: number, top: number, right: number, bottom: number, other: Rect, gap: number): boolean {
  return left < other.right + gap && right > other.left - gap && top < other.bottom + gap && bottom > other.top - gap;
}

function blocked(left: number, top: number, right: number, bottom: number, out: readonly PlacedLabel[], placedCount: number, occluders: readonly Rect[]): boolean {
  for (let index = 0; index < occluders.length; index++) if (overlaps(left, top, right, bottom, occluders[index], OCCLUDER_GAP)) return true;
  for (let index = 0; index < placedCount; index++) {
    const other = out[index];
    if (other.visible && overlaps(left, top, right, bottom, other, LABEL_GAP)) return true;
  }
  return false;
}

function setBox(label: PlacedLabel, left: number, top: number, width: number, height: number) {
  label.left = left; label.top = top; label.right = left + width; label.bottom = top + height; label.visible = true;
}

/** Tries the vertical nudges, then a sideways escape off each occluder under the label; hides it when nothing fits. */
function place(label: PlacedLabel, width: number, height: number, out: readonly PlacedLabel[], placedCount: number, occluders: readonly Rect[]) {
  const baseLeft = label.anchorX - width / 2;
  const baseTop = label.anchorY - height / 2;
  const step = height + LABEL_GAP * 2;
  for (let index = 0; index < NUDGES.length; index++) {
    const top = baseTop + NUDGES[index] * step;
    if (!blocked(baseLeft, top, baseLeft + width, top + height, out, placedCount, occluders)) { setBox(label, baseLeft, top, width, height); return; }
  }
  for (let index = 0; index < occluders.length; index++) {
    const occluder = occluders[index];
    if (!overlaps(baseLeft, baseTop, baseLeft + width, baseTop + height, occluder, OCCLUDER_GAP)) continue;
    const toRight = occluder.right + OCCLUDER_GAP + 1 - baseLeft;
    const toLeft = occluder.left - OCCLUDER_GAP - 1 - (baseLeft + width);
    const first = Math.abs(toRight) <= Math.abs(toLeft) ? toRight : toLeft;
    const second = first === toRight ? toLeft : toRight;
    for (let attempt = 0; attempt < 2; attempt++) {
      const dx = attempt === 0 ? first : second;
      if (Math.abs(dx) > width) continue;
      if (!blocked(baseLeft + dx, baseTop, baseLeft + dx + width, baseTop + height, out, placedCount, occluders)) { setBox(label, baseLeft + dx, baseTop, width, height); return; }
    }
  }
  label.visible = false;
}

function labelSlot(out: PlacedLabel[], index: number, building: CityBuilding): PlacedLabel {
  let slot = out[index];
  if (!slot) { slot = { building, anchorX: 0, anchorY: 0, left: 0, top: 0, right: 0, bottom: 0, card: false, active: false, visible: false }; out[index] = slot; }
  slot.building = building;
  return slot;
}

const LAYOUT_ANCHOR = point();

/**
 * Collision-free label layout, recomputed each frame into the caller-owned `out` pool (no sorting and no
 * per-label allocation once the pool is warm). Priority: the hover card first, then the Forum landmarks,
 * then room labels from the nearest building outwards. A label that would cover another label or a HUD
 * occluder is nudged up (then once down, then sideways off the occluder); if nothing fits it is hidden.
 * Returns how many entries of `out` are in use this frame (hidden ones included, with `visible: false`).
 */
export function layoutLabels(input: LabelLayoutInput, measure: LabelMeasure, out: PlacedLabel[]): number {
  const { scene, camera, view, filter } = input;
  const occluders = input.occluders ?? NO_OCCLUDERS;
  const showRoomLabels = camera.zoom >= ROOM_LABEL_MIN_ZOOM;
  const plainHeight = (camera.zoom < 0.5 ? 11 : 12) + 8;
  const cardId = input.hoveredId ?? input.selectedId;
  const drawOrder = scene.drawOrder;
  let count = 0;
  // Pass 0: the hover card; pass 1: landmarks; pass 2: rooms, nearest (end of the painter order) first.
  for (let pass = 0; pass < 3; pass++) {
    for (let order = drawOrder.length - 1; order >= 0; order--) {
      const building = drawOrder[order];
      const isCard = building.id === cardId;
      if (pass === 0 ? !isCard : isCard || (pass === 1) === (building.kind === 'room')) continue;
      if (!matchesFilter(building, filter)) continue;
      const active = isCard || building.id === input.selectedId || building.id === input.hoveredId;
      if (building.kind === 'room' && !showRoomLabels && !active) continue;
      const anchor = worldToScreen(building.x, building.y, building.height + LABEL_LIFT, camera, view, LAYOUT_ANCHOR);
      const height = isCard ? CARD_HEIGHT : plainHeight;
      // The card grows upwards from where the plain tag would sit, so it never covers its own building more.
      const centreY = anchor.y - (height - plainHeight) / 2;
      // Cheap reject before measuring: labels are at most a few hundred pixels wide.
      if (centreY + height / 2 < -CULL_MARGIN || centreY - height / 2 > view.height + CULL_MARGIN) continue;
      const width = measure(building, isCard);
      if (anchor.x + width / 2 < -CULL_MARGIN || anchor.x - width / 2 > view.width + CULL_MARGIN) continue;
      const label = labelSlot(out, count, building);
      label.anchorX = anchor.x; label.anchorY = centreY;
      label.card = isCard; label.active = active;
      place(label, width, height, out, count, occluders);
      count++;
    }
  }
  return count;
}

/**
 * Id of the building whose visible label (or hover card) contains the screen point in the last rendered
 * frame, or null. Lets the canvas treat a click on a label like a click on its building.
 */
export function labelAt(cache: CityRenderCache, sx: number, sy: number): string | null {
  // Later entries were placed around earlier ones, so any hit is unambiguous; the card (index 0) wins ties.
  for (let index = 0; index < cache.placedCount; index++) {
    const label = cache.placed[index];
    if (label.visible && sx >= label.left && sx <= label.right && sy >= label.top && sy <= label.bottom) return label.building.id;
  }
  return null;
}

/* ------------------------------------------------------------------ label drawing */

const LEADER_POINT = point();

/* Module-level measure state, so a relayout does not allocate a fresh closure. */
let measureCtx: Ctx | null = null;
let measureCache: CityRenderCache | undefined;
let measureFontSize: 11 | 12 = 12;
const measureLabel: LabelMeasure = (building, card) => (card
  ? cardFor(measureCtx!, measureCache, building).width
  : labelWidth(labelFor(measureCtx!, measureCache, building, measureFontSize), measureFontSize));

/** Whether the building-label layout in `cache.placed` still matches this frame; records the frame's key when not. */
function layoutStale(cache: CityRenderCache, frame: RenderFrame, occluders: readonly Rect[]): boolean {
  const key = cache.layoutKey;
  const { camera, view } = frame;
  if (key.valid && key.scene === frame.scene && key.focalX === camera.focalX && key.focalY === camera.focalY && key.zoom === camera.zoom
    && key.width === view.width && key.height === view.height && key.hoveredId === frame.hoveredId && key.selectedId === frame.selectedId
    && key.filter === frame.filter && key.occluders === occluders) return false;
  key.valid = true; key.scene = frame.scene; key.focalX = camera.focalX; key.focalY = camera.focalY; key.zoom = camera.zoom;
  key.width = view.width; key.height = view.height; key.hoveredId = frame.hoveredId; key.selectedId = frame.selectedId;
  key.filter = frame.filter; key.occluders = occluders;
  return true;
}

function drawLabels(p: Painter) {
  const { ctx, frame, zoom } = p;
  const cache = frame.cache;
  const fontSize: 11 | 12 = zoom < 0.5 ? 11 : 12;
  const occluders = frame.occluders ?? NO_OCCLUDERS;
  let out: PlacedLabel[];
  let count: number;
  // The full layout (~L² overlap checks) only reruns when the camera, hover, selection, filter, scene, viewport
  // or occluders changed; an idle decorative frame redraws the cached boxes.
  if (!cache || layoutStale(cache, frame, occluders)) {
    measureCtx = ctx; measureCache = cache; measureFontSize = fontSize;
    out = cache ? cache.placed : [];
    count = layoutLabels(frame, measureLabel, out);
    measureCtx = null; measureCache = undefined;
    if (cache) { cache.placedCount = count; cache.layoutRuns++; }
  } else {
    out = cache.placed;
    count = cache.placedCount;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let card: PlacedLabel | null = null;
  // Plain tags never overlap each other after layout, so their drawing order does not matter; the card goes last.
  for (let index = 0; index < count; index++) {
    const label = out[index];
    if (!label.visible) continue;
    if (label.card) { card = label; continue; }
    drawLeader(p, label);
    const entry = labelFor(ctx, cache, label.building, fontSize);
    const width = label.right - label.left;
    ctx.font = LABEL_FONTS[fontSize];
    ctx.globalAlpha = label.active ? 0.95 : 0.78;
    ctx.fillStyle = frame.palette.panel;
    ctx.beginPath(); ctx.roundRect(label.left, label.top, width, label.bottom - label.top, 5); ctx.fill();
    ctx.strokeStyle = frame.palette[label.building.color]; ctx.lineWidth = 1; ctx.globalAlpha = label.active ? 1 : 0.55; ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = label.active ? frame.palette.text : frame.palette.textMuted;
    ctx.fillText(entry.text, label.left + width / 2, (label.top + label.bottom) / 2 + 0.5);
  }
  if (card) drawCard(p, card);
}

/** Pin from the roof to the label edge: always for the card, and for a plain tag that had to move away. */
function drawLeader(p: Painter, label: PlacedLabel, always = false) {
  const centreX = (label.left + label.right) / 2;
  const centreY = (label.top + label.bottom) / 2;
  if (!always && Math.abs(centreX - label.anchorX) < 2 && Math.abs(centreY - label.anchorY) < 2) return;
  const { ctx, frame } = p;
  const roof = p.at(label.building.x, label.building.y, label.building.height, LEADER_POINT);
  const endY = roof.y < label.top ? label.top : label.bottom;
  const endX = Math.min(label.right - 6, Math.max(label.left + 6, roof.x));
  ctx.globalAlpha = always ? 0.8 : 0.45; ctx.strokeStyle = frame.palette[label.building.color]; ctx.lineWidth = always ? 1.2 : 1;
  ctx.beginPath(); ctx.moveTo(roof.x, roof.y); ctx.lineTo(endX, endY); ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Hover card: accent pin, panel, name and a real-data subline. Text is untrusted and only ever filled. */
function drawCard(p: Painter, label: PlacedLabel) {
  const { ctx, frame } = p;
  const entry = cardFor(ctx, frame.cache, label.building);
  const accent = frame.palette[label.building.color];
  const width = label.right - label.left;
  const centreX = label.left + width / 2;
  drawLeader(p, label, true);
  drawGlow(ctx, accent, centreX, (label.top + label.bottom) / 2, width * 0.62, 0.18);
  ctx.globalAlpha = 0.97; ctx.fillStyle = frame.palette.panel;
  ctx.beginPath(); ctx.roundRect(label.left, label.top, width, CARD_HEIGHT, 6); ctx.fill();
  ctx.globalAlpha = 1; ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.font = CARD_TITLE_FONT; ctx.fillStyle = frame.palette.text;
  ctx.fillText(entry.title, centreX, label.top + 13);
  ctx.font = CARD_SUB_FONT; ctx.fillStyle = accent;
  ctx.fillText(entry.sub, centreX, label.top + 26);
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ inhabitants (agents on the roads, City Shell §6) */

const INHABITANT_FONT = `600 10px ${LABEL_FONT_FAMILY}`;
const INHABITANT_LABEL_MAX = 18;
const INHABITANT_LABEL_PADDING = 10;
const INHABITANT_LABEL_HEIGHT = 16;
const INHABITANT_LIFT = 14;
const INHABITANT_GLYPH_RADIUS = 3;
const INHABITANT_GLYPH_Z = 6;
const OVERFLOW_LIFT = LABEL_LIFT * 3;
const EMPTY_PLACED: readonly PlacedLabel[] = [];
const INHABITANT_POINT = point();
const INHABITANT_WORLD = point();
const OVERFLOW_POINT = point();
/** Figure boxes when the frame has no render cache (tests, previews). */
const UNCACHED_FIGURE_BOXES: Rect[] = [];
/** "+N" tag when the frame has no render cache. */
const UNCACHED_OVERFLOW = { count: -1, text: '', width: 0 };
const INHABITANT_BOX: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

/** Measures (and caches) an agent's truncated name tag; untrusted text, only ever drawn with fillText. */
function inhabitantLabelEntry(ctx: Ctx, cache: CityRenderCache | undefined, figure: InhabitantFigure): FigureLabelEntry {
  const cached = cache?.figureLabels.get(figure.id);
  if (cached && cached.source === figure.name) return cached;
  const text = truncateLabel(figure.name, INHABITANT_LABEL_MAX);
  ctx.font = INHABITANT_FONT;
  const entry: FigureLabelEntry = { source: figure.name, text, width: ctx.measureText(text).width + INHABITANT_LABEL_PADDING };
  cache?.figureLabels.set(figure.id, entry);
  return entry;
}

/** Same vertical-nudge strategy as place() (labels above), generalised to plain rectangles so it can test
 * against both the already-placed building labels and the inhabitant boxes placed earlier this frame,
 * without needing a full PlacedLabel/CityBuilding for every figure. Writes the box into `out` on success. */
function placeInhabitantBox(
  anchorX: number, anchorY: number, width: number, height: number,
  buildingLabels: readonly PlacedLabel[], buildingCount: number,
  figureBoxes: readonly Rect[], figureCount: number,
  occluders: readonly Rect[], out: Rect,
): boolean {
  const baseLeft = anchorX - width / 2;
  const baseTop = anchorY - height / 2;
  const step = height + LABEL_GAP * 2;
  for (let index = 0; index < NUDGES.length; index++) {
    const top = baseTop + NUDGES[index] * step;
    const left = baseLeft; const right = baseLeft + width; const bottom = top + height;
    let blocked = false;
    for (let i = 0; i < occluders.length && !blocked; i++) blocked = overlaps(left, top, right, bottom, occluders[i], OCCLUDER_GAP);
    for (let i = 0; i < buildingCount && !blocked; i++) { const b = buildingLabels[i]; if (b.visible) blocked = overlaps(left, top, right, bottom, b, LABEL_GAP); }
    for (let i = 0; i < figureCount && !blocked; i++) blocked = overlaps(left, top, right, bottom, figureBoxes[i], LABEL_GAP);
    if (!blocked) { out.left = left; out.top = top; out.right = right; out.bottom = bottom; return true; }
  }
  return false;
}

function rectSlot(pool: Rect[], index: number): Rect {
  let slot = pool[index];
  if (!slot) { slot = { left: 0, top: 0, right: 0, bottom: 0 }; pool[index] = slot; }
  return slot;
}

/**
 * Draws the real agents walking the city's avenues: a small glyph at its current position (from
 * inhabitantPosition, computed from the figure's precomputed path and the frame clock — no re-planning
 * and no per-frame allocation of the figure list itself) plus its real name, laid out with the same
 * collision-avoidance as building labels so neither ever covers the other or a HUD panel. Online agents
 * glow softly (a pre-rendered sprite, never shadowBlur); offline agents are dimmed and motionless. A
 * "+N" near the Pantheon accounts for real agents beyond the cap — never presented as a metric.
 */
function drawInhabitants(painter: Painter, inhabitants: InhabitantPlan) {
  const { ctx, frame, at, zoom } = painter;
  const { palette, view, cache } = frame;
  const buildingLabels = cache ? cache.placed : EMPTY_PLACED;
  const buildingCount = cache ? cache.placedCount : 0;
  const figureBoxes = cache ? cache.figureBoxes : UNCACHED_FIGURE_BOXES;
  const occluders = frame.occluders ?? NO_OCCLUDERS;
  const showLabels = zoom >= ROOM_LABEL_MIN_ZOOM;
  const labelHeight = (zoom < 0.5 ? 10 : 11) + 6;
  let figureCount = 0;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const figures = inhabitants.figures;
  for (let index = 0; index < figures.length; index++) {
    const figure = figures[index];
    const world = inhabitantPosition(figure, frame.time, INHABITANT_WORLD);
    const spot = at(world.x, world.y, INHABITANT_GLYPH_Z, INHABITANT_POINT);
    if (spot.x < -CULL_MARGIN || spot.x > view.width + CULL_MARGIN || spot.y < -CULL_MARGIN || spot.y > view.height + CULL_MARGIN) continue;
    const color = figure.online ? palette.cyan : palette.textMuted;
    if (figure.online) drawGlow(ctx, color, spot.x, spot.y, Math.max(2, 7 * zoom), 0.45);
    ctx.globalAlpha = figure.online ? 0.95 : 0.4;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(spot.x, spot.y, Math.max(1, INHABITANT_GLYPH_RADIUS * zoom), 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    if (!showLabels) continue;
    const entry = inhabitantLabelEntry(ctx, cache, figure);
    const box = rectSlot(figureBoxes, figureCount);
    if (!placeInhabitantBox(spot.x, spot.y - INHABITANT_LIFT, entry.width, labelHeight, buildingLabels, buildingCount, figureBoxes, figureCount, occluders, box)) continue;
    figureCount++;
    ctx.font = INHABITANT_FONT;
    ctx.globalAlpha = figure.online ? 0.92 : 0.55;
    ctx.fillStyle = palette.panel;
    ctx.beginPath(); ctx.roundRect(box.left, box.top, entry.width, labelHeight, 4); ctx.fill();
    ctx.globalAlpha = figure.online ? 0.85 : 0.4; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = figure.online ? palette.text : palette.textMuted;
    ctx.fillText(entry.text, box.left + entry.width / 2, (box.top + box.bottom) / 2 + 0.5);
  }
  if (inhabitants.overflow > 0) drawInhabitantOverflow(painter, inhabitants.overflow, buildingLabels, buildingCount, figureBoxes, figureCount, occluders);
}

/** "+N" beacon near the Pantheon for real agents beyond the cap; placed with the same collision system. */
function drawInhabitantOverflow(
  painter: Painter, overflow: number,
  buildingLabels: readonly PlacedLabel[], buildingCount: number,
  figureBoxes: readonly Rect[], figureCount: number, occluders: readonly Rect[],
) {
  const { ctx, frame, at } = painter;
  const pantheon = frame.scene.pantheon;
  if (!pantheon) return;
  const anchor = at(pantheon.x, pantheon.y, pantheon.height + OVERFLOW_LIFT, OVERFLOW_POINT);
  const { view } = frame;
  if (anchor.x < -CULL_MARGIN || anchor.x > view.width + CULL_MARGIN || anchor.y < -CULL_MARGIN || anchor.y > view.height + CULL_MARGIN) return;
  // Text and width are re-built only when N changes, not on every frame.
  const tag = frame.cache ? frame.cache.overflow : UNCACHED_OVERFLOW;
  if (tag.count !== overflow) {
    tag.count = overflow;
    tag.text = `+${overflow}`;
    ctx.font = INHABITANT_FONT;
    tag.width = ctx.measureText(tag.text).width + INHABITANT_LABEL_PADDING;
  }
  const { text, width } = tag;
  if (!placeInhabitantBox(anchor.x, anchor.y, width, INHABITANT_LABEL_HEIGHT, buildingLabels, buildingCount, figureBoxes, figureCount, occluders, INHABITANT_BOX)) return;
  const box = INHABITANT_BOX;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.95; ctx.fillStyle = frame.palette.panel;
  ctx.beginPath(); ctx.roundRect(box.left, box.top, width, INHABITANT_LABEL_HEIGHT, 5); ctx.fill();
  ctx.globalAlpha = 1; ctx.strokeStyle = frame.palette.gold; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.fillStyle = frame.palette.gold;
  ctx.fillText(text, box.left + width / 2, (box.top + box.bottom) / 2 + 0.5);
}
