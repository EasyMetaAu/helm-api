<script lang="ts">
  import { SUPPORTED_LANGUAGES, type LocaleCode } from '$lib/config/languages';
  import { locale, setLocale, t } from '$lib/i18n';

  function onChange(event: Event): void {
    const next = (event.currentTarget as HTMLSelectElement).value as LocaleCode;
    void setLocale(next);
  }
</script>

<div class="relative">
  <label class="sr-only" for="locale-switcher">{$t('Language')}</label>
  <!-- Globe icon -->
  <svg
    class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
    fill="none"
    viewBox="0 0 24 24"
    stroke-width="1.6"
    stroke="currentColor"
    aria-hidden="true"
  >
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0a8.949 8.949 0 0 0 4.951-1.488A3.987 3.987 0 0 0 13 16h-2a3.987 3.987 0 0 0-3.951 3.512A8.949 8.949 0 0 0 12 21Zm3-11a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
    />
  </svg>
  <select
    id="locale-switcher"
    value={$locale}
    onchange={onChange}
    class="w-full cursor-pointer appearance-none rounded-lg border border-slate-200 bg-white py-2 pl-8 pr-7 text-xs font-medium text-slate-600 transition hover:border-slate-300 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
  >
    {#each SUPPORTED_LANGUAGES as language (language.code)}
      <option value={language.code}>{language.native}</option>
    {/each}
  </select>
  <!-- Chevron -->
  <svg
    class="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
    fill="none"
    viewBox="0 0 24 24"
    stroke-width="2"
    stroke="currentColor"
    aria-hidden="true"
  >
    <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
  </svg>
</div>
