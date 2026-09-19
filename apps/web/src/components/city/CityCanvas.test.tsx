import { act, cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CityCameraController } from './CityCanvas';
import { CityView } from './CityView';
import { DIVE_ZOOM, FOCUS_ZOOM, divePointCamera, hudSafeFit } from './cameraMath';
import { buildCityScene } from './cityScene';
import type { RenderFrame } from './cityRenderer';

const frames: Array<RenderFrame & { occluders?: unknown }> = [];
vi.mock('./cityRenderer', async importOriginal => ({
  ...(await importOriginal<typeof import('./cityRenderer')>()),
  renderCity: (_ctx: unknown, frame: RenderFrame) => { frames.push({ ...frame, camera: { ...frame.camera } }); },
}));

const rooms = [{ room_id: 'r1', title: 'Signal Lab' }];
const scene = buildCityScene(rooms);
const CANVAS = { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 };
const PANELS: Record<string, { left: number; top: number; width: number; height: number }> = {
  'hud-legend': { left: 20, top: 834, width: 240, height: 46 },
  'hud-directory': { left: 1130, top: 20, width: 290, height: 670 },
  'city-camera': { left: 1292, top: 710, width: 128, height: 170 },
};

let rafCallbacks: FrameRequestCallback[] = [];
const flush = (at = performance.now() + 10_000) => act(() => { rafCallbacks.splice(0).forEach(callback => callback(at)); });
const lastCamera = () => frames.at(-1)!.camera;

beforeEach(() => {
  frames.length = 0;
  rafCallbacks = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ setTransform: vi.fn() }) as never);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { rafCallbacks.push(callback); return rafCallbacks.length; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const key = Object.keys(PANELS).find(name => this.classList.contains(name));
    const box = key ? PANELS[key] : this instanceof HTMLCanvasElement ? CANVAS : { left: 0, top: 0, width: 0, height: 0 };
    return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function renderCity() {
  const camera = createRef<CityCameraController>() as { current: CityCameraController | null };
  render(<CityView rooms={rooms} scene={scene} camera={camera} mode="participant" onNavigate={vi.fn()} />);
  flush();
  return camera.current!;
}

describe('CityCanvas camera', () => {
  it('fits the city into the area the HUD panels leave free and hands the panels to the renderer', () => {
    const camera = renderCity();
    expect(camera.canAnimate()).toBe(true);
    const frame = frames.at(-1)!;
    expect(frame.occluders).toEqual([
      { left: 20, top: 834, right: 260, bottom: 880 },
      { left: 1130, top: 20, right: 1420, bottom: 690 },
      { left: 1292, top: 710, right: 1420, bottom: 880 },
    ]);
    expect(frame.camera).toEqual(hudSafeFit(scene.outerRadius, { width: 1440, height: 900 }, frame.occluders as never));
  });

  it('runs the dive moves, locks user camera input meanwhile, and returns to the previous view', () => {
    const camera = renderCity();
    camera.zoomBy(1.25);
    flush();
    const before = lastCamera();
    const point = { x: scene.buildings[0].x, y: scene.buildings[0].y, z: 75 };

    act(() => camera.dive({ kind: 'focus', point, ms: 650 }));
    camera.panBy(500, 0); // ignored while the dive owns the camera
    flush();
    expect(lastCamera()).toEqual(divePointCamera(point, FOCUS_ZOOM));
    expect(frames.at(-1)!.cameraMoving).toBe(false); // the animation has finished at this timestamp

    act(() => camera.dive({ kind: 'dive', point, ms: 550 }));
    flush(performance.now() + 275); // half-way: moving, the static layer is bypassed
    expect(frames.at(-1)!.cameraMoving).toBe(true);
    expect(lastCamera().zoom).toBeGreaterThan(FOCUS_ZOOM);
    expect(lastCamera().zoom).toBeLessThan(DIVE_ZOOM);
    flush();
    expect(lastCamera()).toEqual(divePointCamera(point, DIVE_ZOOM));

    act(() => camera.dive({ kind: 'return', ms: 650 }));
    flush();
    expect(lastCamera()).toEqual(before);
  });

  it('returns to a fresh HUD-safe fit when the view before the dive was the fit', () => {
    const camera = renderCity();
    const fitted = lastCamera();
    act(() => camera.dive({ kind: 'hold' }));
    act(() => camera.dive({ kind: 'cover', point: { x: 0, y: 0, z: 0 } }));
    flush();
    expect(lastCamera().zoom).toBe(DIVE_ZOOM);
    act(() => camera.dive({ kind: 'return', ms: 0 }));
    flush();
    expect(lastCamera()).toEqual(fitted);
  });
});
