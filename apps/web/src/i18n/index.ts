import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next, useTranslation } from 'react-i18next';
import {
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  NAMESPACES,
  STORAGE_KEY,
  SUPPORTED_LOCALES,
} from './config';
import enCommon from './locales/en/common.json';
import ruCommon from './locales/ru/common.json';

const isDev = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: enCommon },
      ru: { common: ruCommon },
    },
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES as unknown as string[],
    // Treat navigator-only detections (e.g. `en-US`) as non-explicit so the default falls back to `ru`.
    // Only an explicit user choice (saved in localStorage as `ru`/`en`) keeps the alternate locale.
    nonExplicitSupportedLngs: false,
    ns: NAMESPACES as unknown as string[],
    defaultNS: DEFAULT_NAMESPACE,
    load: 'languageOnly',
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: STORAGE_KEY,
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    saveMissing: isDev,
    missingKeyHandler: (_lngs, _ns, key) => {
      if (isDev) console.warn(`[i18n] missing key: ${key}`);
    },
  });

const syncDocumentLang = (lng: string) => {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lng;
};

i18n.on('languageChanged', syncDocumentLang);
syncDocumentLang(i18n.language || DEFAULT_LOCALE);

export { i18n };

/** Convenience wrapper that keeps the import surface small. */
export const useT = (ns?: string | string[]) => useTranslation(ns);

/** Programmatic translation for non-hook contexts. */
export const t = (key: string, options?: Record<string, unknown>) =>
  i18n.t(key, options) as string;

export { SUPPORTED_LOCALES } from './config';
export type { Locale, Namespace } from './config';