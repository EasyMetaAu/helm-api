<script lang="ts">
  import { base } from '$app/paths';
  import type { RequestDetail } from '$lib/api/requests.js';
  import { t } from '$lib/i18n';
  import CostBreakdown from '$lib/components/CostBreakdown.svelte';
  import DecisionChain from '$lib/components/DecisionChain.svelte';

  // Request detail (docs/07 详情). READ-ONLY consumer — renders the recorded trail
  // and recomputes nothing (原则1). 原则7 redaction: payload is shown as a summary
  // placeholder only, provider_raw is redacted, the key never appears in plaintext.
  // 原则5: classification vs execution fallback stay separate (DecisionChain).
  let { data }: { data: { detail: RequestDetail | null; traceId: string; loadError?: string } } =
    $props();

  let copied = $state(false);

  async function copyTrace(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(data.traceId);
      copied = true;
    } catch {
      // clipboard unavailable — degrade silently, never surface secrets in errors
    }
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <a href={`${base}/requests`} class="text-sm text-sky-600 hover:underline"
    >&larr; {$t('Back to requests')}</a
  >

  {#if !data.detail}
    <div
      data-testid="detail-error"
      class="rounded-lg border border-amber-300 bg-amber-50 p-8 text-center text-sm text-amber-800"
    >
      <p class="font-medium">{$t('Could not load this request.')}</p>
      <p class="mt-1">{data.loadError ?? $t('The trace may not exist or has expired.')}</p>
    </div>
  {:else}
    {@const d = data.detail}
    <header class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 class="text-2xl font-semibold text-slate-900">{$t('Request trail')}</h1>
        <p class="text-sm text-slate-500">{d.ts || $t('time not recorded')}</p>
      </div>
      <div class="flex items-center gap-2">
        <code class="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700"
          >{d.trace_id}</code
        >
        <button
          type="button"
          data-testid="copy-trace"
          class="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          onclick={copyTrace}>{copied ? $t('Copied') : $t('Copy trace ID')}</button
        >
      </div>
    </header>

    <!-- Request metadata + redacted payload summary (原则7) -->
    <section class="rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {$t('Request')}
      </h3>
      <pre class="overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-700">{JSON.stringify(
          d.request_meta,
          null,
          2,
        )}</pre>
      <p data-testid="payload-summary" class="mt-2 italic text-slate-500">{d.payload_summary}</p>
    </section>

    <!-- Decision chain (classification -> eval -> policy -> lanes -> attempts) -->
    <DecisionChain detail={d} />

    <!-- Cost breakdown incl. eval self-cost -->
    <section class="rounded-lg border border-slate-200 bg-white p-4">
      <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {$t('Cost')}
      </h3>
      <CostBreakdown cost={d.cost_breakdown} />
    </section>

    <!-- Final response meta or structured error -->
    {#if d.error}
      <section
        data-testid="request-error"
        class="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800"
      >
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-red-600">
          {$t('Error')}
        </h3>
        <div>error_class: <span class="font-mono">{d.error.error_class}</span></div>
        <div>http_status: <span class="font-mono">{d.error.http_status}</span></div>
        <div>message: {d.error.message}</div>
        <div class="mt-1 text-xs text-red-500">
          provider_raw: {d.error.provider_raw === null
            ? $t('redacted')
            : JSON.stringify(d.error.provider_raw)}
        </div>
      </section>
    {:else if d.response_meta}
      <section class="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {$t('Response')}
        </h3>
        <pre class="overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-700">{JSON.stringify(
            d.response_meta,
            null,
            2,
          )}</pre>
      </section>
    {/if}
  {/if}
</section>
