<script lang="ts">
  import { base } from '$app/paths';
  import type { RequestDetail, RequestPayloadView } from '$lib/api/requests.js';
  import { t } from '$lib/i18n';
  import CostBreakdown from '$lib/components/CostBreakdown.svelte';
  import DecisionChain from '$lib/components/DecisionChain.svelte';

  // Request detail (docs/07 详情). READ-ONLY consumer — renders the recorded trail
  // and recomputes nothing (原则1). When capture_payloads is on, the full request +
  // response bodies are shown; when off, a clear "not recorded" notice. The key
  // never appears in plaintext (it lives in the Authorization header, not the body).
  // 原则5: classification vs execution fallback stay separate (DecisionChain).
  let {
    data,
  }: {
    data: {
      detail: RequestDetail | null;
      payload: RequestPayloadView;
      traceId: string;
      loadError?: string;
    };
  } = $props();

  let copied = $state(false);

  async function copyTrace(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(data.traceId);
      copied = true;
    } catch {
      // clipboard unavailable — degrade silently, never surface secrets in errors
    }
  }

  // Pretty-print a captured body: a parsed JSON object/array → indented JSON; a
  // raw string (e.g. assembled SSE for a stream) → shown verbatim.
  function show(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <a href={`${base}/requests`} class="link-inline text-sm">&larr; {$t('Back to requests')}</a>

  {#if !data.detail}
    <div data-testid="detail-error" role="alert" class="alert-error text-center">
      <p class="font-medium">{$t('Could not load this request.')}</p>
      <p class="mt-1">{data.loadError ?? $t('The trace may not exist or has expired.')}</p>
    </div>
  {:else}
    {@const d = data.detail}
    <header class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 class="page-title">{$t('Request trail')}</h1>
        <p class="section-desc">
          {$t('Follow how this request was classified, routed, and billed — step by step.')}
        </p>
        <p class="mt-1 text-sm text-ink-muted">{d.ts || $t('time not recorded')}</p>
      </div>
      <div class="flex items-center gap-2">
        <code class="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700"
          >{d.trace_id}</code
        >
        <button type="button" data-testid="copy-trace" class="btn-secondary" onclick={copyTrace}
          >{copied ? $t('Copied') : $t('Copy trace ID')}</button
        >
      </div>
    </header>

    <!-- Request: full captured body when capture_payloads is on, else metadata. -->
    <section class="card text-sm">
      <h2 class="section-header">{$t('Request')}</h2>
      {#if data.payload?.captured}
        <p class="field-help mb-2">
          {$t('Full request body recorded for this call.')}
        </p>
        <pre
          data-testid="request-body"
          class="max-h-96 overflow-auto rounded bg-slate-50 p-2 text-xs text-slate-700">{show(
            data.payload.request,
          )}</pre>
      {:else}
        <p class="field-help mb-2">
          {$t('Request metadata recorded for this call (redacted — no message content or secrets).')}
        </p>
        <pre class="overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-700">{JSON.stringify(
            d.request_meta,
            null,
            2,
          )}</pre>
        <p data-testid="payload-summary" class="mt-2 italic text-ink-muted">
          {$t('Full request/response not recorded (payload capture was off for this request).')}
        </p>
      {/if}
    </section>

    <!-- Decision chain (classification -> eval -> policy -> lanes -> attempts) -->
    <DecisionChain detail={d} />

    <!-- Cost breakdown incl. eval self-cost -->
    <section class="card">
      <h2 class="section-header">{$t('Cost')}</h2>
      <p class="field-help mb-2">
        {$t('What this single request cost, split across routing, optional eval, and completion.')}
      </p>
      <CostBreakdown cost={d.cost_breakdown} />
    </section>

    <!-- Final response meta or structured error -->
    {#if d.error}
      <section data-testid="request-error" role="alert" class="alert-error text-sm">
        <h2 class="section-header text-red-700">{$t('Error')}</h2>
        <p class="field-help mb-2 text-red-600">
          {$t(
            'This request ended in an error after all attempts. Details below are recorded as-is.',
          )}
        </p>
        <div>{$t('Error type')}: <span class="font-mono">{d.error.error_class}</span></div>
        <div>{$t('HTTP status')}: <span class="font-mono">{d.error.http_status}</span></div>
        <div>{$t('Message')}: {d.error.message}</div>
        <div class="mt-1 text-xs text-red-500">
          {$t('Raw provider response')}: {d.error.provider_raw === null
            ? $t('redacted')
            : JSON.stringify(d.error.provider_raw)}
        </div>
      </section>
    {:else if data.payload?.captured && data.payload?.response != null}
      <section class="card text-sm">
        <h2 class="section-header">{$t('Response')}</h2>
        <p class="field-help mb-2">{$t('Full response body recorded for this call.')}</p>
        <pre
          data-testid="response-body"
          class="max-h-96 overflow-auto rounded bg-slate-50 p-2 text-xs text-slate-700">{show(
            data.payload.response,
          )}</pre>
      </section>
    {:else if d.response_meta}
      <section class="card text-sm">
        <h2 class="section-header">{$t('Response')}</h2>
        <p class="field-help mb-2">
          {$t('Response metadata recorded for this call (redacted — no message content).')}
        </p>
        <pre class="overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-700">{JSON.stringify(
            d.response_meta,
            null,
            2,
          )}</pre>
      </section>
    {/if}
  {/if}
</section>
