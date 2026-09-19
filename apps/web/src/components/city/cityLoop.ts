/**
 * Frame pacing for the city render loop. Purely decorative motion (drones, pulses, rotating rings) is
 * capped at ~30 fps; camera dives, drags and on-demand redraws (hover, selection, resize) always draw.
 */
export const DECORATIVE_FRAME_MS = 33;

export interface FrameGate {
  now: number;
  lastDraw: number;
  /** Something other than the decorative clock changed since the last drawn frame. */
  dirty: boolean;
  animating: boolean;
  dragging: boolean;
}

export function shouldSkipFrame({ now, lastDraw, dirty, animating, dragging }: FrameGate): boolean {
  if (dirty || animating || dragging) return false;
  return now - lastDraw < DECORATIVE_FRAME_MS;
}
