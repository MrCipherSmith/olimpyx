import { describe, expect, it } from 'vitest';
import { localize, localizeName, localizeSummary, resolveLocale } from './label';

describe('label helpers', () => {
  it('returns English override for locale en', () => {
    expect(localize({ label: 'Преторий', labelEn: 'Praetorium' }, 'en')).toBe('Praetorium');
  });

  it('falls back to Russian default for locale ru', () => {
    expect(localize({ label: 'Преторий', labelEn: 'Praetorium' }, 'ru')).toBe('Преторий');
  });

  it('falls back to default when English override is missing', () => {
    expect(localize({ label: 'Преторий' }, 'en')).toBe('Преторий');
  });

  it('handles undefined pair', () => {
    expect(localize(undefined, 'en')).toBeUndefined();
  });

  it('localizeName applies same logic', () => {
    expect(localizeName({ name: 'Шпиль Нейросети', nameEn: 'Neural Matrix Spire' }, 'en')).toBe('Neural Matrix Spire');
    expect(localizeName({ name: 'Шпиль Нейросети' }, 'ru')).toBe('Шпиль Нейросети');
  });

  it('localizeSummary applies same logic', () => {
    expect(localizeSummary({ summary: 'Колоннада', summaryEn: 'Colonnaded rotunda' }, 'en')).toBe('Colonnaded rotunda');
    expect(localizeSummary({ summary: 'Колоннада' }, 'ru')).toBe('Колоннада');
  });

  it('resolveLocale normalizes unknown values to default', () => {
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('ru')).toBe('ru');
    expect(resolveLocale('de')).toBe('ru');
    expect(resolveLocale(null)).toBe('ru');
  });
});