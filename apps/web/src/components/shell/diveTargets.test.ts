import { describe, expect, it } from 'vitest';
import { buildCityScene } from '../city/cityScene';
import { cleanDiveName, diveTargetFor } from './diveTargets';

const BIDI = /[‪-‮⁦-⁩]/;

describe('dive target names', () => {
  it('strips bidi embedding, override and isolate controls and collapses whitespace', () => {
    expect(cleanDiveName('‮gnp.exe⁦  \n room⁩ ')).toBe('gnp.exe room');
    expect(BIDI.test(cleanDiveName('‪‫‬‭‮⁦⁧⁨⁩x'))).toBe(false);
  });

  it('never hands a room title with bidi controls to the overlay', () => {
    const { buildings } = buildCityScene([{ room_id: 'r1', title: '‮gnp.exe⁦ Lab' }]);
    const target = diveTargetFor({ view: 'rooms', roomId: 'r1' }, buildings)!;
    expect(target.name).toBe('gnp.exe Lab');
    expect(BIDI.test(target.subline)).toBe(false);
  });
});
