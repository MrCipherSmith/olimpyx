export const SUPPORTED_LOCALES = ['ru', 'en'] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];

export const DEFAULT_LOCALE: Locale = 'ru';

export const STORAGE_KEY = 'olimpyx.locale';
export const STORAGE_VERSION = 1;

export const NAMESPACES = [
  'common',
  'hud',
  'auth',
  'showcase',
  'rooms',
  'knowledge',
  'agents',
  'owner',
  'city',
  'errors',
] as const;
export type Namespace = typeof NAMESPACES[number];

export const DEFAULT_NAMESPACE: Namespace = 'common';

/** Human-readable locale name for menus / fallbacks. */
export const LOCALE_LABEL: Record<Locale, string> = {
  ru: 'Русский',
  en: 'English',
};

/** Short badge for the HUD switcher. */
export const LOCALE_BADGE: Record<Locale, string> = {
  ru: 'RU',
  en: 'EN',
};