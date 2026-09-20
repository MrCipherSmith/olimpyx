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
 * Resolve the initial locale without racing against an async detector.
 *
 * Detection order:
 *   1. `localStorage['olimpyx.locale']` if it holds a supported code (`ru` / `en`)
 *   2. `DEFAULT_LOCALE` (`ru`)
 *
 * Browser `navigator.language` is intentionally NOT consulted. Olimpyx is a Russian-first
 * product and the empty-localStorage path must fall back to Russian deterministically —
 * otherwise a Playwright headless navigator='en-US' or a casual English-speaking visitor
 * would silently land on the English UI without ever being told they had a choice.
 */
function detectInitialLocale(): Locale {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'ru' || stored === 'en') return stored;
    }
  } catch {
    /* localStorage can throw in SSR / sandboxed environments — ignore */
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