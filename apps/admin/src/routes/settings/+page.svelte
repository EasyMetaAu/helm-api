<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import {
    archiveDownloadUrl,
    type CleanupArchiveEntry,
    type CleanupReport,
    getCleanupStatus,
    runCleanupNow,
    vacuumDatabase,
  } from '$lib/api/cleanup.js';
  import {
    LOG_LEVEL_OPTIONS,
    VISUAL_CONTEXT_COMPRESSION_OPTIONS,
    type LogLevel,
    type RuntimeSettings,
    saveSettings,
  } from '$lib/api/settings.js';
  import Modal from '$lib/components/Modal.svelte';
  import { formatTimestamp } from '$lib/format.js';
  import { t } from '$lib/i18n';

  // System Settings — runtime-mutable config that applies WITHOUT a restart
  // (capture_payloads, payload_retention_days, rate_limit_enabled, log_level).
  // Pure consumer (Principle 1): edits a local working copy, PUTs the whole object on Save;
  // the gateway validates + applies it live.
  let {
    data,
  }: { data: { settings: RuntimeSettings | null; lanes?: string[]; loadError?: string } } =
    $props();

  const DEFAULTS: RuntimeSettings = {
    capture_payloads: true,
    payload_retention_days: 30,
    // Native protocol passthrough (issue #217): default ON. No longer surfaced as
    // a toggle (UI removed in #236) — kept in the working copy so it round-trips
    // through Save unchanged and is never reset to false (the #225 lesson).
    native_protocol_passthrough: true,
    visual_context_compression: 'off',
    rate_limit_enabled: false,
    rate_limit_default_rpm: 0,
    rate_limit_default_tpm: 0,
    log_level: 'info' as LogLevel,
    default_lane: 'balanced',
    concurrency_queue_enabled: false,
    concurrency_queue_min_size: 5,
    concurrency_queue_size_multiplier: 0,
    concurrency_queue_wait_timeout_ms: 10000,
    user_message_queue_enabled: false,
    user_message_queue_delay_ms: 200,
    user_message_queue_wait_timeout_ms: 5000,
    cleanup_enabled: true,
    cleanup_interval_hours: 24,
    cleanup_archive_enabled: true,
    telemetry_cleanup_enabled: true,
    telemetry_retention_days: 90,
    payloads_cleanup_enabled: true,
    oauth_usage_cleanup_enabled: true,
    oauth_usage_retention_days: 180,
    memory_jobs_cleanup_enabled: true,
    memory_jobs_retention_days: 30,
    memory_messages_cleanup_enabled: false,
    memory_messages_retention_days: 180,
    memory_derived_cleanup_enabled: false,
    memory_derived_retention_days: 365,
    vacuum_enabled: false,
    vacuum_hour: 4,
  };
  // Local working copy (snapshot the loaded settings into a NEW object so the
  // $state initializer doesn't capture the reactive `data` prop reference).
  let form = $state<RuntimeSettings>(untrack(() => ({ ...(data.settings ?? DEFAULTS) })));

  let error = $state<string | null>(untrack(() => data.loadError ?? null));
  let saving = $state(false);
  let saved = $state(false);

  // Lane options for the default-lane dropdown: the loaded lanes, always including
  // `balanced` (the guaranteed floor) and the current value (so a still-set lane
  // that no longer loads doesn't vanish from the picker).
  const laneOptions = $derived(
    Array.from(new Set([...(data.lanes ?? []), 'balanced', form.default_lane])),
  );

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

  // ——— Data cleanup runtime actions (independent of the settings form Save) ———
  let lastRun = $state<CleanupReport | null>(null);
  let archives = $state<CleanupArchiveEntry[]>([]);
  let cleaning = $state(false);
  let vacuuming = $state(false);
  let cleanupError = $state<string | null>(null);
  // Both maintenance actions are destructive/disruptive, so they run only after an
  // explicit confirm (mirrors the revoke/disconnect confirm pattern elsewhere). The
  // flag holds the dialog open; the real work runs from the dialog's confirm button.
  let confirmingClean = $state(false);
  let confirmingVacuum = $state(false);

  async function refreshCleanupStatus(): Promise<void> {
    try {
      const status = await getCleanupStatus();
      lastRun = status.lastRun;
      archives = status.archives;
    } catch {
      // Status is best-effort; the card still renders the form controls.
    }
  }

  onMount(refreshCleanupStatus);

  async function handleCleanNow(): Promise<void> {
    cleanupError = null;
    cleaning = true;
    try {
      lastRun = await runCleanupNow();
      await refreshCleanupStatus();
    } catch (e) {
      cleanupError = e instanceof Error ? e.message : $t('Cleanup failed');
    } finally {
      cleaning = false;
      confirmingClean = false;
    }
  }

  async function handleVacuum(): Promise<void> {
    cleanupError = null;
    vacuuming = true;
    try {
      await vacuumDatabase();
    } catch (e) {
      cleanupError = e instanceof Error ? e.message : $t('Compaction failed');
    } finally {
      vacuuming = false;
      confirmingVacuum = false;
    }
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<section class="flex w-full flex-col gap-6 px-4 py-6 md:px-8">
  <header class="flex flex-col gap-2">
    <h1 class="page-title">{$t('System Settings')}</h1>
    <p class="section-desc">
      {$t('Runtime settings that take effect immediately, no restart needed.')}
    </p>
  </header>

  {#if error}
    <p class="alert-error" role="alert">{error}</p>
  {/if}

  {#if data.settings}
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <h2 class="section-header">{$t('Traffic controls')}</h2>
        <p class="section-desc">{$t('Routing, limits, queues, and request shaping.')}</p>
      </div>

      <section class="card flex flex-col gap-4 text-sm">
        <h3 class="text-base font-semibold text-slate-900">{$t('Routing')}</h3>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label class="flex flex-col gap-1">
            <span class="font-medium">{$t('Default fallback lane')}</span>
            <select
              data-testid="default-lane"
              class="select min-h-11 w-40 md:min-h-0"
              bind:value={form.default_lane}
            >
              {#each laneOptions as name (name)}
                <option value={name}>{name}</option>
              {/each}
            </select>
            <span class="field-help"
              >{$t(
                'Where a request lands when the classifier cannot decide or nothing else matches. Complexity tiers (simple/medium/complex) are unaffected. Defaults to balanced.',
              )}</span
            >
          </label>

          <label class="flex flex-col gap-1">
            <span class="font-medium">{$t('Visual context compression')}</span>
            <select
              data-testid="visual-context-compression"
              class="select min-h-11 w-44 md:min-h-0"
              bind:value={form.visual_context_compression}
            >
              {#each VISUAL_CONTEXT_COMPRESSION_OPTIONS as mode (mode)}
                <option value={mode}>{mode}</option>
              {/each}
            </select>
            <span class="field-help"
              >{$t(
                'Off by default. Observe records would-apply telemetry without changing requests.',
              )}</span
            >
          </label>
        </div>
      </section>

      <section class="card flex flex-col gap-3 text-sm">
        <h3 class="text-base font-semibold text-slate-900">{$t('Rate limiting')}</h3>

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

        <div class="grid grid-cols-1 gap-3 border-l-2 border-slate-100 pl-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1">
            <span class="font-medium">{$t('Default requests per minute (RPM)')}</span>
            <input
              type="number"
              min="0"
              step="1"
              data-testid="rate-limit-default-rpm"
              class="input-sm min-h-11 w-32 md:min-h-0"
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
              class="input-sm min-h-11 w-32 md:min-h-0"
              bind:value={form.rate_limit_default_tpm}
            />
          </label>
        </div>
        <span class="field-help"
          >{$t(
            'The fallback limit for any key without its own per-key value. 0 means unlimited.',
          )}</span
        >
      </section>

      <section class="card flex flex-col gap-4 text-sm">
        <h3 class="text-base font-semibold text-slate-900">{$t('Request queueing')}</h3>

        <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div class="flex flex-col gap-3">
            <label class="flex items-start gap-3">
              <input
                type="checkbox"
                data-testid="concurrency-queue-enabled"
                class="checkbox mt-0.5"
                bind:checked={form.concurrency_queue_enabled}
              />
              <span>
                <span class="font-medium"
                  >{$t('Queue requests over a key’s concurrency limit')}</span
                >
                <span class="field-help block"
                  >{$t(
                    'When an API key exceeds its max concurrent requests, extra requests wait in line instead of being rejected immediately. Suits agents that fire parallel tool calls.',
                  )}</span
                >
              </span>
            </label>

            <div class="grid grid-cols-1 gap-3 border-l-2 border-slate-100 pl-3 sm:grid-cols-3">
              <label class="flex flex-col gap-1">
                <span class="font-medium">{$t('Minimum queue size')}</span>
                <input
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  data-testid="concurrency-queue-min-size"
                  class="input-sm min-h-11 w-32 md:min-h-0"
                  bind:value={form.concurrency_queue_min_size}
                />
                <span class="field-help"
                  >{$t('Fixed lower bound on how many requests may wait.')}</span
                >
              </label>
              <label class="flex flex-col gap-1">
                <span class="font-medium">{$t('Queue size multiplier')}</span>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  data-testid="concurrency-queue-multiplier"
                  class="input-sm min-h-11 w-32 md:min-h-0"
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
                  class="input-sm min-h-11 w-32 md:min-h-0"
                  bind:value={form.concurrency_queue_wait_timeout_ms}
                />
                <span class="field-help">{$t('Waiting longer than this returns 429.')}</span>
              </label>
            </div>
          </div>

          <div class="flex flex-col gap-3">
            <label class="flex items-start gap-3">
              <input
                type="checkbox"
                data-testid="user-message-queue-enabled"
                class="checkbox mt-0.5"
                bind:checked={form.user_message_queue_enabled}
              />
              <span>
                <span class="font-medium"
                  >{$t('Serialize user messages per subscription account')}</span
                >
                <span class="field-help block"
                  >{$t(
                    'Runs user-message requests to the same OAuth account one at a time with a minimum gap, to avoid tripping upstream rate limits. Tool results and assistant continuations are never queued.',
                  )}</span
                >
              </span>
            </label>

            <div class="grid grid-cols-1 gap-3 border-l-2 border-slate-100 pl-3 sm:grid-cols-2">
              <label class="flex flex-col gap-1">
                <span class="font-medium">{$t('Gap between requests (ms)')}</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="50"
                  data-testid="user-message-queue-delay"
                  class="input-sm min-h-11 w-32 md:min-h-0"
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
                  class="input-sm min-h-11 w-32 md:min-h-0"
                  bind:value={form.user_message_queue_wait_timeout_ms}
                />
                <span class="field-help">{$t('Waiting longer than this returns 503.')}</span>
              </label>
            </div>
          </div>
        </div>
      </section>
    </div>

    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <h2 class="section-header">{$t('Observability')}</h2>
        <p class="section-desc">{$t('Logs and captured request detail.')}</p>
      </div>

      <section class="card flex flex-col gap-3 text-sm">
        <h3 class="text-base font-semibold text-slate-900">{$t('Logging')}</h3>

        <div class="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
          <label class="flex flex-col gap-1">
            <span class="font-medium">{$t('Log level')}</span>
            <select
              data-testid="log-level"
              class="select min-h-11 w-40 md:min-h-0"
              bind:value={form.log_level}
            >
              {#each LOG_LEVEL_OPTIONS as level (level)}
                <option value={level}>{level}</option>
              {/each}
            </select>
            <span class="field-help">{$t('How much detail the gateway writes to its logs.')}</span>
          </label>

          <div class="flex flex-col gap-3">
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

            <label class="flex flex-col gap-1 border-l-2 border-slate-100 pl-3">
              <span class="font-medium">{$t('Keep recorded bodies for (days)')}</span>
              <input
                type="number"
                min="1"
                max="3650"
                data-testid="retention-days"
                class="input-sm min-h-11 w-32 md:min-h-0"
                bind:value={form.payload_retention_days}
              />
              <span class="field-help">{$t('Older bodies are deleted automatically.')}</span>
            </label>
          </div>
        </div>
      </section>
    </div>

    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <h2 class="section-header">{$t('Data retention & cleanup')}</h2>
        <p class="section-desc">
          {$t(
            'A scheduled sweep deletes old data per the windows below. Training/audit data is archived to a compressed file before deletion; you can download those archives or clean up immediately.',
          )}
        </p>
      </div>

      <section class="card flex flex-col gap-3 text-sm">
        <h3 class="text-base font-semibold text-slate-900">{$t('Cleanup schedule')}</h3>

        <label class="flex items-start gap-3">
          <input
            type="checkbox"
            data-testid="cleanup-enabled"
            class="checkbox mt-0.5"
            bind:checked={form.cleanup_enabled}
          />
          <span>
            <span class="font-medium">{$t('Enable automatic cleanup')}</span>
            <span class="field-help block"
              >{$t('Master switch. When off, nothing is deleted automatically.')}</span
            >
          </span>
        </label>

        <div class="grid grid-cols-1 gap-4 border-l-2 border-slate-100 pl-3 md:grid-cols-2">
          <label class="flex flex-col gap-1">
            <span class="font-medium">{$t('Run every (hours)')}</span>
            <input
              type="number"
              min="1"
              max="168"
              step="1"
              data-testid="cleanup-interval-hours"
              class="input-sm min-h-11 w-32 md:min-h-0"
              bind:value={form.cleanup_interval_hours}
            />
            <span class="field-help">{$t('Interval changes take effect on the next restart.')}</span
            >
          </label>
          <label class="flex items-start gap-3 self-end pb-1">
            <input
              type="checkbox"
              data-testid="cleanup-archive-enabled"
              class="checkbox mt-0.5"
              bind:checked={form.cleanup_archive_enabled}
            />
            <span class="font-medium">{$t('Archive before deleting')}</span>
          </label>
        </div>

        <div class="grid grid-cols-1 gap-4 border-l-2 border-slate-100 pl-3 md:grid-cols-2">
          <label class="flex items-start gap-3">
            <input
              type="checkbox"
              data-testid="vacuum-enabled"
              class="checkbox mt-0.5"
              bind:checked={form.vacuum_enabled}
            />
            <span>
              <span class="font-medium">{$t('Compact database automatically')}</span>
              <span class="field-help block"
                >{$t(
                  'Runs VACUUM once a day to reclaim deleted disk space. The database is briefly locked while it runs.',
                )}</span
              >
            </span>
          </label>
          <label class="flex flex-col gap-1 self-end">
            <span class="font-medium">{$t('Run at hour (0-23, server local time)')}</span>
            <input
              type="number"
              min="0"
              max="23"
              step="1"
              data-testid="vacuum-hour"
              class="input-sm min-h-11 w-32 md:min-h-0"
              bind:value={form.vacuum_hour}
              disabled={!form.vacuum_enabled}
            />
          </label>
        </div>
      </section>

      <section class="card flex flex-col gap-3 text-sm">
        <h3 class="text-base font-semibold text-slate-900">{$t('Retention windows')}</h3>

        <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <label class="flex flex-wrap items-center gap-2 border-l-2 border-slate-100 pl-3">
            <input type="checkbox" class="checkbox" bind:checked={form.telemetry_cleanup_enabled} />
            <span class="font-medium">{$t('Decision records (routing/cost telemetry)')}</span>
            <input
              type="number"
              min="1"
              max="3650"
              class="input-sm min-h-11 w-24 md:min-h-0"
              bind:value={form.telemetry_retention_days}
            />
            <span class="field-help">{$t('days · archived')}</span>
          </label>

          <label class="flex flex-wrap items-center gap-2 border-l-2 border-slate-100 pl-3">
            <input type="checkbox" class="checkbox" bind:checked={form.payloads_cleanup_enabled} />
            <span class="font-medium">{$t('Full request/response bodies')}</span>
            <span class="field-help"
              >{$t('uses the “keep bodies for” window above · archived')}</span
            >
          </label>

          <label class="flex flex-wrap items-center gap-2 border-l-2 border-slate-100 pl-3">
            <input
              type="checkbox"
              class="checkbox"
              bind:checked={form.memory_messages_cleanup_enabled}
            />
            <span class="font-medium">{$t('Raw conversation messages')}</span>
            <input
              type="number"
              min="1"
              max="3650"
              class="input-sm min-h-11 w-24 md:min-h-0"
              bind:value={form.memory_messages_retention_days}
            />
            <span class="field-help">{$t('days · archived · highest training value (opt-in)')}</span
            >
          </label>

          <label class="flex flex-wrap items-center gap-2 border-l-2 border-slate-100 pl-3">
            <input
              type="checkbox"
              class="checkbox"
              bind:checked={form.oauth_usage_cleanup_enabled}
            />
            <span class="font-medium">{$t('OAuth usage counters')}</span>
            <input
              type="number"
              min="1"
              max="3650"
              class="input-sm min-h-11 w-24 md:min-h-0"
              bind:value={form.oauth_usage_retention_days}
            />
            <span class="field-help">{$t('days · deleted')}</span>
          </label>

          <label class="flex flex-wrap items-center gap-2 border-l-2 border-slate-100 pl-3">
            <input
              type="checkbox"
              class="checkbox"
              bind:checked={form.memory_jobs_cleanup_enabled}
            />
            <span class="font-medium">{$t('Finished memory jobs')}</span>
            <input
              type="number"
              min="1"
              max="3650"
              class="input-sm min-h-11 w-24 md:min-h-0"
              bind:value={form.memory_jobs_retention_days}
            />
            <span class="field-help">{$t('days · deleted')}</span>
          </label>

          <label class="flex flex-wrap items-center gap-2 border-l-2 border-slate-100 pl-3">
            <input
              type="checkbox"
              class="checkbox"
              bind:checked={form.memory_derived_cleanup_enabled}
            />
            <span class="font-medium">{$t('Derived memory (observations & facts)')}</span>
            <input
              type="number"
              min="1"
              max="3650"
              class="input-sm min-h-11 w-24 md:min-h-0"
              bind:value={form.memory_derived_retention_days}
            />
            <span class="field-help">{$t('days · deleted (opt-in)')}</span>
          </label>
        </div>

        <p class="field-help">
          {$t('Cleanup settings are saved with the “Save settings” button below.')}
        </p>
      </section>
    </div>

    <div class="card-actions border-t-0 pt-0">
      {#if saved}
        <span class="badge-ok" role="status">{$t('Saved')}</span>
      {/if}
      <button class="btn-primary" onclick={handleSave} disabled={saving || !data.settings}>
        {$t('Save settings')}
      </button>
    </div>

    <section class="card flex flex-col gap-3 text-sm">
      <h2 class="section-header">{$t('Maintenance actions')}</h2>
      <p class="field-help">
        {$t('These actions run immediately and do not wait for Save settings.')}
      </p>

      {#if cleanupError}
        <p class="alert-error" role="alert">{cleanupError}</p>
      {/if}

      <div class="flex flex-wrap items-center gap-3">
        <button
          class="btn-secondary"
          data-testid="cleanup-run-now"
          onclick={() => (confirmingClean = true)}
          disabled={cleaning}
        >
          {cleaning ? $t('Cleaning…') : $t('Clean now')}
        </button>
        <button
          class="btn-secondary"
          data-testid="cleanup-vacuum"
          onclick={() => (confirmingVacuum = true)}
          disabled={vacuuming}
        >
          {vacuuming ? $t('Compacting…') : $t('Compact database')}
        </button>
        <span class="field-help"
          >{$t(
            '“Clean now” runs immediately; “Compact database” reclaims disk (briefly locks).',
          )}</span
        >
      </div>

      {#if lastRun}
        <div class="rounded border border-slate-100 p-3 text-xs">
          <div class="font-medium">
            {$t('Last run')}: {formatTimestamp(new Date(lastRun.finishedAtMs).toISOString())}
            · {lastRun.trigger}
            · {lastRun.ok ? $t('ok') : $t('with errors')}
          </div>
          <ul class="mt-1 flex flex-col gap-0.5">
            {#each lastRun.tables as row (row.table)}
              <li>
                <span class="font-mono">{row.table}</span>:
                {#if row.skipped}
                  {$t('skipped')}{row.error ? ` (${row.error})` : ''}
                {:else}
                  {row.deletedRows}
                  {$t('deleted')}{row.archived ? `, ${row.archivedRows} ${$t('archived')}` : ''}
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if archives.length > 0}
        <div class="flex flex-col gap-1 text-xs">
          <span class="font-medium">{$t('Archives')}</span>
          <ul class="flex flex-col gap-0.5">
            {#each archives as a (a.runId + a.file)}
              <li class="flex flex-wrap items-center gap-2">
                <a class="link" href={archiveDownloadUrl(a)} download>{a.runId}/{a.file}</a>
                <span class="field-help"
                  >{formatBytes(a.bytes)} · {formatTimestamp(
                    new Date(a.modifiedMs).toISOString(),
                  )}</span
                >
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </section>

    {#if confirmingClean}
      <Modal
        label={$t('Clean now')}
        onclose={() => (confirmingClean = false)}
        dismissible={!cleaning}
      >
        <h2 class="section-header">{$t('Run cleanup now?')}</h2>
        <p class="mt-2 text-sm text-amber-800">
          {$t(
            'This deletes old data immediately using the retention windows above. Categories set to archive are saved to a compressed file first, but the deletion itself cannot be undone.',
          )}
        </p>
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="btn-secondary"
            disabled={cleaning}
            onclick={() => (confirmingClean = false)}>{$t('Cancel')}</button
          >
          <button type="button" class="btn-primary" disabled={cleaning} onclick={handleCleanNow}>
            {cleaning ? $t('Cleaning…') : $t('Clean now')}
          </button>
        </div>
      </Modal>
    {/if}

    {#if confirmingVacuum}
      <Modal
        label={$t('Compact database')}
        onclose={() => (confirmingVacuum = false)}
        dismissible={!vacuuming}
      >
        <h2 class="section-header">{$t('Compact database now?')}</h2>
        <p class="mt-2 text-sm text-amber-800">
          {$t(
            'This runs VACUUM to reclaim disk space. The database is briefly locked while it runs, so in-flight requests may pause until it finishes.',
          )}
        </p>
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="btn-secondary"
            disabled={vacuuming}
            onclick={() => (confirmingVacuum = false)}>{$t('Cancel')}</button
          >
          <button type="button" class="btn-primary" disabled={vacuuming} onclick={handleVacuum}>
            {vacuuming ? $t('Compacting…') : $t('Compact database')}
          </button>
        </div>
      </Modal>
    {/if}
  {/if}
</section>
