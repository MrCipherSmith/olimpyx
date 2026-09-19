import { useEffect, useRef, type MutableRefObject } from 'react';
import { clampZoom, diveCamera, fitZoom, hitTest, isoProject, type Camera, type Viewport } from './isometricMath';
import { renderCity } from './cityRenderer';
import type { CityScene } from './cityScene';
import { CITY_MOTION, resolveCityPalette, type CityPalette } from './cityTokens';
import type { ArchetypeCategory } from './roomArchetypes';

/** Imperative camera controls used by the HUD buttons (keyboard-accessible alternatives to drag/wheel). */
export interface CityCameraController {
  zoomBy: (factor: number) => void;
  panBy: (dx: number, dy: number) => void;
  reset: () => void;
}

interface CityCanvasProps {
  scene: CityScene;
  selectedId: string | null;
  filter: ArchetypeCategory | 'all';
  label: string;
  reducedMotion: boolean;
  controller: MutableRefObject<CityCameraController | null>;
  onSelect: (id: string) => void;
}

const MAX_DPR = 2;
const DRAG_THRESHOLD = 5;

interface Animation { from: Camera; to: Camera; start: number; duration: number; }

/**
 * Owns the single requestAnimationFrame loop of the city. The loop runs only while motion is allowed, the
 * document is visible and the canvas intersects the viewport; with reduced motion frames are drawn on demand
 * and camera moves are instant. Everything is cancelled and unsubscribed on unmount.
 */
