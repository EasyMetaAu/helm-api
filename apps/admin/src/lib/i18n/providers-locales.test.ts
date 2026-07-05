import { describe, expect, it } from 'vitest';

import en from '../../locales/en.json';
import ja from '../../locales/ja.json';
import ko from '../../locales/ko.json';
import zhHans from '../../locales/zh-hans.json';
import zhHant from '../../locales/zh-hant.json';

const resetCreditTooltipKeys = [
  'Reset-credit count unavailable',
  'No reset credits available',
  'Weekly quota snapshot unavailable',
  'Weekly usage must reach 90% before reset credits can be used',
  'Consume one credit to restore the rate-limit window',
] as const;

const translatedLocales = {
  'zh-hans': zhHans,
  'zh-hant': zhHant,
  ja,
  ko,
} as const;

describe('provider reset-credit locale coverage', () => {
  it.each(Object.entries(translatedLocales))(
    '%s translates reset-credit tooltip strings instead of falling back to English',
    (_locale, dict: Record<string, string>) => {
      for (const key of resetCreditTooltipKeys) {
        expect(dict).toHaveProperty(key);
        expect(dict[key]).toBeTruthy();
        expect(dict[key]).not.toBe((en as Record<string, string>)[key]);
      }
    },
  );
});
