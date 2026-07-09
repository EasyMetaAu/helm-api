import type { LocaleCode } from '$lib/config/languages';

export type TranslationDict = Record<string, string>;

// Lazy per-locale dictionary loaders (Contrack pattern). Each locale's JSON is a
// separate chunk so only the active language is downloaded. Keys are the English
// source strings; values are the translation (empty/missing → English fallback).
const loaders: Record<LocaleCode, () => Promise<TranslationDict>> = {
  en: async () => (await import('../../locales/en.json')).default as TranslationDict,
  'zh-hans': async () => (await import('../../locales/zh-hans.json')).default as TranslationDict,
  'zh-hant': async () => (await import('../../locales/zh-hant.json')).default as TranslationDict,
  ja: async () => (await import('../../locales/ja.json')).default as TranslationDict,
  ko: async () => (await import('../../locales/ko.json')).default as TranslationDict,
  es: async () => (await import('../../locales/es.json')).default as TranslationDict,
  pt: async () => (await import('../../locales/pt.json')).default as TranslationDict,
};

export async function loadLocaleDict(locale: LocaleCode): Promise<TranslationDict> {
  const loader = loaders[locale] ?? loaders.en;
  return loader();
}
