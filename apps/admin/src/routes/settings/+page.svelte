<script lang="ts">
  import { untrack } from 'svelte';
  import {
    LOG_LEVEL_OPTIONS,
    type LogLevel,
    type RuntimeSettings,
    saveSettings,
  } from '$lib/api/settings.js';
  import { t } from '$lib/i18n';

  // System Settings — runtime-mutable config that applies WITHOUT a restart
  // (capture_payloads, payload_retention_days, rate_limit_enabled, log_level).
  // Pure consumer (Principle 1): edits a local working copy, PUTs the whole object on Save;
  // the gateway validates + applies it live.
  let { data }: { data: { settings: RuntimeSettings | null; loadError?: string } } = $props();

  const DEFAULTS: RuntimeSettings = {
    capture_payloads: true,
    payload_retention_days: 30,
    // Native protocol passthrough (issue #217): default ON. No longer surfaced as
    // a toggle (UI removed in #236) — kept in the working copy so it round-trips
    // through Save unchanged and is never reset to false (the #225 lesson).
    native_protocol_passthrough: true,
    rate_limit_enabled: false,
    rate_limit_default_rpm: 0,
    rate_limit_default_tpm: 0,
    log_level: 'info' as LogLevel,
    concurrency_queue_enabled: false,
    concurrency_queue_min_size: 5,
    concurrency_queue_size_multiplier: 0,
    concurrency_queue_wait_timeout_ms: 10000,
    user_message_queue_enabled: false,
    user_message_queue_delay_ms: 200,
    user_message_queue_wait_timeout_ms: 5000,
  };
  // Local working copy (snapshot the loaded settings into a NEW object so the
  // $state initializer doesn't capture the reactive `data` prop reference).
  let form = $state<RuntimeSettings>(untrack(() => ({ ...(data.settings ?? DEFAULTS) })));

  let error = $state<string | null>(untrack(() => data.loadError ?? null));
  let saving = $state(false);
  let saved = $state(false);

  async function handleSave(): Promise<void> {
    error = null;
    saved = false;
    saving = true;
    try {
      form = await saveSettings(form);
      saved = true;
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to save settings');
    } finally {
      saving = false;
    }
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header class="flex flex-col gap-2">
    <h1 class="page-title">{$t('System Settings')}</h1>
    <p class="section-desc">
      {$t('Runtime settings that take effect immediately — no restart needed.')}
    </p>
  </header>

  {#if error}
    <p class="alert-error" role="alert">{error}</p>
  {/if}

  {#if data.settings}
    <!-- Payload capture -->
    <section class="card flex flex-col gap-3 text-sm">
      <h2 class="section-header">{$t('Request logging')}</h2>

      <label class="flex items-start gap-3">
        <input
          type="checkbox"
          data-testid="capture-payloads"
          class="checkbox mt-0.5"
          bind:checked={form.capture_payloads}
        />
        <span>
          <span class="font-medium">{$t('Record full request and response bodies')}</span>
          <span class="field-help block"
            >{$t(
              'When on, the complete request and response of every call are stored so you can view them here.',
            )}</span
          >
          <span class="field-help mt-1 block text-amber-600"
            >{$t(
              'Privacy note: this stores message content in plaintext. Turn it off to keep only routing metadata.',
            )}</span
          >
        </span>
      </label>

      <label class="flex flex-col gap-1">
        <span class="font-medium">{$t('Keep recorded bodies for (days)')}</span>
        <input
          type="number"
          min="1"
          max="3650"
          data-testid="retention-days"
          class="input-sm w-32"
          bind:value={form.payload_retention_days}
        />
        <span class="field-help">{$t('Older bodies are deleted automatically.')}</span>
      </label>
    </section>

    <!-- Operations -->
    <section class="card flex flex-col gap-3 text-sm">
      <h2 class="section-header">{$t('Operations')}</h2>

      <label class="flex items-start gap-3">
        <input
          type="checkbox"
          data-testid="rate-limit-enabled"
          class="checkbox mt-0.5"
          bind:checked={form.rate_limit_enabled}
        />
        <span>
          <span class="font-medium">{$t('Enable rate limiting')}</span>
          <span class="field-help block"
            >{$t('Apply the configured per-key request and token limits.')}</span
          >
        </span>
      </label>

      <div class="flex flex-col gap-3 border-l-2 border-slate-100 pl-3 sm:flex-row sm:gap-6">
        <label class="flex flex-col gap-1">
          <span class="font-medium">{$t('Default requests per minute (RPM)')}</span>
          <input
            type="number"
            min="0"
            step="1"
            data-testid="rate-limit-default-rpm"
            class="input-sm w-32"
            bind:value={form.rate_limit_default_rpm}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="font-medium">{$t('Default tokens per minute (TPM)')}</span>
          <input
            type="number"
            min="0"
            step="1"
            data-testid="rate-limit-default-tpm"
            class="input-sm w-32"
            bind:value={form.rate_limit_default_tpm}
          />
        </label>
      </div>
      <span class="field-help"
        >{$t(
          'The fallback limit for any key without its own per-key value. 0 means unlimited.',
        )}</span
      >

      <label class="flex flex-col gap-1">
        <span class="font-medium">{$t('Log level')}</span>
        <select data-testid="log-level" class="select w-40" bind:value={form.log_level}>
          {#each LOG_LEVEL_OPTIONS as level (level)}
            <option value={level}>{level}</option>
          {/each}
        </select>
        <span class="field-help">{$t('How much detail the gateway writes to its logs.')}</span>
      </label>
    </section>

    <!-- Request queueing (issue #93) -->
    <section class="card flex flex-col gap-3 text-sm">
      <h2 class="section-header">{$t('Request queueing')}</h2>

      <label class="flex items-start gap-3">
        <input
          type="checkbox"
          data-testid="concurrency-queue-enabled"
          class="checkbox mt-0.5"
          bind:checked={form.concurrency_queue_enabled}
        />
        <span>
          <span class="font-medium">{$t('Queue requests over a key’s concurrency limit')}</span>
          <span class="field-help block"
            >{$t(
              'When an API key exceeds its max concurrent requests, extra requests wait in line instead of being rejected immediately. Suits agents that fire parallel tool calls.',
            )}</span
          >
        </span>
      </label>

      <div class="flex flex-col gap-3 border-l-2 border-slate-100 pl-3 sm:flex-row sm:gap-6">
        <label class="flex flex-col gap-1">
          <span class="font-medium">{$t('Minimum queue size')}</span>
          <input
            type="number"
            min="1"
            max="100"
            step="1"
            data-testid="concurrency-queue-min-size"
            class="input-sm w-32"
            bind:value={form.concurrency_queue_min_size}
          />
          <span class="field-help">{$t('Fixed lower bound on how many requests may wait.')}</span>
        </label>
        <label class="flex flex-col gap-1">
          <span class="font-medium">{$t('Queue size multiplier')}</span>
          <input
            type="number"
            min="0"
            step="0.5"
            data-testid="concurrency-queue-multiplier"
            class="input-sm w-32"
            bind:value={form.concurrency_queue_size_multiplier}
          />
          <span class="field-help"
            >{$t(
              'Max queue = MAX(multiplier × key limit, minimum). 0 uses the minimum only.',
            )}</span
          >
        </label>
        <label class="flex flex-col gap-1">
          <span class="font-medium">{$t('Queue wait timeout (ms)')}</span>
          <input
            type="number"
            min="5000"
            max="300000"
            step="1000"
            data-testid="concurrency-queue-timeout"
            class="input-sm w-32"
            bind:value={form.concurrency_queue_wait_timeout_ms}
          />
          <span class="field-help">{$t('Waiting longer than this returns 429.')}</span>
        </label>
      </div>

      <label class="flex items-start gap-3">
        <input
          type="checkbox"
          data-testid="user-message-queue-enabled"
          class="checkbox mt-0.5"
          bind:checked={form.user_message_queue_enabled}
        />
        <span>
          <span class="font-medium">{$t('Serialize user messages per subscription account')}</span>
          <span class="field-help block"
            >{$t(
              'Runs user-message requests to the same OAuth account one at a time with a minimum gap, to avoid tripping upstream rate limits. Tool results and assistant continuations are never queued.',
            )}</span
          >
        </span>
      </label>

      <div class="flex flex-col gap-3 border-l-2 border-slate-100 pl-3 sm:flex-row sm:gap-6">
        <label class="flex flex-col gap-1">
          <span class="font-medium">{$t('Gap between requests (ms)')}</span>
          <input
            type="number"
            min="0"
            max="10000"
            step="50"
            data-testid="user-message-queue-delay"
            class="input-sm w-32"
            bind:value={form.user_message_queue_delay_ms}
          />
          <span class="field-help"
            >{$t('Minimum time between one request finishing and the next starting.')}</span
          >
        </label>
        <label class="flex flex-col gap-1">
          <span class="font-medium">{$t('Queue wait timeout (ms)')}</span>
          <input
            type="number"
            min="1000"
            max="300000"
            step="500"
            data-testid="user-message-queue-timeout"
            class="input-sm w-32"
            bind:value={form.user_message_queue_wait_timeout_ms}
          />
          <span class="field-help">{$t('Waiting longer than this returns 503.')}</span>
        </label>
      </div>
    </section>

    <div class="card-actions border-t-0 pt-0">
      {#if saved}
        <span class="badge-ok" role="status">{$t('Saved')}</span>
      {/if}
      <button class="btn-primary" onclick={handleSave} disabled={saving || !data.settings}>
        {$t('Save settings')}
      </button>
    </div>
  {/if}
</section>
