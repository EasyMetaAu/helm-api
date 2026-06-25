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
  // Per-request token usage (list column + detail card): every locale must
  // translate these instead of falling back to the English source.
  'Tokens',
  'Token usage',
  'Non-cached tokens',
  'Cache write tokens',
  'cached',
  'input {input} · output {output} · cached {cached} · non-cached {nonCached}',
  // Calendar-day range picker + the same-period-yesterday card delta: every locale
  // must translate these instead of falling back to the English source.
  'Yesterday',
  'vs same period yesterday',
  'Same period yesterday: {value}',
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
