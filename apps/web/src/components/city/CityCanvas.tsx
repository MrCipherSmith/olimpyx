import { useEffect, useRef, type MutableRefObject } from 'react';
import { clampZoom, diveCamera, fitZoom, hitTest, shouldRefitZoom, type Camera, type ScreenBox, type Viewport } from './isometricMath';
import { DIVE_ZOOM, FOCUS_ZOOM, divePointCamera, easeIn, hudSafeFit, lerpCamera, occludersFrom, type DiveCameraMove } from './cameraMath';
import { createRenderCache, labelAt, renderCity } from './cityRenderer';
import { shouldSkipFrame } from './cityLoop';
import type { CityScene } from './cityScene';
import { CITY_MOTION, resolveCityPalette, type CityPalette } from './cityTokens';
import { DEFAULT_INHABITANT_CAP, planInhabitants, type InhabitantActivityInput, type InhabitantAgentInput, type InhabitantPlan } from './inhabitants';
import type { ArchetypeCategory } from './roomArchetypes';

/** Stable empty defaults (City Shell §6): a caller that has no agents/activity yet never retriggers the
 * inhabitants effect just because a fresh `[]` literal was passed in. */
const EMPTY_AGENTS: readonly InhabitantAgentInput[] = [];
const EMPTY_ACTIVITY: readonly InhabitantActivityInput[] = [];
/** Below this canvas width, fewer figures walk the roads (same threshold as the decorative particle count). */
const SMALL_SCREEN_WIDTH = 600;
const SMALL_SCREEN_INHABITANT_CAP = 12;

/** Imperative camera controls used by the HUD buttons (keyboard-accessible alternatives to drag/wheel). */
export interface CityCameraController {
  zoomBy: (factor: number) => void;
  panBy: (dx: number, dy: number) => void;
  reset: () => void;
  /** Whether a camera move would be seen: a 2D context, a laid-out canvas, a visible document. */
  canAnimate: () => boolean;
  /** Camera moves of the dive / back transition (components/shell/diveMachine.ts). */
  dive: (move: DiveCameraMove) => void;
}

/** HUD panels over the city whose rectangles the scene fit avoids (PROMPT §2). */
const HUD_PANEL_SELECTOR = '.hud';

interface CityCanvasProps {
  scene: CityScene;
  /** Highlighted building (the dive target); the camera itself is driven by `controller.dive`. */
  selectedId: string | null;
  filter: ArchetypeCategory | 'all';
  label: string;
  reducedMotion: boolean;
  /** Stop the loop while a screen layer covers the whole city; resume with one fresh frame. */
  paused?: boolean;
  controller: MutableRefObject<CityCameraController | null>;
  onSelect: (id: string) => void;
  /** Real agents to walk the roads (City Shell §6); omitted draws none. */
  agents?: readonly InhabitantAgentInput[];
  /** Real, already-loaded agent↔room links (recent activity, relationships or loaded messages). */
  activity?: readonly InhabitantActivityInput[];
}

const MAX_DPR = 2;
const DRAG_THRESHOLD = 5;

interface Animation { from: Camera; to: Camera; start: number; duration: number; path: (from: Camera, to: Camera, t: number) => Camera; }

/**
 * Owns the single requestAnimationFrame loop of the city. The loop runs only while motion is allowed, the
 * document is visible and the canvas intersects the viewport; with reduced motion frames are drawn on demand
 * and camera moves are instant. Everything is cancelled and unsubscribed on unmount.
 */
