import { describe, expect, it } from 'vitest';

import manageAccountDialogSource from '../components/ManageAccountDialog.svelte?raw';
import providersPageSource from '../../routes/providers/+page.svelte?raw';
import en from '../../locales/en.json';
import es from '../../locales/es.json';
import ja from '../../locales/ja.json';
import ko from '../../locales/ko.json';
import pt from '../../locales/pt.json';
import zhHans from '../../locales/zh-hans.json';
import zhHant from '../../locales/zh-hant.json';

const providerPageKeys = [
  'Failed to load OAuth providers',
  'Failed to refresh providers',
  'Provider refresh queued',
  'Refreshing provider data…',
  'Provider refresh failed',
  'Provider refresh failed: {error}',
  'Provider data refreshed',
  'Provider data refreshed at {time}',
  'refresh available again in {seconds}s',
  'Reset-credit count unavailable',
  'No reset credits available',
  'Weekly quota snapshot unavailable',
  'Weekly usage must reach 90% before reset credits can be used',
  'Consume one credit to restore the rate-limit window',
  'This limit cannot be restored with a Codex reset credit',
  'Rate limit reached',
  'Workspace credits depleted',
  'Workspace usage limit reached',
  'No rate-limit window needed resetting',
  'Unexpected reset-credit outcome',
  'Reset credit was already redeemed',
  'Primary',
  'Secondary',
  'ChatGPT account ID',
  'ChatGPT ID: {id}',
  'FedRAMP',
  'Monthly credit limit',
  '{used} of {limit} credits used',
  'Plan: {plan}',
  'Credits: {balance}',
  'Unlimited',
  'Additional limits',
] as const;

const modelModeKeys = [
  'Model selection',
  'Automatic',
  'Always use this account’s remote model catalog and include newly available models automatically.',
  'Manual',
  'Use an explicit model list. New remote models are not added until you choose them.',
  'Models currently reported by this account’s remote catalog.',
  'No models reported yet.',
  'Only these models are exposed to Lanes. Add, edit, or remove ids, or pull the latest remote catalog into the list.',
] as const;

const featureKeys = [...providerPageKeys, ...modelModeKeys] as const;

const allLocales = {
  en,
  'zh-hans': zhHans,
  'zh-hant': zhHant,
  ja,
  ko,
  es,
  pt,
} as const;

const translatedLocales = {
  'zh-hans': zhHans,
  'zh-hant': zhHant,
  ja,
  ko,
  es,
  pt,
} as const;

function expectSourceUsesTranslation(source: string, key: string): void {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  expect(source).toMatch(new RegExp(String.raw`\$t\(\s*['"]${escaped}['"]`));
}

describe('provider GPT-5.6 subscription and model-mode locale coverage', () => {
  it('routes every new visible string through $t', () => {
    for (const key of providerPageKeys) expectSourceUsesTranslation(providersPageSource, key);
    for (const key of modelModeKeys) expectSourceUsesTranslation(manageAccountDialogSource, key);
  });

  it.each(Object.entries(allLocales))('%s defines every feature key', (_locale, dict) => {
    for (const key of featureKeys) {
      expect(dict).toHaveProperty(key);
      expect(dict[key]).toBeTruthy();
    }
  });

  it.each(Object.entries(translatedLocales))(
    '%s translates every feature key instead of falling back to English',
    (_locale, dict) => {
      for (const key of featureKeys) {
        expect(dict[key]).not.toBe(en[key]);
      }
    },
  );
});
