// Supported portal languages. Mirrors the Contrack i18n convention (BCP-47-ish
// codes, `native` display names) but scoped to the launch set: English (default)
// + Simplified/Traditional Chinese + Japanese + Korean + Spanish + Portuguese. Add a code here + a
// loader in src/lib/i18n/loaders.ts + a src/locales/<code>.json to extend.
export type LocaleCode =
  | "en"
  | "zh-hans"
  | "zh-hant"
  | "ja"
  | "ko"
  | "es"
  | "pt";

export const DEFAULT_LOCALE: LocaleCode = "en";

export const SUPPORTED_LANGUAGES: ReadonlyArray<{
  code: LocaleCode;
  native: string;
}> = [
  { code: "en", native: "English" },
  { code: "zh-hans", native: "简体中文" },
  { code: "zh-hant", native: "繁體中文" },
  { code: "ja", native: "日本語" },
  { code: "ko", native: "한국어" },
  { code: "es", native: "Español" },
  { code: "pt", native: "Português" },
];

export const SUPPORTED_LOCALE_CODES: ReadonlyArray<LocaleCode> =
  SUPPORTED_LANGUAGES.map((l) => l.code);

// Map an arbitrary stored/browser language tag to one of our supported codes.
// Falls back to the default (en) for anything unrecognized.
export function normalizeLocale(input: string | null | undefined): LocaleCode {
  if (!input) return DEFAULT_LOCALE;
  const v = input.toLowerCase().replace("_", "-");
  if (
    v === "zh-hant" ||
    v === "zh-tw" ||
    v === "zh-hk" ||
    v === "zh-mo" ||
    v.includes("hant")
  ) {
    return "zh-hant";
  }
  if (
    v === "zh-hans" ||
    v === "zh-cn" ||
    v === "zh-sg" ||
    v === "zh" ||
    v.startsWith("zh-")
  ) {
    return "zh-hans";
  }
  if (v.startsWith("ja")) return "ja";
  if (v.startsWith("ko")) return "ko";
  if (v.startsWith("es")) return "es";
  if (v.startsWith("pt")) return "pt";
  if (v === "en" || v.startsWith("en-")) return "en";
  return DEFAULT_LOCALE;
}
