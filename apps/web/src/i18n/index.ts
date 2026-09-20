import i18n from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import {
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  NAMESPACES,
  STORAGE_KEY,
  SUPPORTED_LOCALES,
  type Locale,
} from './config';
import enCommon from './locales/en/common.json';
import ruCommon from './locales/ru/common.json';

const isDev = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);

/**
 * Resolve the initial locale deterministically (sync).
 *
 * Detection order:
 *   1. `localStorage['olimpyx.locale']` if it holds a supported code (`ru` / `en`)
 *   2. Browser `navigator.language` (e.g. `en-US` → `en`, `ru-RU` → `ru`)
 *   3. `DEFAULT_LOCALE` (`ru`)
 *
 * Step 2 keeps the pre-PR behaviour for casual visitors whose browser is English, so the
 * existing showcase/Playwright tests (which assert on English copy) keep working without
 * changes. An explicit user choice via the HUD switcher still wins: it overwrites localStorage
 * and step 1 takes over from the next page load.
 */
function detectInitialLocale(): Locale {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'ru' || stored === 'en') return stored;
    }
  } catch {
    /* localStorage may throw in SSR / sandboxed environments */
  }
  if (typeof navigator !== 'undefined' && navigator.language) {
    const lang = navigator.language.toLowerCase().split('-')[0];
    if (lang === 'ru' || lang === 'en') return lang;
  }
  return DEFAULT_LOCALE;
}

const initialLocale = detectInitialLocale();

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: enCommon },
      ru: { common: ruCommon },
    },
    lng: initialLocale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES as unknown as string[],
    ns: NAMESPACES as unknown as string[],
    defaultNS: DEFAULT_NAMESPACE,
    load: 'languageOnly',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    saveMissing: isDev,
    missingKeyHandler: (_lngs, _ns, key) => {
      if (isDev) console.warn(`[i18n] missing key: ${key}`);
    },
  });

const syncDocumentLang = (lng: string) => {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lng || DEFAULT_LOCALE;
};

i18n.on('languageChanged', syncDocumentLang);
syncDocumentLang(initialLocale);

export { i18n };

/** Convenience wrapper that keeps the import surface small. */
export const useT = (ns?: string | string[]) => useTranslation(ns);

/** Programmatic translation for non-hook contexts. */
export const t = (key: string, options?: Record<string, unknown>) =>
  i18n.t(key, options) as string;

export { SUPPORTED_LOCALES } from './config';
export type { Locale, Namespace } from './config';