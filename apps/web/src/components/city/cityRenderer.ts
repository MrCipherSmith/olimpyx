/**
 * Canvas 2D renderer for the Cyber-Polis (PROMPT §3). Stateless: every frame is drawn from the scene,
 * the camera and the resolved design-token palette. Building labels are room titles written by agents
 * (untrusted), so they are only ever drawn with fillText, never interpreted.
 */
import { COS30, SIN30, painterSort, worldToScreen, type Camera, type Point, type Viewport } from './isometricMath';
import { matchesFilter, type CityBuilding, type CityScene } from './cityScene';
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
}

type Ctx = CanvasRenderingContext2D;

interface Painter {
  ctx: Ctx;
  frame: RenderFrame;
  at: (x: number, y: number, z: number) => Point;
  zoom: number;
}

const ISO_RX = Math.SQRT2 * COS30; // screen x-radius of a world circle of radius 1
const ISO_RY = Math.SQRT2 * SIN30; // screen y-radius of a world circle of radius 1

export function renderCity(ctx: Ctx, frame: RenderFrame): void {
  const { view, camera, palette } = frame;
  const painter: Painter = { ctx, frame, zoom: camera.zoom, at: (x, y, z) => worldToScreen(x, y, z, camera, view) };
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.ground;
  ctx.fillRect(0, 0, view.width, view.height);
  drawAtmosphere(painter);
  drawRoads(painter);
  if (frame.animate && frame.particles > 0) drawPulses(painter);
  for (const building of painterSort(frame.scene.buildings)) drawBuilding(painter, building);
  if (frame.animate && frame.particles > 0) drawDrones(painter);
  drawLabels(painter);
  ctx.restore();
}

/** Static single-building render used by the archetype preview in the create-room dialog. */
export function renderBuildingPreview(ctx: Ctx, building: CityBuilding, view: Viewport, palette: CityPalette): void {
  const zoom = Math.min(view.width / 190, view.height / 200);
  const camera: Camera = { focalX: 0, focalY: -building.height * 0.45 - 10, zoom };
  const frame: RenderFrame = { scene: { buildings: [building], rings: [], forumRadius: 0, outerRadius: 0 }, camera, view, palette, time: 0, animate: false, hoveredId: null, selectedId: null, filter: 'all', particles: 0 };
  const painter: Painter = { ctx, frame, zoom, at: (x, y, z) => worldToScreen(x - building.x, y - building.y, z, camera, view) };
  ctx.save();
  ctx.clearRect(0, 0, view.width, view.height);
  isoEllipse(ctx, painter.at(building.x, building.y, 0), building.size * 1.4, zoom);
  ctx.globalAlpha = 0.5; ctx.strokeStyle = palette[building.color]; ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  drawBuilding(painter, building);
  ctx.restore();
}

/* ------------------------------------------------------------------ ground */

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
  ctx.ellipse(centre.x, centre.y, Math.max(0.1, radius * ISO_RX * zoom), Math.max(0.1, radius * ISO_RY * zoom), 0, 0, Math.PI * 2);
}

