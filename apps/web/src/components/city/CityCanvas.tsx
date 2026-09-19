import { useEffect, useRef, type MutableRefObject } from 'react';
import { clampZoom, diveCamera, fitZoom, hitTest, isoProject, shouldRefitZoom, type Camera, type Viewport } from './isometricMath';
import { createRenderCache, renderCity } from './cityRenderer';
import { shouldSkipFrame } from './cityLoop';
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
  /** Stop the loop while a screen layer covers the whole city; resume with one fresh frame. */
  paused?: boolean;
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
export function CityCanvas({ scene, selectedId, filter, label, reducedMotion, paused = false, controller, onSelect }: CityCanvasProps) {
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
    cache: createRenderCache(),
    frozenTime: 0,
    lastDraw: -Infinity,
    /** Set by requestFrame(): the next frame must draw even inside the decorative 30 fps window. */
    dirty: true,
    dragging: false,
    visible: true,
    onScreen: true,
    paused,
    rafId: 0,
    requestFrame: () => {},
    stop: () => {},
  });
  state.current.onSelect = onSelect;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const s = state.current;
    s.palette = resolveCityPalette(canvas);

    const animated = () => !s.reducedMotion;
    const shouldRun = () => s.visible && s.onScreen && !s.paused && s.view.width > 0;

    const draw = (now: number) => {
      s.rafId = 0;
      if (shouldSkipFrame({ now, lastDraw: s.lastDraw, dirty: s.dirty, animating: s.animation !== null, dragging: s.dragging })) {
        if (animated() && shouldRun()) s.rafId = requestAnimationFrame(draw);
        return;
      }
      s.dirty = false;
      s.lastDraw = now;
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
        dpr: s.dpr, cache: s.cache,
        // A camera dive (s.animation) or an active drag changes the camera every frame; bypass the
        // static-layer cache for those (see RenderFrame.cameraMoving) instead of rebuilding + blitting
        // it on every single frame.
        cameraMoving: s.animation !== null || s.dragging,
      });
      // Continuous loop only while something moves; otherwise wait for the next requestFrame().
      if ((animated() || s.animation) && shouldRun()) s.rafId = requestAnimationFrame(draw);
    };
    s.requestFrame = () => { s.dirty = true; if (!s.rafId && shouldRun()) s.rafId = requestAnimationFrame(draw); };
    const stop = () => { if (s.rafId) cancelAnimationFrame(s.rafId); s.rafId = 0; };
    s.stop = stop;

    /** Applies a CSS size; the backing store is only rewritten when the size or the DPR actually changed. */
    const applySize = (cssWidth: number, cssHeight: number) => {
      const width = Math.round(cssWidth);
      const height = Math.round(cssHeight);
      if (!width || !height) return;
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      if (width === s.view.width && height === s.view.height && dpr === s.dpr) return;
      s.dpr = dpr;
      s.view = { width, height };
      const backingWidth = Math.round(width * dpr);
      const backingHeight = Math.round(height * dpr);
      if (canvas.width !== backingWidth) canvas.width = backingWidth;
      if (canvas.height !== backingHeight) canvas.height = backingHeight;
      if (!s.fitted) { s.camera = { focalX: 0, focalY: -20, zoom: fitZoom(s.scene.outerRadius, s.view) }; s.fitted = true; }
      stop(); s.requestFrame();
    };
    const initial = canvas.getBoundingClientRect();
    applySize(initial.width, initial.height);
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(entries => { const entry = entries[entries.length - 1]; if (entry) applySize(entry.contentRect.width, entry.contentRect.height); })
      : null;
    resizeObserver?.observe(canvas);

    // A `(resolution: Ndppx)` query only fires once, when leaving N: re-create it for the new ratio each time.
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = () => { watchDpr(); applySize(s.view.width, s.view.height); };
    const watchDpr = () => {
      dprQuery?.removeEventListener?.('change', onDprChange);
      dprQuery = typeof window.matchMedia === 'function' ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null;
      dprQuery?.addEventListener?.('change', onDprChange);
    };
    watchDpr();

    // Label widths are measured once per building; re-measure after the display font finishes loading.
    const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
    const onFontsLoaded = () => { s.cache.labels.clear(); s.requestFrame(); };
    fonts?.addEventListener?.('loadingdone', onFontsLoaded);

    const onVisibility = () => { s.visible = document.visibilityState !== 'hidden'; if (s.visible) s.requestFrame(); else stop(); };
    document.addEventListener('visibilitychange', onVisibility);
    const intersection = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(entries => { s.onScreen = entries.some(entry => entry.isIntersecting); if (s.onScreen) s.requestFrame(); else stop(); })
      : null;
    intersection?.observe(canvas);

    /* --- pointer: drag to pan, click to select, wheel to zoom --- */
    let drag: { id: number; x: number; y: number; moved: boolean } | null = null;
    // offsetX/Y are relative to the canvas padding edge: no layout read (getBoundingClientRect) per move.
    const pick = (event: PointerEvent) => hitTest(s.scene.drawOrder, event.offsetX, event.offsetY, s.camera, s.view);
    const onPointerDown = (event: PointerEvent) => { drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }; canvas.setPointerCapture?.(event.pointerId); };
    const onPointerMove = (event: PointerEvent) => {
      if (drag && drag.id === event.pointerId) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (drag.moved || Math.hypot(dx, dy) > DRAG_THRESHOLD) {
          drag.moved = true; drag.x = event.clientX; drag.y = event.clientY;
          s.dragging = true;
          s.animation = null;
          s.camera = { ...s.camera, focalX: s.camera.focalX - dx / s.camera.zoom, focalY: s.camera.focalY - dy / s.camera.zoom };
          s.requestFrame();
        }
        return;
      }
      const hovered = pick(event)?.id ?? null;
      if (hovered !== s.hoveredId) { s.hoveredId = hovered; canvas.style.cursor = hovered ? 'pointer' : 'grab'; s.requestFrame(); }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const wasDrag = drag.moved;
      drag = null;
      s.dragging = false;
      canvas.releasePointerCapture?.(event.pointerId);
      if (wasDrag) return;
      const hit = pick(event);
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
      s.stop = () => {};
      s.dragging = false;
      resizeObserver?.disconnect();
      dprQuery?.removeEventListener?.('change', onDprChange);
      fonts?.removeEventListener?.('loadingdone', onFontsLoaded);
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
    const previous = s.scene;
    const sceneChanged = previous !== scene;
    s.scene = scene; s.filter = filter; s.reducedMotion = reducedMotion;
    if (sceneChanged) s.cache.labels.clear();
    // Polling hands us a new rooms array (and scene) often; only a changed footprint re-fits the zoom.
    if (sceneChanged && !s.selectedId && s.view.width && shouldRefitZoom(previous, scene)) s.camera = { ...s.camera, zoom: fitZoom(scene.outerRadius, s.view) };
    if (reducedMotion && s.animation) { s.camera = s.animation.to; s.animation = null; }
    s.requestFrame();
  }, [scene, filter, reducedMotion]);

  useEffect(() => {
    const s = state.current;
    s.paused = paused;
    if (paused) s.stop(); else s.requestFrame();
  }, [paused]);

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
