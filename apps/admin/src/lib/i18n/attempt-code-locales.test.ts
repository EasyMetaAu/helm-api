import { describe, expect, it } from 'vitest';

import { ATTEMPT_CODE_LABELS } from '$lib/format/attempt-codes.js';
import en from '../../locales/en.json';
import ja from '../../locales/ja.json';
import ko from '../../locales/ko.json';
import zhHans from '../../locales/zh-hans.json';
import zhHant from '../../locales/zh-hant.json';

// Every human label the attempt-code map emits must be translated (not English
// fallback) in each non-English locale — so the Decision UI's outcome/skip_reason/
// error_class chips read in the operator's language instead of the raw English label.
const labelKeys = [...new Set(Object.values(ATTEMPT_CODE_LABELS))];

const translatedLocales = { 'zh-hans': zhHans, 'zh-hant': zhHant, ja, ko } as Record<
  string,
  Record<string, string>
>;

describe('attempt-code label locale coverage', () => {
  it('en.json carries every label key (mapped to its English source)', () => {
    for (const key of labelKeys) {
      expect(en, `en.json missing ${key}`).toHaveProperty(key);
    }
  });

  it.each(Object.entries(translatedLocales))(
    '%s translates every attempt-code label instead of falling back to English',
    (_locale, dict) => {
      for (const key of labelKeys) {
        expect(dict, `missing ${key}`).toHaveProperty(key);
        expect(dict[key], `empty ${key}`).toBeTruthy();
        expect(dict[key], `untranslated ${key}`).not.toBe((en as Record<string, string>)[key]);
      }
    },
  );
});
