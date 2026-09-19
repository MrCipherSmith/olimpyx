import { describe, expect, it } from 'vitest';
import { compositeOver, contrastRatio, hexToRgb } from './contrast';

// Review finding #2: `.archetype-card-badge` (styles.css) used `color: var(--accent)` on a background
// tinted from that same accent, which measured 4.27:1 / 3.82:1 for crimson and 4.01:1 for indigo once
// the parent `.archetype-card.selected` tint was compounded in — below the 4.5:1 AA floor for body
// text. The fix switches the badge text to `var(--text-primary)`. This test reconstructs the actual
// composited backgrounds (modal -> card -> badge tint) from the token values in styles/tokens.css and
// confirms text-primary clears 4.5:1 against every one of them.
const TEXT_PRIMARY = hexToRgb('#f8fafc');
const MODAL_BG = hexToRgb('#0b1528'); // --bg-panel-solid
const CARD_BG_TINT = hexToRgb('#081224'); // rgb(8, 18, 36) at 0.85 alpha, the --bg-card colour channel
const ACCENTS = {
  crimson: hexToRgb('#ff2a5f'),
  indigo: hexToRgb('#818cf8'),
};

function unselectedBadgeBg(accent: ReturnType<typeof hexToRgb>) {
  const cardBg = compositeOver(CARD_BG_TINT, 0.85, MODAL_BG); // .archetype-card background
  return compositeOver(accent, 0.18, cardBg); // .archetype-card-badge background
}

function selectedBadgeBg(accent: ReturnType<typeof hexToRgb>) {
  const selectedCardBg = compositeOver(accent, 0.10, MODAL_BG); // .archetype-card.selected background
  return compositeOver(accent, 0.18, selectedCardBg); // .archetype-card-badge background
}

describe('archetype-card-badge contrast (AA >= 4.5:1)', () => {
  it.each(Object.entries(ACCENTS))('text-primary on the unselected %s badge tint passes AA', (_name, accent) => {
    expect(contrastRatio(TEXT_PRIMARY, unselectedBadgeBg(accent))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(Object.entries(ACCENTS))('text-primary on the selected-card %s badge tint passes AA', (_name, accent) => {
    expect(contrastRatio(TEXT_PRIMARY, selectedBadgeBg(accent))).toBeGreaterThanOrEqual(4.5);
  });
});

// Review finding #11: form-control and .secondary button borders used --border-strong (cyan at 0.30
// alpha), which falls short of the 3:1 AA floor for UI-element borders (WCAG 1.4.11). The fix switches
// those borders to --border-glow (cyan at 0.45 alpha). This reconstructs the rendered border colour
// (cyan composited over --bg-input, itself composited over --bg-surface, matching styles.css) and
// checks it against the surface it sits on.
describe('form-control border contrast (non-text AA >= 3:1)', () => {
  const CYAN = hexToRgb('#00f0ff');
  const BG_SURFACE = hexToRgb('#060d1b');
  const bgInput = compositeOver(hexToRgb('#040914'), 0.95, BG_SURFACE);

  it('the old --border-strong alpha (0.30) fell short of 3:1 (documents the bug)', () => {
    const oldBorder = compositeOver(CYAN, 0.30, bgInput);
    expect(contrastRatio(oldBorder, bgInput)).toBeLessThan(3);
  });

  it('--border-glow (alpha 0.45), used by .secondary/.room-list input/.composer textarea/.modal input now, clears 3:1', () => {
    const newBorder = compositeOver(CYAN, 0.45, bgInput);
    expect(contrastRatio(newBorder, bgInput)).toBeGreaterThanOrEqual(3);
  });
});