function drawRoads(painter: Painter) {
  const { ctx, frame, at, zoom } = painter;
  const { palette, scene } = frame;
  const centre = at(0, 0, 0);
  const outer = scene.outerRadius + 140;

  // Radial avenues: four cardinal ones to the city edge plus one per room building.
  const avenues: Array<[number, number]> = [0, 1, 2, 3].map(index => [index * Math.PI / 2 + Math.PI / 4, outer]);
  for (const building of scene.buildings) if (building.angle !== null) avenues.push([building.angle, Math.hypot(building.x, building.y)]);
  for (const [angle, length] of avenues) {
    const from = at(Math.cos(angle) * scene.forumRadius, Math.sin(angle) * scene.forumRadius, 0);
    const to = at(Math.cos(angle) * length, Math.sin(angle) * length, 0);
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
  strokeLine(ctx, at(0, -150, 0), at(0, 150, 0), palette.gold, 0.35, Math.max(1, 6 * zoom));
  ctx.globalAlpha = 1;
}

function strokeLine(ctx: Ctx, from: Point, to: Point, color: string, alpha: number, width: number) {
  ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ decorative motion (not metrics) */

function drawPulses({ ctx, frame, at, zoom }: Painter) {
  const rooms = frame.scene.buildings.filter(building => building.angle !== null);
  const count = Math.min(rooms.length, frame.particles);
  ctx.fillStyle = frame.palette.cyan;
  for (let index = 0; index < count; index++) {
    const building = rooms[index];
    const length = Math.hypot(building.x, building.y);
    const progress = ((frame.time * 0.00012) + index * 0.37) % 1;
    const distance = frame.scene.forumRadius + (length - frame.scene.forumRadius) * progress;
    const point = at(Math.cos(building.angle!) * distance, Math.sin(building.angle!) * distance, 0);
    ctx.globalAlpha = 0.7 * Math.sin(progress * Math.PI);
    ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(1, 3 * zoom), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawDrones({ ctx, frame, at, zoom }: Painter) {
  const rings = frame.scene.rings.length ? frame.scene.rings : [frame.scene.forumRadius + 120];
  for (let index = 0; index < frame.particles; index++) {
    const radius = rings[index % rings.length] + ((index * 53) % 60) - 30;
    const speed = (index % 2 ? 1 : -1) * (0.00005 + (index % 5) * 0.000012);
    const color = index % 3 === 0 ? frame.palette.gold : frame.palette.cyan;
    for (let trail = 3; trail >= 0; trail--) {
      const angle = index * 2.399 + (frame.time - trail * 70) * speed;
      const point = at(Math.cos(angle) * radius, Math.sin(angle) * radius, 170 + Math.sin(frame.time * 0.001 + index) * 14);
      ctx.globalAlpha = trail === 0 ? 0.95 : 0.25 / trail;
      ctx.fillStyle = color;
      const size = Math.max(1.2, (trail === 0 ? 4 : 2.5) * zoom);
      ctx.beginPath(); ctx.moveTo(point.x, point.y - size); ctx.lineTo(point.x + size, point.y); ctx.lineTo(point.x, point.y + size); ctx.lineTo(point.x - size, point.y); ctx.closePath(); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ solids */

interface Style { color: string; fill: number; stroke: number; }

function face(ctx: Ctx, points: Point[], base: string, style: Style, shade: number) {
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.closePath();
  ctx.globalAlpha = 1; ctx.fillStyle = base; ctx.fill();
  ctx.globalAlpha = style.fill * shade; ctx.fillStyle = style.color; ctx.fill();
  ctx.globalAlpha = style.stroke; ctx.strokeStyle = style.color; ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Axis-aligned box: draws the two faces facing the viewer (+x, +y) and the top. */
function box(p: Painter, style: Style, x: number, y: number, z: number, hx: number, hy: number, h: number) {
  const { at, ctx, frame } = p;
  const top = z + h;
  face(ctx, [at(x + hx, y - hy, z), at(x + hx, y + hy, z), at(x + hx, y + hy, top), at(x + hx, y - hy, top)], frame.palette.panel, style, 0.55);
  face(ctx, [at(x - hx, y + hy, z), at(x + hx, y + hy, z), at(x + hx, y + hy, top), at(x - hx, y + hy, top)], frame.palette.panel, style, 0.8);
  face(ctx, [at(x - hx, y - hy, top), at(x + hx, y - hy, top), at(x + hx, y + hy, top), at(x - hx, y + hy, top)], frame.palette.raised, style, 1);
}

function cylinder(p: Painter, style: Style, x: number, y: number, z: number, r: number, h: number) {
  const { ctx, at, zoom, frame } = p;
  const bottom = at(x, y, z);
  const top = at(x, y, z + h);
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
  ctx.beginPath(); ctx.ellipse(top.x, top.y, rx, ry, 0, 0, Math.PI * 2);
  ctx.globalAlpha = 1; ctx.fillStyle = frame.palette.raised; ctx.fill();
  ctx.globalAlpha = style.fill; ctx.fillStyle = style.color; ctx.fill();
  ctx.globalAlpha = style.stroke; ctx.stroke();
  ctx.globalAlpha = 1;
}

function dome(p: Painter, style: Style, x: number, y: number, z: number, r: number, rise = 0.85) {
  const { ctx, at, zoom, frame } = p;
  const base = at(x, y, z);
  const rx = r * ISO_RX * zoom;
  ctx.beginPath();
  ctx.ellipse(base.x, base.y, rx, r * ISO_RY * zoom, 0, 0, Math.PI);
  ctx.ellipse(base.x, base.y, rx, r * rise * zoom * 1.1, 0, Math.PI, Math.PI * 2);
  ctx.closePath();
  ctx.globalAlpha = 1; ctx.fillStyle = frame.palette.raised; ctx.fill();
  ctx.globalAlpha = style.fill * 1.4; ctx.fillStyle = style.color; ctx.fill();
  ctx.globalAlpha = style.stroke; ctx.strokeStyle = style.color; ctx.stroke();
  ctx.globalAlpha = 1;
}

function prism(p: Painter, style: Style, x: number, y: number, z: number, r: number, h: number, sides: number, turn = 0) {
  const { at, ctx, frame } = p;
  const corners = Array.from({ length: sides }, (_, index) => turn + (index * 2 * Math.PI) / sides);
  // Side faces whose outward normal points towards the viewer (+x +y).
  corners.forEach((angle, index) => {
    const next = corners[(index + 1) % sides];
    const normal = (angle + next) / 2 + (index === sides - 1 ? Math.PI : 0);
    if (Math.cos(normal) + Math.sin(normal) <= 0) return;
    const a = [x + Math.cos(angle) * r, y + Math.sin(angle) * r] as const;
    const b = [x + Math.cos(next) * r, y + Math.sin(next) * r] as const;
    face(ctx, [at(a[0], a[1], z), at(b[0], b[1], z), at(b[0], b[1], z + h), at(a[0], a[1], z + h)], frame.palette.panel, style, 0.7);
  });
  face(ctx, corners.map(angle => at(x + Math.cos(angle) * r, y + Math.sin(angle) * r, z + h)), frame.palette.raised, style, 1);
}

function mast(p: Painter, color: string, x: number, y: number, z0: number, z1: number, width: number, alpha = 0.9) {
  strokeLine(p.ctx, p.at(x, y, z0), p.at(x, y, z1), color, alpha, Math.max(0.6, width * p.zoom));
}

function glowDot(p: Painter, color: string, point: Point, radius: number, alpha: number) {
  const { ctx } = p;
  ctx.save();
  ctx.shadowColor = color; ctx.shadowBlur = 12;
  ctx.globalAlpha = alpha; ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(1, radius * p.zoom), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------------------ buildings */

function drawBuilding(p: Painter, building: CityBuilding) {
  const { ctx, frame } = p;
  const active = building.id === frame.selectedId || building.id === frame.hoveredId;
  const visible = matchesFilter(building, frame.filter);
  const color = frame.palette[building.color];
  const style: Style = { color, fill: active ? 0.34 : 0.22, stroke: visible ? (active ? 1 : 0.8) : 0.3 };
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(0.7, (active ? 2.2 : 1.2) * p.zoom);
  if (!visible) ctx.globalAlpha = 0.25;
  if (building.id === frame.selectedId) {
    isoEllipse(ctx, p.at(building.x, building.y, 0), building.size * 1.35, p.zoom);
    ctx.globalAlpha = 0.9; ctx.strokeStyle = color; ctx.setLineDash([6 * p.zoom, 5 * p.zoom]); ctx.stroke(); ctx.setLineDash([]);
  }
  if (active) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
  // Filtered-out rooms are drawn as faint footprints only.
  if (!visible) { box(p, { color, fill: 0.08, stroke: 0.25 }, building.x, building.y, 0, building.size * 0.8, building.size * 0.8, 6); ctx.restore(); return; }
  SHAPES[building.shape](p, style, building);
  ctx.restore();
}

type ShapeDrawer = (p: Painter, style: Style, b: CityBuilding) => void;

const SHAPES: Record<CityBuilding['shape'], ShapeDrawer> = {
  library: drawLibrary,
  pantheon: drawPantheon,
  lab_observatory(p, s, { x, y }) {
    box(p, s, x, y, 0, 36, 36, 40);
    cylinder(p, s, x, y, 40, 22, 30);
    dome(p, s, x, y, 70, 22);
    const top = p.at(x, y, 108);
    const tilt = p.frame.time * 0.0006;
    p.ctx.globalAlpha = s.stroke; p.ctx.strokeStyle = s.color;
    p.ctx.beginPath(); p.ctx.ellipse(top.x, top.y, 16 * p.zoom, 6 * p.zoom, tilt, 0, Math.PI * 2); p.ctx.stroke();
    mast(p, s.color, x, y, 88, 108, 1.5);
  },
  archive_data_vault(p, s, { x, y }) {
    box(p, s, x, y, 0, 40, 40, 62);
    for (const z of [18, 44]) { isoEllipse(p.ctx, p.at(x, y, z), 60, p.zoom); p.ctx.globalAlpha = 0.6; p.ctx.strokeStyle = s.color; p.ctx.stroke(); }
    p.ctx.globalAlpha = 1;
  },
  crypto_proving_grounds(p, s, { x, y }) {
    prism(p, s, x, y, 0, 46, 14, 6, Math.PI / 6);
    for (let index = 0; index < 3; index++) {
      const angle = Math.PI / 6 + index * (2 * Math.PI / 3);
      box(p, s, x + Math.cos(angle) * 30, y + Math.sin(angle) * 30, 14, 5, 5, 44);
    }
    glowDot(p, s.color, p.at(x, y, 40), 5, 0.9);
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
    glowDot(p, s.color, p.at(x, y, 48), 4, 0.9);
  },
  tribunal_chamber(p, s, { x, y }) {
    box(p, s, x, y, 0, 44, 44, 14);
    box(p, s, x, y, 14, 32, 32, 14);
    box(p, s, x, y, 28, 20, 20, 32);
    strokeLine(p.ctx, p.at(x - 22, y + 22, 72), p.at(x + 22, y - 22, 72), s.color, 0.95, Math.max(1, 2 * p.zoom));
    mast(p, s.color, x, y, 60, 74, 2);
  },
  cyber_forge(p, s, { x, y }) {
    cylinder(p, s, x - 22, y - 14, 0, 8, 80);
    cylinder(p, s, x + 6, y - 22, 0, 8, 70);
    box(p, s, x, y + 6, 0, 44, 26, 44);
    const flicker = p.frame.animate ? 0.6 + 0.4 * Math.abs(Math.sin(p.frame.time * 0.004)) : 0.8;
    glowDot(p, s.color, p.at(x - 22, y - 14, 84), 4, flicker);
  },
  neural_matrix_spire(p, s, { x, y }) {
    box(p, s, x, y, 0, 30, 30, 44);
    box(p, s, x, y, 44, 21, 21, 40);
    box(p, s, x, y, 84, 12, 12, 36);
    mast(p, s.color, x, y, 120, 146, 1.5);
    glowDot(p, s.color, p.at(x, y, 148), 3, 0.9);
  },
  telemetry_beacon(p, s, { x, y }) {
    box(p, s, x, y, 0, 28, 28, 10);
    box(p, { ...s, fill: s.fill * 0.4 }, x, y, 10, 8, 8, 124);
    const pulse = p.frame.animate ? 0.5 + 0.5 * Math.abs(Math.sin(p.frame.time * 0.002)) : 0.9;
    glowDot(p, s.color, p.at(x, y, 140), 6, pulse);
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
    const eye = p.at(x, y, 100);
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

function drawLibrary(p: Painter, s: Style, { x, y }: CityBuilding) {
  const { ctx, frame, zoom } = p;
  box(p, s, x, y, 0, 46, 46, 14);
  box(p, s, x, y, 14, 30, 30, 24);
  // Rhombicuboctahedron seen corner-on: octagonal silhouette, a central square and the facets between them.
  const centre = p.at(x, y, 100);
  const radius = 52 * zoom;
  const outer = Array.from({ length: 8 }, (_, index) => { const angle = Math.PI / 8 + index * Math.PI / 4; return { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius * 0.92 }; });
  const inner = Array.from({ length: 4 }, (_, index) => { const angle = Math.PI / 4 + index * Math.PI / 2; return { x: centre.x + Math.cos(angle) * radius * 0.55, y: centre.y + Math.sin(angle) * radius * 0.5 }; });
  face(ctx, outer, frame.palette.raised, { ...s, fill: s.fill * 1.4 }, 1);
  ctx.globalAlpha = 0.75; ctx.strokeStyle = s.color;
  ctx.beginPath();
  inner.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath();
  inner.forEach((point, index) => { const a = outer[(index * 2 + 7) % 8]; const b = outer[index * 2]; const c = outer[index * 2 + 1]; ctx.moveTo(a.x, a.y); ctx.lineTo(point.x, point.y); ctx.lineTo(b.x, b.y); ctx.moveTo(point.x, point.y); ctx.lineTo(c.x, c.y); });
  ctx.stroke();
  glowDot(p, s.color, centre, 7, 0.9);
  // Holographic rings rotating around the core.
  const spin = frame.time * 0.0004;
  [[1.55, 0.38, 0.25], [1.35, 0.3, -0.45], [1.8, 0.22, 0.05]].forEach(([scale, squash, tilt], index) => {
    ctx.save();
    ctx.globalAlpha = 0.55 - index * 0.12; ctx.strokeStyle = s.color; ctx.lineWidth = Math.max(0.7, 1.4 * zoom);
    ctx.setLineDash([14 * zoom, 8 * zoom]); ctx.lineDashOffset = -spin * 400 * (index % 2 ? -1 : 1);
    ctx.beginPath(); ctx.ellipse(centre.x, centre.y, radius * scale, radius * scale * squash, tilt + Math.sin(spin + index) * 0.08, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  });
}

function drawPantheon(p: Painter, s: Style, { x, y }: CityBuilding) {
  const { ctx, frame, zoom } = p;
  const gold = frame.palette.gold;
  const columns = Array.from({ length: 16 }, (_, index) => (index * Math.PI) / 8);
  const columnRadius = 42;
  const baseZ = 16;
  const topZ = 70;
  // Stylobate.
  box(p, s, x, y, 0, 60, 60, 8);
  box(p, s, x, y, 8, 52, 52, 8);
  const drawColumns = (front: boolean) => columns.forEach(angle => {
    const isFront = Math.cos(angle) + Math.sin(angle) > 0;
    if (isFront !== front) return;
    const cx = x + Math.cos(angle) * columnRadius;
    const cy = y + Math.sin(angle) * columnRadius;
    strokeLine(ctx, p.at(cx, cy, baseZ), p.at(cx, cy, topZ), gold, front ? 0.95 : 0.5, Math.max(1, 4 * zoom));
  });
  drawColumns(false);
  cylinder(p, { ...s, fill: s.fill * 0.6 }, x, y, baseZ, 32, topZ - baseZ);
  drawColumns(true);
  // Entablature ring, golden dome and oculus.
  isoEllipse(ctx, p.at(x, y, topZ), columnRadius + 5, zoom);
  ctx.globalAlpha = 0.9; ctx.strokeStyle = gold; ctx.lineWidth = Math.max(1, 3 * zoom); ctx.stroke(); ctx.globalAlpha = 1;
  dome(p, { color: gold, fill: 0.32, stroke: 0.95 }, x, y, topZ, 40, 0.8);
  const oculus = p.at(x, y, topZ + 40 * 0.8 * 1.1);
  ctx.beginPath(); ctx.ellipse(oculus.x, oculus.y, 7 * zoom, 3 * zoom, 0, 0, Math.PI * 2);
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

export function truncateLabel(text: string, max = 26): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function drawLabels(p: Painter) {
  const { ctx, frame, zoom } = p;
  const showRoomLabels = zoom >= 0.32;
  const fontSize = zoom < 0.5 ? 11 : 12;
  ctx.font = `600 ${fontSize}px "Space Grotesk", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const building of painterSort(frame.scene.buildings)) {
    const active = building.id === frame.selectedId || building.id === frame.hoveredId;
    if (!matchesFilter(building, frame.filter)) continue;
    if (building.kind === 'room' && !showRoomLabels && !active) continue;
    const anchor = p.at(building.x, building.y, building.height + 26);
    const text = truncateLabel(building.label);
    const width = ctx.measureText(text).width + 14;
    const height = fontSize + 8;
    ctx.globalAlpha = active ? 0.95 : 0.78;
    ctx.fillStyle = frame.palette.panel;
    ctx.beginPath(); ctx.roundRect(anchor.x - width / 2, anchor.y - height / 2, width, height, 5); ctx.fill();
    ctx.strokeStyle = frame.palette[building.color]; ctx.lineWidth = 1; ctx.globalAlpha = active ? 1 : 0.55; ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = active ? frame.palette.text : frame.palette.textMuted;
    ctx.fillText(text, anchor.x, anchor.y + 0.5);
  }
}
