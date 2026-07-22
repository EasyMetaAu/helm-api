import { describe, expect, it } from 'vitest';

import en from '../../locales/en.json';
import ja from '../../locales/ja.json';
import ko from '../../locales/ko.json';
import zhHans from '../../locales/zh-hans.json';
import zhHant from '../../locales/zh-hant.json';

const settingsKeys = [
  'Compact database automatically',
  'Full payload for every request',
  'Incremental transcript per session',
  'Metadata only',
  'Privacy note: full payload and session modes store message content. Choose metadata only to store no bodies.',
  'Request content storage',
  'Run at hour (0-23, server local time)',
  'Runs VACUUM once a day to reclaim deleted disk space. The database is briefly locked while it runs.',
  'Session mode stores repeated conversation history once and reconstructs each request semantically.',
] as const;

const translatedLocales = {
  'zh-hans': zhHans,
  'zh-hant': zhHant,
  ja,
  ko,
} as const;

describe('settings locale coverage', () => {
  it.each(Object.entries(translatedLocales))(
    '%s translates settings strings instead of falling back to English',
    (_locale, dict: Record<string, string>) => {
      for (const key of settingsKeys) {
        expect(dict).toHaveProperty(key);
        expect(dict[key]).toBeTruthy();
        expect(dict[key]).not.toBe((en as Record<string, string>)[key]);
      }
    },
  );
});
