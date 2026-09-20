import type { Locale } from '../i18n/config';
import { DEFAULT_LOCALE } from '../i18n/config';

/**
 * Localized-string field pair used by scene data (room archetypes, building
 * labels, archetype categories). The Russian copy is the canonical field; the
 * English variant is opt-in via `*En`.
 */
export interface LocalizedPair<T = string> {
  /** Default-locale value (e.g. Russian). */
  label: T;
  /** Optional override for English. Falls back to `label` when missing. */
  labelEn?: T;
}

export interface LocalizedNamePair {
  name: string;
  nameEn?: string;
}

export interface LocalizedSummaryPair {
  summary: string;
  summaryEn?: string;
}

/**
 * Selects the localized value from a `LocalizedPair` for the given locale.
 * Falls back to the default (Russian) field when the locale is not English or
 * the English override is missing.
 */
export function localize<T>(pair: LocalizedPair<T> | undefined, locale: Locale): T | undefined {
  if (!pair) return undefined;
  if (locale === 'en' && pair.labelEn !== undefined) return pair.labelEn;
  return pair.label;
}

export function localizeName(pair: LocalizedNamePair | undefined, locale: Locale): string {
  if (!pair) return '';
  if (locale === 'en' && pair.nameEn) return pair.nameEn;
  return pair.name;
}

export function localizeSummary(pair: LocalizedSummaryPair | undefined, locale: Locale): string {
  if (!pair) return '';
  if (locale === 'en' && pair.summaryEn) return pair.summaryEn;
  return pair.summary;
}

/** Resolve locale, defaulting when the input is unknown. */
export function resolveLocale(value: string | undefined | null): Locale {
  if (value === 'en') return 'en';
  return DEFAULT_LOCALE;
}