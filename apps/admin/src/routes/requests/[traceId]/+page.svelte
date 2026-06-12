<script lang="ts">
  import { base } from '$app/paths';
  import type { RequestDetail, RequestPayloadView } from '$lib/api/requests.js';
  import { formatTimestamp } from '$lib/format.js';
  import { t } from '$lib/i18n';
  import CostBreakdown from '$lib/components/CostBreakdown.svelte';
  import DecisionChain from '$lib/components/DecisionChain.svelte';
  import TokenUsage from '$lib/components/TokenUsage.svelte';
  import JsonViewer from '$lib/components/JsonViewer.svelte';
  import RetryDialog from '$lib/components/RetryDialog.svelte';
  import StreamViewer from '$lib/components/StreamViewer.svelte';
  import { isSseStream } from '$lib/sse';

  // Request detail (docs/07 detail). READ-ONLY consumer — renders the recorded trail
  // and recomputes nothing (Principle 1). When capture_payloads is on, the full request +
  // response bodies are shown; when off, a clear "not recorded" notice. The key
  // never appears in plaintext (it lives in the Authorization header, not the body).
  // Principle 5: classification vs execution fallback stay separate (DecisionChain).
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
  let showRetry = $state(false);

  async function copyTrace(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(data.traceId);
      copied = true;
    } catch {
      // clipboard unavailable — degrade silently, never surface secrets in errors
    }
  }

  // Retry is available whenever the full request body was captured (any of the four
  // protocols — OpenAI chat `messages[]`, Anthropic `messages[]`, Responses `input`,
  // Gemini `contents[]`). The server recovers the original protocol and re-issues in
  // its NATIVE shape, returning a precise 400 if a body genuinely can't be replayed —
  // so the client doesn't enumerate shapes here (that would wrongly disable e.g. a
  // string-`input` Responses body). Disabled only when nothing was captured (capture
  // off, or the payload was pruned).
  const replayBody = $derived(data.payload?.captured === true ? data.payload.request : undefined);
  const canRetry = $derived(!!replayBody && typeof replayBody === 'object');
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
        <p class="mt-1 text-sm text-ink-muted">
          {formatTimestamp(d.ts) || $t('time not recorded')}
        </p>
      </div>
      <div class="flex items-center gap-2">
        <code class="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700"
          >{d.trace_id}</code
        >
        <button type="button" data-testid="copy-trace" class="btn-secondary" onclick={copyTrace}
          >{copied ? $t('Copied') : $t('Copy trace ID')}</button
        >
        <button
          type="button"
          data-testid="retry-request"
          class="btn-primary"
          disabled={!canRetry}
          title={canRetry ? '' : $t('Retry unavailable — no captured request body.')}
          onclick={() => (showRetry = true)}>{$t('Retry')}</button
        >
      </div>
    </header>

    {#if showRetry && canRetry}
      <RetryDialog
        traceId={d.trace_id}
        initialRequest={replayBody}
        onclose={() => (showRetry = false)}
      />
    {/if}

    <!-- Request: full captured body when capture_payloads is on, else metadata. -->
    <section class="card text-sm">
      <h2 class="section-header">{$t('Request')}</h2>
      {#if data.payload?.captured}
        <p class="field-help mb-2">
          {$t('Full request body recorded for this call.')}
        </p>
        <JsonViewer value={data.payload.request} testid="request-body" />
      {:else}
        <p class="field-help mb-2">
          {$t(
            'Request metadata recorded for this call (redacted — no message content or secrets).',
          )}
        </p>
        <JsonViewer value={d.request_meta} />
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

    <!-- Token usage: input / output / cached / non-cached split for this request -->
    <section class="card">
      <h2 class="section-header">{$t('Token usage')}</h2>
      <p class="field-help mb-2">
        {$t('How many tokens this single request used — input, output, and how much was cached.')}
      </p>
      <TokenUsage usage={d.usage} />
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
        {#if isSseStream(data.payload.response)}
          <!-- Streaming call: the stored body is the raw SSE wire text. Render it
               stream-aware (assembled final message / per-chunk table / raw). -->
          <p class="field-help mb-2">
            {$t('Streaming response — assembled from the recorded SSE stream.')}
          </p>
          <StreamViewer raw={data.payload.response} testid="response-body" />
        {:else}
          <p class="field-help mb-2">{$t('Full response body recorded for this call.')}</p>
          <JsonViewer value={data.payload.response} testid="response-body" />
        {/if}
      </section>
    {:else if d.response_meta}
      <section class="card text-sm">
        <h2 class="section-header">{$t('Response')}</h2>
        <p class="field-help mb-2">
          {$t('Response metadata recorded for this call (redacted — no message content).')}
        </p>
        <JsonViewer value={d.response_meta} />
      </section>
    {/if}
  {/if}
</section>
