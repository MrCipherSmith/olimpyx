/**
 * Pure camera helpers for the City Shell (PROMPT §2, §4): the HUD-safe scene fit and the camera moves of
 * the dive / back transition. No DOM access here; CityCanvas measures and feeds the rectangles.
 */
import { easeInOut, fitZoom, isoProject, type Camera, type ScreenBox, type Viewport } from './isometricMath';

/** Zoom while the target lock frames the building (focus phase) and at the end of the dive. */
export const FOCUS_ZOOM = 1.65;
export const DIVE_ZOOM = 6.5;
/** Iso-space point the whole-city view looks at (a little above the forum, for the tall landmarks). */
export const CITY_FOCAL = { x: 0, y: -20 } as const;
/** Breathing room between the scene and a HUD panel, in CSS pixels. */
export const HUD_SAFE_MARGIN = 12;

/** A world point the camera dives into: the building footprint centre and a height on it (its roof area). */
export interface DivePoint { x: number; y: number; z: number; }

/**
 * Camera moves of the dive state machine (components/shell/diveMachine.ts), executed by CityCanvas:
 * - `focus`: remember the current view, then glide to the point at FOCUS_ZOOM;
 * - `dive`: zoom to DIVE_ZOOM on the same point (accelerating);
 * - `hold`: a screen opened without a dive (deep link, reduced motion): remember the view, move nothing;
 * - `cover`: under the exit overlay, stand at the point at DIVE_ZOOM so the return zooms out of the building;
 * - `return`: back to the remembered view (or the HUD-safe fit); `ms: 0` jumps there.
 */
export type DiveCameraMove =
  | { kind: 'focus'; point: DivePoint; ms: number }
  | { kind: 'dive'; point: DivePoint; ms: number }
  | { kind: 'hold' }
  | { kind: 'cover'; point: DivePoint | null }
  | { kind: 'return'; ms: number };

export function divePointCamera(point: DivePoint, zoom: number): Camera {
  const iso = isoProject(point.x, point.y, point.z);
  return { focalX: iso.x, focalY: iso.y, zoom };
}

/** Ease-in cubic: the dive accelerates into the roof. */
export function easeIn(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped ** 3;
}

/**
 * Interpolates two cameras. The zoom is interpolated in log space, so a 0.5 → 6.5 dive (or back) feels
 * uniform instead of rushing through the first half; the focal point moves with the same eased progress.
 */
export function lerpCamera(from: Camera, to: Camera, t: number, ease: (t: number) => number = easeInOut): Camera {
  const k = ease(t);
  const zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * k);
  return { focalX: from.focalX + (to.focalX - from.focalX) * k, focalY: from.focalY + (to.focalY - from.focalY) * k, zoom };
}

/* ------------------------------------------------------------------ HUD occluders */

export interface ClientRectLike { left: number; top: number; right: number; bottom: number; width: number; height: number; }

/**
 * HUD panel rectangles (client coordinates) → occluders in canvas CSS pixels, clipped to the canvas.
 * Panels outside the canvas (the stacked ≤ 900px layout) and hidden ones (zero size) are dropped.
 */
export function occludersFrom(canvas: ClientRectLike, panels: readonly ClientRectLike[]): ScreenBox[] {
  const result: ScreenBox[] = [];
  for (const panel of panels) {
    if (panel.width <= 0 || panel.height <= 0) continue;
    const box = {
      left: Math.max(0, panel.left - canvas.left),
      top: Math.max(0, panel.top - canvas.top),
      right: Math.min(canvas.width, panel.right - canvas.left),
      bottom: Math.min(canvas.height, panel.bottom - canvas.top),
    };
    if (box.right > box.left && box.bottom > box.top) result.push(box);
  }
  return result;
}

const overlaps = (a: ScreenBox, b: ScreenBox) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * The free rectangle of the viewport the whole city should fit into: the largest-zoom axis-aligned
 * rectangle that touches no occluder (grown by `margin`). With a handful of HUD panels a brute-force
 * search over the panel edges is exact and cheap. Falls back to the whole viewport when the panels leave
 * too little room (e.g. a tiny window), so the city never collapses to a sliver.
 */
export function freeRect(view: Viewport, occluders: readonly ScreenBox[], radius: number, margin = HUD_SAFE_MARGIN): ScreenBox {
  const whole: ScreenBox = { left: 0, top: 0, right: view.width, bottom: view.height };
  if (!occluders.length || view.width <= 0 || view.height <= 0) return whole;
  const grown = occluders.map(box => ({ left: box.left - margin, top: box.top - margin, right: box.right + margin, bottom: box.bottom + margin }));
  const lefts = [0, ...grown.map(box => box.right)].filter(x => x >= 0 && x < view.width);
  const rights = [view.width, ...grown.map(box => box.left)].filter(x => x > 0 && x <= view.width);
  const tops = [0, ...grown.map(box => box.bottom)].filter(y => y >= 0 && y < view.height);
  const bottoms = [view.height, ...grown.map(box => box.top)].filter(y => y > 0 && y <= view.height);
  let best: ScreenBox | null = null;
  let bestZoom = 0;
  let bestArea = 0;
  for (const left of lefts) for (const right of rights) {
    if (right - left < view.width * 0.35) continue;
    for (const top of tops) for (const bottom of bottoms) {
      if (bottom - top < view.height * 0.35) continue;
      const candidate = { left, top, right, bottom };
      if (grown.some(box => overlaps(candidate, box))) continue;
      const zoom = fitZoom(radius, { width: right - left, height: bottom - top });
      const area = (right - left) * (bottom - top);
      if (zoom > bestZoom + 1e-9 || (Math.abs(zoom - bestZoom) <= 1e-9 && area > bestArea)) { best = candidate; bestZoom = zoom; bestArea = area; }
    }
  }
  return best ?? whole;
}

/**
 * The whole-city camera: the scene disc of `radius` fitted into the part of the viewport no HUD panel
 * covers, centred in that free rectangle rather than in the viewport.
 */
export function hudSafeFit(radius: number, view: Viewport, occluders: readonly ScreenBox[] = [], margin = HUD_SAFE_MARGIN): Camera {
  const area = freeRect(view, occluders, radius, margin);
  const zoom = fitZoom(radius, { width: area.right - area.left, height: area.bottom - area.top });
  const centreX = (area.left + area.right) / 2;
  const centreY = (area.top + area.bottom) / 2;
  // screen = view/2 + (iso − focal)·zoom  ⇒  focal = iso − (screen − view/2)/zoom
  return { focalX: CITY_FOCAL.x - (centreX - view.width / 2) / zoom, focalY: CITY_FOCAL.y - (centreY - view.height / 2) / zoom, zoom };
}
