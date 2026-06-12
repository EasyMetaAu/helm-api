import { describe, expect, it } from 'vitest';

import en from '../../locales/en.json';
import ja from '../../locales/ja.json';
import ko from '../../locales/ko.json';
import zhHans from '../../locales/zh-hans.json';
import zhHant from '../../locales/zh-hant.json';

const dashboardTokenKeys = [
  'Tokens by model',
  'Token usage over time',
  'Total tokens',
  'Input tokens',
  'Output tokens',
  'Cached tokens',
  'No token usage recorded in this window yet.',
] as const;

const translatedLocales = {
  'zh-hans': zhHans,
  'zh-hant': zhHant,
  ja,
  ko,
};

describe('dashboard token-accounting locale coverage', () => {
  it.each(Object.entries(translatedLocales))(
    '%s translates every dashboard token key instead of falling back to English',
    (_locale, dict) => {
      for (const key of dashboardTokenKeys) {
        expect(dict).toHaveProperty(key);
        expect(dict[key]).toBeTruthy();
        expect(dict[key]).not.toBe(en[key]);
      }
    },
  );
});
