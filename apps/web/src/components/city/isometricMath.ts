/**
 * Pure isometric math for the city (PROMPT §3.А). World coordinates are city-plane pixels (x, y) with
 * height z; the 30° projection is isoX = (x − y)·cos(π/6), isoY = (x + y)·sin(π/6) − z.
 * The camera looks at an iso-space focal point with a zoom factor; screen = centre + (iso − focal)·zoom.
 */

export const COS30 = Math.cos(Math.PI / 6);
export const SIN30 = Math.sin(Math.PI / 6);

export interface Camera { focalX: number; focalY: number; zoom: number; }
export interface Viewport { width: number; height: number; }
export interface Point { x: number; y: number; }

export function isoProject(x: number, y: number, z = 0): Point {
  return { x: (x - y) * COS30, y: (x + y) * SIN30 - z };
}

export function worldToScreen(x: number, y: number, z: number, camera: Camera, view: Viewport): Point {
  const iso = isoProject(x, y, z);
  return { x: view.width / 2 + (iso.x - camera.focalX) * camera.zoom, y: view.height / 2 + (iso.y - camera.focalY) * camera.zoom };
}

/** Inverse projection onto the ground plane (z = 0), accounting for the camera focal offset and zoom. */
export function screenToWorld(sx: number, sy: number, camera: Camera, view: Viewport): Point {
  const isoX = (sx - view.width / 2) / camera.zoom + camera.focalX;
  const isoY = (sy - view.height / 2) / camera.zoom + camera.focalY;
  const diff = isoX / COS30; // x − y
  const sum = isoY / SIN30;  // x + y
  return { x: (sum + diff) / 2, y: (sum - diff) / 2 };
}

/** Painter's algorithm: far objects (smaller x + y) first, near ones last. Stable for ties. Returns a new array. */
export function painterSort<T extends { x: number; y: number }>(items: readonly T[]): T[] {
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.x + a.item.y) - (b.item.x + b.item.y) || a.index - b.index)
    .map(entry => entry.item);
}

/* ---------------------------------------------------------------- ring layout (PROMPT §3.Б) */

export const RING_BASE_RADIUS = 520;
export const RING_RADIUS_STEP = 260;
export const RING_BASE_CAPACITY = 6;
export const RING_CAPACITY_STEP = 4;
/** World angle of the first slot of every ring. */
export const RING_START_ANGLE = -Math.PI / 2;

/** Ring i: R = 520 + 260·i, capacity 6 + 4·i → R0 520/6, R1 780/10, R2 1040/14, and further rings with the same step. */
export function ringSpec(index: number): { radius: number; capacity: number } {
  return { radius: RING_BASE_RADIUS + RING_RADIUS_STEP * index, capacity: RING_BASE_CAPACITY + RING_CAPACITY_STEP * index };
}

export interface RingSlot { ring: number; slot: number; count: number; radius: number; angle: number; x: number; y: number; }

/**
 * Places `count` items on concentric rings in order. Strategy for more than 30 rooms (6 + 10 + 14):
 * extra rings continue with the same radius step (+260) and capacity step (+4), so every room keeps a
 * building and nothing is hidden. Within ring i with n items, item j sits at
 * θ = start + 2π·j/n + i·π/n — each ring is phase-shifted by half a slot (π/n) relative to the previous
 * one, so neighbouring rings do not line their buildings and labels up on the same avenue.
 */
export function layoutRings(count: number): RingSlot[] {
  const slots: RingSlot[] = [];
  let placed = 0;
  for (let ring = 0; placed < count; ring++) {
    const { radius, capacity } = ringSpec(ring);
    const n = Math.min(capacity, count - placed);
    for (let slot = 0; slot < n; slot++) {
      const angle = RING_START_ANGLE + (2 * Math.PI * slot) / n + (ring * Math.PI) / n;
      slots.push({ ring, slot, count: n, radius, angle, x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }
    placed += n;
  }
  return slots;
}

export function ringCountFor(count: number): number {
  return count <= 0 ? 0 : layoutRings(count).at(-1)!.ring + 1;
}

/* ---------------------------------------------------------------- camera helpers */

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 2.5;

export function clampZoom(zoom: number): number { return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)); }

/** Zoom at which a disc of world radius `radius` (plus building height headroom) fits the viewport. */
export function fitZoom(radius: number, view: Viewport, headroom = 220): number {
  const halfWidth = radius * Math.SQRT2 * COS30; // max |isoX| over the circle
  const halfHeight = radius * Math.SQRT2 * SIN30 + headroom / 2; // max |isoY| plus buildings rising above
  if (view.width <= 0 || view.height <= 0) return 1;
  return clampZoom(Math.min(view.width / (2 * halfWidth), view.height / (2 * halfHeight)) * 0.96);
}

/** Ease-in-out cubic on [0, 1]. */
export function easeInOut(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped < 0.5 ? 4 * clamped ** 3 : 1 - (-2 * clamped + 2) ** 3 / 2;
}

/**
 * Two-phase "dive" towards a target: phase 1 (first half) glides the focal point to the target at the
 * start zoom, phase 2 zooms in on the already centred target. Monotonic, so there is no overshoot or return.
 */
export function diveCamera(from: Camera, to: Camera, t: number): Camera {
  const pan = easeInOut(t / 0.5);
  const zoom = easeInOut((t - 0.5) / 0.5);
  return {
    focalX: from.focalX + (to.focalX - from.focalX) * pan,
    focalY: from.focalY + (to.focalY - from.focalY) * pan,
    zoom: from.zoom + (to.zoom - from.zoom) * zoom,
  };
}

/** Frontmost item whose screen box contains the point (painter order: the last drawn wins). */
export function hitTest<T extends { x: number; y: number; size: number; height: number }>(items: readonly T[], sx: number, sy: number, camera: Camera, view: Viewport): T | null {
  let hit: T | null = null;
  for (const item of painterSort(items)) {
    const base = worldToScreen(item.x, item.y, 0, camera, view);
    const halfWidth = item.size * COS30 * camera.zoom;
    const halfDepth = item.size * SIN30 * camera.zoom;
    const top = base.y - (item.height * camera.zoom + halfDepth);
    if (sx >= base.x - halfWidth && sx <= base.x + halfWidth && sy >= top && sy <= base.y + halfDepth) hit = item;
  }
  return hit;
}