export function CityCanvas({ scene, selectedId, filter, label, reducedMotion, controller, onSelect }: CityCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const state = useRef({
    scene, selectedId, filter, reducedMotion, onSelect,
    hoveredId: null as string | null,
    camera: { focalX: 0, focalY: 0, zoom: 0.5 } as Camera,
    view: { width: 0, height: 0 } as Viewport,
    dpr: 1,
    fitted: false,
    animation: null as Animation | null,
    palette: null as CityPalette | null,
    frozenTime: 0,
    visible: true,
    onScreen: true,
    rafId: 0,
    requestFrame: () => {},
  });
  state.current.onSelect = onSelect;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const s = state.current;
    s.palette = resolveCityPalette(canvas);

    const animated = () => !s.reducedMotion;
    const shouldRun = () => s.visible && s.onScreen && s.view.width > 0;

    const draw = (now: number) => {
      s.rafId = 0;
      if (s.animation) {
        const progress = Math.min(1, (now - s.animation.start) / s.animation.duration);
        s.camera = diveCamera(s.animation.from, s.animation.to, progress);
        if (progress >= 1) s.animation = null;
      }
      if (animated()) s.frozenTime = now;
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      renderCity(ctx, {
        scene: s.scene, camera: s.camera, view: s.view, palette: s.palette!, time: s.frozenTime, animate: animated(),
        hoveredId: s.hoveredId, selectedId: s.selectedId, filter: s.filter,
        particles: animated() ? (s.view.width < 600 ? 4 : 12) : 0,
      });
      // Continuous loop only while something moves; otherwise wait for the next requestFrame().
      if ((animated() || s.animation) && shouldRun()) s.rafId = requestAnimationFrame(draw);
    };
    s.requestFrame = () => { if (!s.rafId && shouldRun()) s.rafId = requestAnimationFrame(draw); };
    const stop = () => { if (s.rafId) cancelAnimationFrame(s.rafId); s.rafId = 0; };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (!width || !height) return;
      s.dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      s.view = { width, height };
      canvas.width = Math.round(width * s.dpr);
      canvas.height = Math.round(height * s.dpr);
      if (!s.fitted) { s.camera = { focalX: 0, focalY: -20, zoom: fitZoom(s.scene.outerRadius, s.view) }; s.fitted = true; }
      stop(); s.requestFrame();
    };
    resize();
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    resizeObserver?.observe(canvas);
    const dprQuery = typeof window.matchMedia === 'function' ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null;
    dprQuery?.addEventListener?.('change', resize);

    const onVisibility = () => { s.visible = document.visibilityState !== 'hidden'; if (s.visible) s.requestFrame(); else stop(); };
    document.addEventListener('visibilitychange', onVisibility);
    const intersection = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(entries => { s.onScreen = entries.some(entry => entry.isIntersecting); if (s.onScreen) s.requestFrame(); else stop(); })
      : null;
    intersection?.observe(canvas);

    /* --- pointer: drag to pan, click to select, wheel to zoom --- */
    let drag: { id: number; x: number; y: number; moved: boolean } | null = null;
    const local = (event: { clientX: number; clientY: number }) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const pick = (x: number, y: number) => hitTest(s.scene.buildings, x, y, s.camera, s.view);
    const onPointerDown = (event: PointerEvent) => { drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }; canvas.setPointerCapture?.(event.pointerId); };
    const onPointerMove = (event: PointerEvent) => {
      if (drag && drag.id === event.pointerId) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (drag.moved || Math.hypot(dx, dy) > DRAG_THRESHOLD) {
          drag.moved = true; drag.x = event.clientX; drag.y = event.clientY;
          s.animation = null;
          s.camera = { ...s.camera, focalX: s.camera.focalX - dx / s.camera.zoom, focalY: s.camera.focalY - dy / s.camera.zoom };
          s.requestFrame();
        }
        return;
      }
      const point = local(event);
      const hovered = pick(point.x, point.y)?.id ?? null;
      if (hovered !== s.hoveredId) { s.hoveredId = hovered; canvas.style.cursor = hovered ? 'pointer' : 'grab'; s.requestFrame(); }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const wasDrag = drag.moved;
      drag = null;
      canvas.releasePointerCapture?.(event.pointerId);
      if (wasDrag) return;
      const point = local(event);
      const hit = pick(point.x, point.y);
      if (hit) s.onSelect(hit.id);
    };
    const onPointerLeave = () => { if (s.hoveredId) { s.hoveredId = null; s.requestFrame(); } };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      s.animation = null;
      s.camera = { ...s.camera, zoom: clampZoom(s.camera.zoom * Math.exp(-event.deltaY * 0.0015)) };
      s.requestFrame();
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const moveTo = (target: Camera) => {
      if (s.reducedMotion) { s.animation = null; s.camera = target; }
      else s.animation = { from: s.camera, to: target, start: performance.now(), duration: CITY_MOTION.diveMs };
      s.requestFrame();
    };
    controller.current = {
      zoomBy: factor => moveTo({ ...(s.animation?.to ?? s.camera), zoom: clampZoom((s.animation?.to ?? s.camera).zoom * factor) }),
      panBy: (dx, dy) => { const base = s.animation?.to ?? s.camera; moveTo({ ...base, focalX: base.focalX + dx / base.zoom, focalY: base.focalY + dy / base.zoom }); },
      reset: () => moveTo({ focalX: 0, focalY: -20, zoom: fitZoom(s.scene.outerRadius, s.view) }),
    };

    return () => {
      stop();
      s.requestFrame = () => {};
      resizeObserver?.disconnect();
      dprQuery?.removeEventListener?.('change', resize);
      intersection?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      controller.current = null;
    };
  }, [controller]);

  // Scene, filter or motion preference changed: redraw (and restart the loop if motion is now allowed).
  useEffect(() => {
    const s = state.current;
    const sceneChanged = s.scene !== scene;
    s.scene = scene; s.filter = filter; s.reducedMotion = reducedMotion;
    if (sceneChanged && !s.selectedId) s.camera = { ...s.camera, zoom: s.view.width ? fitZoom(scene.outerRadius, s.view) : s.camera.zoom };
    if (reducedMotion && s.animation) { s.camera = s.animation.to; s.animation = null; }
    s.requestFrame();
  }, [scene, filter, reducedMotion]);

  // Selection: two-phase dive (glide, then zoom) to the building; instant under reduced motion.
  useEffect(() => {
    const s = state.current;
    s.selectedId = selectedId;
    const building = selectedId ? s.scene.buildings.find(item => item.id === selectedId) : null;
    if (building) {
      const iso = isoProject(building.x, building.y, building.height / 2);
      const target: Camera = { focalX: iso.x, focalY: iso.y, zoom: clampZoom(Math.max(s.camera.zoom, 1.15)) };
      if (s.reducedMotion) { s.animation = null; s.camera = target; }
      else s.animation = { from: s.camera, to: target, start: performance.now(), duration: CITY_MOTION.diveMs };
    }
    s.requestFrame();
  }, [selectedId]);

  return <canvas ref={canvasRef} className="city-canvas" role="img" aria-label={label} />;
}
