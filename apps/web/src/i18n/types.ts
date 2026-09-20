import enCommon from './locales/en/common.json';
import ruCommon from './locales/ru/common.json';

export type CommonCatalog = typeof enCommon;

type DeepKeys<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string | number | boolean
    ? `${P}${K}`
    : T[K] extends object
    ? DeepKeys<T[K], `${P}${K}.`>
    : never;
}[keyof T & string];

export type CommonKey = DeepKeys<CommonCatalog>;

export const resources = {
  en: { common: enCommon },
  ru: { common: ruCommon },
} as const;