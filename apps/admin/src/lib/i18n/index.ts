import { derived, get, type Readable, writable } from 'svelte/store';
import { DEFAULT_LOCALE, type LocaleCode, normalizeLocale } from '$lib/config/languages';
import { loadLocaleDict, type TranslationDict } from './loaders';

// Client-side i18n for the admin SPA (adapter-static, no SSR/server hooks). Same
// ergonomics as Contrack — `$t('English source', { var })` with {var} interpolation,
// keys are the English strings, untranslated keys fall back to the (English) key —
// but locale state lives in a store + localStorage instead of page.data/cookies.

const STORAGE_KEY = 'helm_admin_locale';

type Vars = Record<string, string | number | undefined>;
type TranslateFn = (key: string, vars?: Vars) => string;

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const value = vars[name];
    return value === undefined ? '' : String(value);
  });
}

/** Active locale (reactive). Use `setLocale` to change it. */
export const locale = writable<LocaleCode>(DEFAULT_LOCALE);

const messages = writable<TranslationDict>({});

/** Reactive translate function. `$t('Save')`, `$t('Errors: {count}', { count })`. */
export const t: Readable<TranslateFn> = derived(messages, ($messages) => {
  return (key: string, vars?: Vars): string => {
    const raw = $messages[key];
    return interpolate(raw ?? key, vars);
  };
});

async function applyLocale(next: LocaleCode): Promise<void> {
  const dict = await loadLocaleDict(next);
  messages.set(dict);
  locale.set(next);
  if (typeof document !== 'undefined') document.documentElement.lang = next;
}

/** Switch language and persist the choice (localStorage). */
export async function setLocale(next: LocaleCode): Promise<void> {
  if (next === get(locale) && Object.keys(get(messages)).length > 0) return;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage may be unavailable (private mode) — language still applies for the session
    }
  }
  await applyLocale(next);
}

/** Resolve the initial locale: saved preference → browser language → default. */
export async function initI18n(): Promise<void> {
  let initial: LocaleCode = DEFAULT_LOCALE;
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) initial = normalizeLocale(saved);
    else if (typeof navigator !== 'undefined') initial = normalizeLocale(navigator.language);
  }
  await applyLocale(initial);
}

export { loadLocaleDict } from './loaders';
export type { TranslationDict } from './loaders';
