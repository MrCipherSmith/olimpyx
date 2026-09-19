import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';
import type { View } from '../../lib/navigation';
import { SCREEN_HEADING_ID } from './ScreenLayer';

interface CityShellProps {
  /** The floating HUD card (brand, network status, navigation, stats, account). */
  hud: ReactNode;
  /** The persistent city: canvas, legend, building list and camera. */
  city: ReactNode;
  /** The open screen layer, or null while the city is shown. */
  screen: ReactNode;
  /** Changes whenever a different screen replaces the current one. */
  screenKey: string | null;
  /** The navigation view of the open screen; its nav item is the focus fallback on close. */
  screenView: View | null;
  onClose: () => void;
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';
const inertWhile = (hidden: boolean) => (hidden ? { 'aria-hidden': true, inert: '' } : {}) as Record<string, unknown>;

/** A draft in a text field must not be thrown away by an Escape meant for the field. */
function keepsEscape(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return target.value !== '';
  return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * The app shell: the city fills the viewport, the HUD floats over it and every screen is a full-screen
 * layer on top. While a screen is open the city and HUD are inert, focus moves to the screen heading,
 * Escape closes the screen (unless a dialog is open) and focus returns to what opened it.
 */
export function CityShell({ hud, city, screen, screenKey, screenView, onClose }: CityShellProps) {
  const open = screenKey !== null;
  const shellRef = useRef<HTMLDivElement | null>(null);
  /** The last control used in the city or HUD: the opener of the next screen. */
  const lastUsed = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const previous = useRef<{ key: string | null; view: View | null }>({ key: null, view: null });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const outsideScreen = (target: EventTarget | null) => target instanceof HTMLElement && !target.closest('.screen-layer');
    const onFocusIn = (event: FocusEvent) => { if (outsideScreen(event.target)) lastUsed.current = event.target as HTMLElement; };
    // A click on the canvas opens a screen without focusing anything: forget the older control.
    const onPointerDown = (event: PointerEvent) => { if (outsideScreen(event.target)) lastUsed.current = (event.target as HTMLElement).closest<HTMLElement>(FOCUSABLE); };
    shell.addEventListener('focusin', onFocusIn);
    shell.addEventListener('pointerdown', onPointerDown, true);
    return () => { shell.removeEventListener('focusin', onFocusIn); shell.removeEventListener('pointerdown', onPointerDown, true); };
  }, []);

  // Layout effect: runs before paint, so the heading has focus in the same frame the screen appears.
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { key: screenKey, view: screenView };
    if (screenKey === before.key) return;
    if (screenKey) {
      if (!before.key) opener.current = lastUsed.current;
      document.getElementById(SCREEN_HEADING_ID)?.focus({ preventScroll: true });
      return;
    }
    // Closed: back to the building or nav item that opened the screen, else that screen's nav item.
    const shell = shellRef.current;
    const candidates = [opener.current, before.view ? shell?.querySelector<HTMLElement>(`[data-nav-view="${before.view}"]`) : null, shell?.querySelector<HTMLElement>('[data-nav-view="overview"]')];
    opener.current = null;
    candidates.find(element => element?.isConnected && shell?.contains(element))?.focus({ preventScroll: true });
  }, [screenKey, screenView]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return; // the dialog owns Escape
      if (keepsEscape(event.target)) return;
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div className={`city-shell${open ? ' screen-open' : ''}`} ref={shellRef}>
      <div className="city-shell-hud" {...inertWhile(open)}>{hud}</div>
      <main className="city-shell-main">
        <div className="city-shell-world" {...inertWhile(open)}>{city}</div>
        {screen}
      </main>
    </div>
  );
}
