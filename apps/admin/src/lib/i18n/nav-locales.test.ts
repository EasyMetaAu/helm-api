import { describe, expect, it } from 'vitest';

import en from '../../locales/en.json';
import es from '../../locales/es.json';
import ja from '../../locales/ja.json';
import ko from '../../locales/ko.json';
import pt from '../../locales/pt.json';
import zhHans from '../../locales/zh-hans.json';
import zhHant from '../../locales/zh-hant.json';

// The sidebar nav subtitles in routes/+layout.svelte are referenced ONLY via the
// dynamic `$t(item.desc)`, so the extractor never sees them as static calls —
// they are kept alive by lib/i18n/extraction-anchors.svelte. If an anchor is
// missing, `pnpm i18n:sync` prunes the string from every locale and the subtitle
// silently falls back to raw English. The Memory subtitle regressed exactly that
// way (its anchor was never added when the Memory nav item shipped). Guard them all.
const navSubtitleKeys = [
  'Traffic and health at a glance',
  'Every request and the lane it took',
  'Quality tiers and fallback models',
  'Rules that override or cap the lane',
  'How a request is matched to a lane',
  'Client keys and their lane limits',
  'Facts and reflections the gateway remembers',
  'Connect AI subscriptions',
  'System Settings',
] as const;

const translatedLocales = {
  'zh-hans': zhHans,
  'zh-hant': zhHant,
  ja,
  ko,
  es,
  pt,
} as const;

describe('sidebar nav subtitle locale coverage', () => {
  it.each(Object.entries(translatedLocales))(
    '%s translates every sidebar nav subtitle instead of falling back to English',
    (_locale, dict: Record<string, string>) => {
      for (const key of navSubtitleKeys) {
        expect(dict).toHaveProperty(key);
        expect(dict[key]).toBeTruthy();
        expect(dict[key]).not.toBe((en as Record<string, string>)[key]);
      }
    },
  );
});
