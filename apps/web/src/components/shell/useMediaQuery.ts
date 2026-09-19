import { useEffect, useMemo, useState } from 'react';

/** Live `matchMedia` result; false where matchMedia is unavailable (tests, old engines). */
export function useMediaQuery(query: string): boolean {
  // One MediaQueryList per query instead of a new matchMedia() on every render.
  const list = useMemo(() => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null), [query]);
  const [matches, setMatches] = useState(() => list?.matches ?? false);
  useEffect(() => {
    if (!list) return;
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, [list]);
  return matches;
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/** Phones (≤ 600px) get a short screen transition instead of the long dive (PROMPT §7). */
export const PHONE_QUERY = '(max-width: 600px)';

/** Tablets (601–900px): the compact desktop HUD, never the phone tab bar (PROMPT §7). */
export const TABLET_QUERY = '(min-width: 601px) and (max-width: 900px)';

/** Phones and tablets share some HUD compacting (a collapsed-by-default building directory). */
export const COMPACT_QUERY = '(max-width: 900px)';
