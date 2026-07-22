import { describe, expect, it } from 'vitest';

import en from '../../locales/en.json';
import ja from '../../locales/ja.json';
import ko from '../../locales/ko.json';
import zhHans from '../../locales/zh-hans.json';
import zhHant from '../../locales/zh-hant.json';

const requestDetailPayloadKeys = [
  'Load conversation',
  'Load request body',
  'Load response body',
  'Load the captured request and response only when you need the transcript.',
  'Load the full response body only when you need to inspect it.',
  'Load the raw request body only when you need to inspect it.',
  'Load this only when you need to compare the client body with the provider body.',
  'Load upstream request',
  'Loading',
  'Payload capture is available for this call. Large bodies are loaded on demand.',
  'Payload capture is available for this call. Large bodies are loaded only when you open a section.',
  'Payload was not available.',
  'This content was recovered from the session transcript. It is not the original HTTP request and cannot be retried exactly.',
  'The forwarded upstream body matched the client request body.',
] as const;

const translatedLocales = {
  'zh-hans': zhHans,
  'zh-hant': zhHant,
  ja,
  ko,
} as const;

describe('request detail payload locale coverage', () => {
  it.each(Object.entries(translatedLocales))(
    '%s translates lazy payload strings instead of falling back to English',
    (_locale, dict: Record<string, string>) => {
      for (const key of requestDetailPayloadKeys) {
        expect(dict).toHaveProperty(key);
        expect(dict[key]).toBeTruthy();
        expect(dict[key]).not.toBe((en as Record<string, string>)[key]);
      }
    },
  );
});
