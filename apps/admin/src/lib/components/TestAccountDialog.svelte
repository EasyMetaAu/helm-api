<script lang="ts">
  import { untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { streamAccountTest } from '$lib/api/oauth.js';
  import Modal from '$lib/components/Modal.svelte';
  import { formatDurationMs } from '$lib/format.js';
  import { t } from '$lib/i18n';

  // Per-account connectivity test (providers page "Test" button). Streams a single
  // short completion through ONE subscription account and shows the REAL streamed
  // reply (not a bare "ok"), with a status pill + latency. Pure consumer (Principle
  // 1): all execution is the gateway's; this dialog only POSTs and renders the SSE
  // it streams back. Closing/Stop aborts the in-flight request (not a provider fault).
  let {
    provider,
    providerName,
    account,
    models,
    onclose,
  }: {
    provider: string;
    providerName: string;
    account: string;
    models: string[];
    onclose: () => void;
  } = $props();

  type Status = 'idle' | 'running' | 'success' | 'error';

  // The dialog is remounted per open ({#if testing} in the page), so capturing the
  // first model ONCE at mount is correct (matches EditKeyDialog) — thereafter `model`
  // is the user's selection.
  let model = $state(untrack(() => models[0] ?? ''));
  let prompt = $state('');
  let status = $state<Status>('idle');
  let response = $state('');
  let errorMsg = $state('');
  let durationMs = $state<number | null>(null);
  let controller: AbortController | null = null;

  const running = $derived(status === 'running');
  const canRun = $derived(model.length > 0 && !running);

  async function run(): Promise<void> {
    if (!canRun) return;
    controller?.abort();
    controller = new AbortController();
    status = 'running';
    response = '';
    errorMsg = '';
    durationMs = null;
    const startedAt = performance.now();
    try {
      for await (const ev of streamAccountTest(
        provider,
        { account, model, prompt: prompt.trim() || undefined },
        controller.signal,
      )) {
        if (ev.type === 'content') {
          response += ev.text;
        } else if (ev.type === 'error') {
          status = 'error';
          errorMsg = ev.error;
          void invalidateAll();
        } else if (ev.type === 'done') {
          durationMs = ev.durationMs ?? Math.round(performance.now() - startedAt);
          // A `done` that arrives after an `error` keeps the failed status.
          if (status === 'running') {
            status = 'success';
            void invalidateAll();
          }
        }
      }
      // Stream ended without a terminal event (e.g. an abort) — settle to idle.
      if (status === 'running') status = 'idle';
    } finally {
      controller = null;
    }
  }

  function stop(): void {
    controller?.abort();
    controller = null;
    if (status === 'running') status = 'idle';
  }

  function close(): void {
    controller?.abort();
    onclose();
  }
</script>

<Modal label={$t('Test connection')} onclose={close} dismissible={!running}>
  <h2 class="section-header">{$t('Test connection')}</h2>
  <p class="section-desc mt-1">
    {$t('Send a short message through this account and stream the reply.')}
  </p>

  <div class="mt-3 flex flex-col gap-3">
    <!-- Which account is under test (read-only context). -->
    <div class="flex items-baseline gap-4 text-sm">
      <div class="flex flex-col gap-1">
        <span class="field-label">{$t('Provider')}</span>
        <span class="text-ink-body">{providerName}</span>
      </div>
      <div class="flex flex-col gap-1">
        <span class="field-label">{$t('Account')}</span>
        <code class="font-mono text-xs text-ink-strong">{account}</code>
      </div>
    </div>

    {#if models.length === 0}
      <p class="alert-warn">{$t('No routable models for this account.')}</p>
    {:else}
      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Model')}</span>
        <select class="input" bind:value={model} disabled={running}>
          {#each models as m (m)}
            <option value={m}>{m}</option>
          {/each}
        </select>
      </label>
    {/if}

    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t('Message')}</span>
      <input
        type="text"
        class="input"
        placeholder={$t('Optional')}
        bind:value={prompt}
        disabled={running}
      />
    </label>

    <!-- Result: status pill + latency + live char count, then the streamed reply. -->
    <div class="flex flex-col gap-1">
      <div class="flex items-center justify-between text-xs">
        <span class="flex items-center gap-2">
          {#if status === 'idle'}
            <span class="text-ink-muted">{$t('Ready')}</span>
          {:else if status === 'running'}
            <span class="badge-neutral">{$t('Testing…')}</span>
          {:else if status === 'success'}
            <span class="badge-ok">{$t('Success')}</span>
          {:else}
            <span class="badge-error">{$t('Failed')}</span>
          {/if}
          {#if durationMs !== null}
            <span class="text-ink-muted"
              >{$t('Done in {duration}', { duration: formatDurationMs(durationMs) })}</span
            >
          {/if}
        </span>
        <span class="text-ink-muted">{$t('{n} chars', { n: response.length })}</span>
      </div>
      <!-- prettier-ignore -->
      <div
        class="max-h-48 min-h-16 overflow-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs whitespace-pre-wrap text-ink-body"
        data-testid="test-response"
      >{response}{#if running}<span class="animate-pulse">▋</span>{/if}{#if !response && !running}<span class="text-ink-muted">{$t('Waiting for response…')}</span>{/if}</div>
      {#if errorMsg}
        <p class="alert-error" role="alert">{errorMsg}</p>
      {/if}
    </div>
  </div>

  <div class="mt-4 flex justify-end gap-2">
    {#if running}
      <button type="button" class="btn-secondary" onclick={stop}>{$t('Stop')}</button>
    {:else}
      <button type="button" class="btn-secondary" onclick={close}>{$t('Close')}</button>
    {/if}
    <button type="button" class="btn-primary" disabled={!canRun} onclick={run}>
      {running ? $t('Testing…') : $t('Run test')}
    </button>
  </div>
</Modal>