export function CityCanvas({ scene, selectedId, filter, label, reducedMotion, paused = false, controller, onSelect, agents = EMPTY_AGENTS, activity = EMPTY_ACTIVITY }: CityCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const state = useRef({
    scene, selectedId, filter, reducedMotion, onSelect, agents, activity,
    inhabitants: null as InhabitantPlan | null,
    hoveredId: null as string | null,
    camera: { focalX: 0, focalY: 0, zoom: 0.5 } as Camera,
    /** The camera is at the HUD-safe whole-city fit (not moved by the user): refit it on resize/HUD changes. */
    auto: true,
    /** The view to go back to after a dive; `auto` re-fits instead of restoring a stale camera. */
    saved: null as { camera: Camera; auto: boolean } | null,
    /** A dive owns the camera: user pan/zoom/hover are ignored until it returns. */
    locked: false,
    /** HUD panel rectangles in canvas CSS pixels (see cameraMath.occludersFrom). */
    occluders: [] as ScreenBox[],
    hasContext: false,
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
    replanInhabitants: () => {},
  });
  state.current.onSelect = onSelect;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const s = state.current;
    s.palette = resolveCityPalette(canvas);
    s.hasContext = true;
    const fit = () => hudSafeFit(s.scene.outerRadius, s.view, s.occluders);
    // `now` (real wall-clock time) only anchors each online figure's deterministic starting phase — see
    // planInhabitants; the figure's own id keeps its path stable across replans (agent list refetches,
    // viewport-driven cap changes, scene rebuilds).
    const replanInhabitants = () => {
      const cap = s.view.width > 0 && s.view.width < SMALL_SCREEN_WIDTH ? SMALL_SCREEN_INHABITANT_CAP : DEFAULT_INHABITANT_CAP;
      s.inhabitants = planInhabitants(s.agents, s.activity, s.scene, Date.now(), cap);
    };
    s.replanInhabitants = replanInhabitants;

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
        // Land exactly on the target (no float drift from the eased/log-space path).
        s.camera = progress >= 1 ? s.animation.to : s.animation.path(s.animation.from, s.animation.to, progress);
        if (progress >= 1) s.animation = null;
      }
      if (animated()) s.frozenTime = now;
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      // `occluders`: HUD panel rectangles in canvas CSS pixels, measured on resize only; the renderer moves
      // labels off them.
      const frame = {
        scene: s.scene, camera: s.camera, view: s.view, palette: s.palette!, time: s.frozenTime, animate: animated(),
        hoveredId: s.hoveredId, selectedId: s.selectedId, filter: s.filter,
        particles: animated() ? (s.view.width < 600 ? 4 : 12) : 0,
        dpr: s.dpr, cache: s.cache,
        inhabitants: s.inhabitants,
        // A camera dive (s.animation) or an active drag changes the camera every frame; bypass the
        // static-layer cache for those (see RenderFrame.cameraMoving) instead of rebuilding + blitting
        // it on every single frame.
        cameraMoving: s.animation !== null || s.dragging,
        occluders: s.occluders,
      };
      renderCity(ctx, frame);
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
      measureOccluders();
      if (!s.fitted) { s.camera = fit(); s.auto = true; s.fitted = true; }
      else if (s.auto && !s.locked) { s.animation = null; s.camera = fit(); }
      // The figure cap depends on the canvas width (PROMPT §7: fewer figures on phones); re-plan whenever
      // it (or the DPR-driven backing size) actually changes.
      replanInhabitants();
      stop(); s.requestFrame();
    };

    /* --- HUD-safe margins: the panels over the canvas, measured on resize (canvas or panel) only --- */
    const panelObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => onPanelsChanged()) : null;
    const observed = new Set<Element>();
    const measureOccluders = () => {
      const root = canvas.closest('.city-shell, .city-view');
      const panels = root ? Array.from(root.querySelectorAll<HTMLElement>(HUD_PANEL_SELECTOR)) : [];
      for (const panel of panels) if (!observed.has(panel)) { observed.add(panel); panelObserver?.observe(panel); }
      s.occluders = occludersFrom(canvas.getBoundingClientRect(), panels.map(panel => panel.getBoundingClientRect()));
    };
    const onPanelsChanged = () => {
      if (!s.view.width) return;
      measureOccluders();
      if (s.auto && !s.locked && !s.animation) s.camera = fit();
      s.requestFrame();
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
    // A click on a building's label or hover card opens that building, like a click on the building itself.
    const pick = (event: PointerEvent) => { const labelled = labelAt(s.cache, event.offsetX, event.offsetY); return (labelled ? s.scene.buildings.find(b => b.id === labelled) : undefined) ?? hitTest(s.scene.drawOrder, event.offsetX, event.offsetY, s.camera, s.view); };
    const onPointerDown = (event: PointerEvent) => { if (s.locked) return; drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }; canvas.setPointerCapture?.(event.pointerId); };
    const onPointerMove = (event: PointerEvent) => {
      if (drag && drag.id === event.pointerId) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (drag.moved || Math.hypot(dx, dy) > DRAG_THRESHOLD) {
          drag.moved = true; drag.x = event.clientX; drag.y = event.clientY;
          s.dragging = true;
          s.animation = null;
          s.auto = false;
          s.camera = { ...s.camera, focalX: s.camera.focalX - dx / s.camera.zoom, focalY: s.camera.focalY - dy / s.camera.zoom };
          s.requestFrame();
        }
        return;
      }
      const hovered = s.locked ? null : pick(event)?.id ?? null;
      if (hovered !== s.hoveredId) { s.hoveredId = hovered; canvas.style.cursor = hovered ? 'pointer' : 'grab'; s.requestFrame(); }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const wasDrag = drag.moved;
      drag = null;
      s.dragging = false;
      canvas.releasePointerCapture?.(event.pointerId);
      if (wasDrag || s.locked) return;
      const hit = pick(event);
      if (hit) s.onSelect(hit.id);
    };
    const onPointerLeave = () => { if (s.hoveredId) { s.hoveredId = null; s.requestFrame(); } };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (s.locked) return;
      s.animation = null;
      s.auto = false;
      s.camera = { ...s.camera, zoom: clampZoom(s.camera.zoom * Math.exp(-event.deltaY * 0.0015)) };
      s.requestFrame();
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const animateTo = (target: Camera, duration: number, path: Animation['path']) => {
      if (s.reducedMotion || duration <= 0) { s.animation = null; s.camera = target; }
      else s.animation = { from: s.camera, to: target, start: performance.now(), duration, path };
      s.requestFrame();
    };
    const moveTo = (target: Camera, auto = false) => {
      if (s.locked) return;
      s.auto = auto;
      animateTo(target, CITY_MOTION.diveMs, diveCamera);
    };
    const saveReturn = () => { if (!s.saved) s.saved = { camera: s.animation?.to ?? s.camera, auto: s.auto }; };
    const dive = (move: DiveCameraMove) => {
      switch (move.kind) {
        case 'focus': saveReturn(); s.locked = true; animateTo(divePointCamera(move.point, FOCUS_ZOOM), move.ms, lerpCamera); break;
        case 'dive': s.locked = true; animateTo(divePointCamera(move.point, DIVE_ZOOM), move.ms, (from, to, t) => lerpCamera(from, to, t, easeIn)); break;
        case 'hold': saveReturn(); s.locked = true; s.animation = null; break;
        case 'cover': saveReturn(); s.locked = true; s.animation = null; if (move.point && !s.reducedMotion) s.camera = divePointCamera(move.point, DIVE_ZOOM); break;
        case 'return': {
          const saved = s.saved;
          s.saved = null;
          s.locked = false;
          s.auto = saved?.auto ?? true;
          animateTo(!saved || saved.auto ? fit() : saved.camera, move.ms, lerpCamera);
          break;
        }
      }
      s.requestFrame();
    };
    controller.current = {
      zoomBy: factor => moveTo({ ...(s.animation?.to ?? s.camera), zoom: clampZoom((s.animation?.to ?? s.camera).zoom * factor) }),
      panBy: (dx, dy) => { const base = s.animation?.to ?? s.camera; moveTo({ ...base, focalX: base.focalX + dx / base.zoom, focalY: base.focalY + dy / base.zoom }); },
      reset: () => moveTo(fit(), true),
      canAnimate: () => s.hasContext && s.view.width > 0 && s.view.height > 0 && s.visible && s.onScreen,
      dive,
    };

    return () => {
      stop();
      s.requestFrame = () => {};
      s.stop = () => {};
      s.dragging = false;
      resizeObserver?.disconnect();
      panelObserver?.disconnect();
      s.hasContext = false;
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
    const inhabitantInputsChanged = sceneChanged || s.agents !== agents || s.activity !== activity;
    s.scene = scene; s.filter = filter; s.reducedMotion = reducedMotion; s.agents = agents; s.activity = activity;
    if (sceneChanged) s.cache.labels.clear();
    // Polling hands us a new rooms array (and scene) often; only a changed footprint re-fits the camera
    // (the whole HUD-safe fit while the user has not moved it, else just the zoom). Never during a dive.
    if (sceneChanged && !s.locked && s.view.width && shouldRefitZoom(previous, scene)) {
      s.animation = null;
      s.camera = s.auto ? hudSafeFit(scene.outerRadius, s.view, s.occluders) : { ...s.camera, zoom: fitZoom(scene.outerRadius, s.view) };
    }
    if (reducedMotion && s.animation) { s.camera = s.animation.to; s.animation = null; }
    // A new room list can change where a room building sits (rings reflow), and a fresh agents/activity
    // fetch can change who is on the roads or which room they are linked to: re-plan (City Shell §6).
    if (inhabitantInputsChanged) s.replanInhabitants();
    s.requestFrame();
  }, [scene, filter, reducedMotion, agents, activity]);

  useEffect(() => {
    const s = state.current;
    s.paused = paused;
    if (paused) s.stop(); else s.requestFrame();
  }, [paused]);

  // Selection only highlights; the dive moves the camera through controller.dive.
  useEffect(() => {
    const s = state.current;
    s.selectedId = selectedId;
    s.requestFrame();
  }, [selectedId]);

  return <canvas ref={canvasRef} className="city-canvas" role="img" aria-label={label} />;
}
