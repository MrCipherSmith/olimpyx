import type { ArchetypeColor } from './roomArchetypes';

/**
 * Canvas cannot read CSS custom properties directly, so the city resolves the design tokens from
 * styles/tokens.css once per mount. Components never hard-code colours: they refer to token names here,
 * and translucency is applied with globalAlpha instead of rgba literals.
 */
export const CITY_COLOR_TOKENS = {
  cyan: '--color-cyan', indigo: '--color-indigo', emerald: '--color-emerald', gold: '--color-gold',
  amber: '--color-amber', crimson: '--color-crimson', orange: '--color-orange', purple: '--color-purple',
  slate: '--color-slate', rose: '--color-rose', teal: '--color-teal',
  ground: '--bg-base', surface: '--bg-surface', panel: '--bg-panel-solid', raised: '--bg-raised',
  text: '--text-primary', textMuted: '--text-secondary',
} as const satisfies Record<ArchetypeColor | string, `--${string}`>;

export type CityPaletteKey = keyof typeof CITY_COLOR_TOKENS;
export type CityPalette = Record<CityPaletteKey, string>;

export function resolveCityPalette(element: Element = document.documentElement): CityPalette {
  const style = getComputedStyle(element);
  const palette = {} as CityPalette;
  for (const [key, token] of Object.entries(CITY_COLOR_TOKENS) as [CityPaletteKey, string][]) {
    // Unresolved tokens (e.g. no stylesheet in unit tests) fall back to canvas's own default colour.
    palette[key] = style.getPropertyValue(token).trim() || 'currentColor';
  }
  return palette;
}

export const CITY_MOTION = { diveMs: 1100 } as const;
