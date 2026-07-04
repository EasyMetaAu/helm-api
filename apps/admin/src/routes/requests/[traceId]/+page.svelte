<script lang="ts">
  import { base } from '$app/paths';
  import { invalidateAll } from '$app/navigation';
  import type { RequestDetail, RequestPayloadView } from '$lib/api/requests.js';
  import { deepEqual } from '$lib/deep-equal.js';
  import { attemptCodeLabel } from '$lib/format/attempt-codes.js';
  import { formatTimestamp, formatTps } from '$lib/format.js';
  import { t } from '$lib/i18n';
  import CostBreakdown from '$lib/components/CostBreakdown.svelte';
  import DecisionChain from '$lib/components/DecisionChain.svelte';
  import TokenUsage from '$lib/components/TokenUsage.svelte';
  import ImagePreview from '$lib/components/ImagePreview.svelte';
  import { type CollectedImage, collectImages } from '$lib/components/imageData';
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
      backTo?: string;
      loadError?: string;
    };
  } = $props();

  // Return to the originating list (carries its filters/page via the loader's
  // `from`); falls back to the bare list when opened directly / via a stale link.
  const backTo = $derived(data.backTo ?? `${base}/requests`);

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

  // The forwarded-upstream body is worth a SEPARATE panel only when it actually
  // differs from the inbound client body (memory injection / protocol translation /
  // model patch). When they are structurally identical — e.g. a no-memory request to
  // an OpenAI-shaped provider — a second panel is pure noise, so we collapse to one.
  const hasUpstream = $derived(
    data.payload?.captured === true && data.payload?.upstream_request != null,
  );
  const upstreamDiffers = $derived(
    hasUpstream && !deepEqual(data.payload.request, data.payload.upstream_request),
  );

  // Media overview: every image in this call surfaced up front, so an operator sees
  // the pictures SENT and GENERATED without expanding a JSON tree to a deep base64
  // leaf. `collectImages` walks the parsed body (handles OpenAI `image_url` data:
  // URLs, Anthropic `source.data`, Gemini `inlineData.data`); a streamed SSE response
  // is a raw string and yields nothing (still shown by StreamViewer below). De-duped
  // by URL so the upstream copy of an inbound image never doubles it. The JSON tree
  // and its in-tree "View image" button are untouched — this is the separate,
  // scan-at-a-glance overview the panels themselves no longer carry.
  function dedupeByUrl(imgs: CollectedImage[]): CollectedImage[] {
    const seen = new Set<string>();
    const out: CollectedImage[] = [];
    for (const img of imgs) {
      if (seen.has(img.url)) continue;
      seen.add(img.url);
      out.push(img);
    }
    return out;
  }
  const requestImages = $derived(
    data.payload?.captured === true
      ? dedupeByUrl([
          ...collectImages(data.payload.request),
          ...(upstreamDiffers ? collectImages(data.payload.upstream_request) : []),
        ])
      : [],
  );
  const responseImages = $derived(
    data.payload?.captured === true ? collectImages(data.payload.response) : [],
  );
  const mediaGroups = $derived(
    [
      { label: $t('Request'), images: requestImages },
      { label: $t('Response'), images: responseImages },
    ].filter((g) => g.images.length > 0),
  );
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <a href={backTo} data-testid="back-to-requests" class="link-inline text-sm"
    >&larr; {$t('Back to requests')}</a
  >

  {#if !data.detail}
    <div data-testid="detail-error" role="alert" class="alert-error text-center">
      <p class="font-medium">{$t('Could not load this request.')}</p>
      <p class="mt-1">{data.loadError ?? $t('The trace may not exist or has expired.')}</p>
      <button
        type="button"
        data-testid="detail-retry"
        class="btn-secondary mt-3"
        onclick={() => invalidateAll()}>{$t('Retry')}</button
      >
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
      <div class="flex flex-wrap items-center gap-2">
        <code
          class="basis-full rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700 md:basis-auto"
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

    <!-- Request summary: identity + routing at a glance (the same fields as the list
         row) so an operator can read/copy WHO called and WHAT was asked without
         bouncing back to the list. Key/prefix only — never the plaintext key
         (Principle 7); each value degrades to an em-dash, never blank/fabricated. -->
    <section data-testid="request-summary" class="card text-sm">
      <h2 class="section-header">{$t('Request summary')}</h2>
      <dl class="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3 lg:grid-cols-4">
        <div>
          <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Key')}</dt>
          <dd class="mt-0.5 text-ink-body">
            {#if d.key_name}
              <span class="text-ink-strong">{d.key_name}</span>
              {#if d.key_prefix}
                <code class="ml-1 font-mono text-xs text-ink-muted">{d.key_prefix}</code>
              {/if}
            {:else if d.key_prefix}
              <code class="font-mono text-ink-strong">{d.key_prefix}</code>
            {:else}
              —
            {/if}
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Status')}</dt>
          <dd class="mt-0.5">
            {#if d.status === 'error'}
              <span class="badge-error">{$t('error')}</span>
            {:else}
              <span class="badge-ok">{$t('ok')}</span>
            {/if}
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Provider')}</dt>
          <dd class="mt-0.5 font-mono text-ink-body">{d.served_provider ?? '—'}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-slate-400">
            {$t('Subscription account')}
          </dt>
          <dd
            class="mt-0.5 font-mono text-ink-body"
            title={d.serving_account
              ? `${d.serving_account.provider_id}/${d.serving_account.account}`
              : undefined}
          >
            {d.serving_account?.account ?? '—'}
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Served model')}</dt>
          <dd class="mt-0.5 font-mono text-ink-body">{d.final_model ?? '—'}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Requested model')}</dt>
          <dd class="mt-0.5 font-mono text-ink-body">{d.requested_model ?? '—'}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Lane')}</dt>
          <dd class="mt-0.5 text-ink-body">{d.lane || '—'}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Latency')}</dt>
          <dd class="mt-0.5 font-mono text-ink-body">
            {d.latency_ms === null ? '—' : `${d.latency_ms}ms`}
          </dd>
        </div>
      </dl>
    </section>

    <!-- Media overview: one scan-at-a-glance gallery of every image in this call —
         sent (request) and generated (response) — so the operator never has to expand
         a JSON tree to find a picture. Rendered only when at least one image exists. -->
    {#if mediaGroups.length > 0}
      <section data-testid="media-overview" class="card text-sm">
        <h2 class="section-header">{$t('Images')}</h2>
        <p class="field-help mb-3">
          {$t(
            'All images sent in the request and returned in the response — click any to view full size.',
          )}
        </p>
        <div class="flex flex-col gap-4">
          {#each mediaGroups as group (group.label)}
            <div data-testid="media-group">
              <p class="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
                {group.label}
              </p>
              <div class="flex flex-wrap gap-3">
                {#each group.images as img (img.url)}
                  <ImagePreview
                    src={img.url}
                    label={`${group.label} · ${img.path}`}
                    variant="thumb"
                  />
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Request: full captured body when capture_payloads is on, else metadata. -->
    <section class="card text-sm">
      <h2 class="section-header">
        {upstreamDiffers ? $t('Request (from client)') : $t('Request')}
      </h2>
      {#if data.payload?.captured}
        <p class="field-help mb-2">
          {#if upstreamDiffers}
            {$t(
              'The request body as received from the client — before memory injection and translation.',
            )}
          {:else if hasUpstream}
            {$t(
              'Full request body recorded for this call. The body forwarded upstream was identical (no memory injection or translation).',
            )}
          {:else}
            {$t('Full request body recorded for this call.')}
          {/if}
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

    <!-- Forwarded upstream request: the EXACT body sent to the provider, AFTER
         memory injection + protocol translation. Shown as a SEPARATE panel only when
         it differs from the inbound body; when identical, the single "Request" panel
         above already covers it (no duplicate). -->
    {#if upstreamDiffers}
      <section class="card text-sm">
        <h2 class="section-header">{$t('Forwarded to upstream LLM')}</h2>
        <p class="field-help mb-2">
          {$t(
            'The exact request sent to the provider — after memory injection and protocol translation. This is what the model actually received.',
          )}
        </p>
        <JsonViewer value={data.payload.upstream_request} testid="upstream-request-body" />
      </section>
    {/if}

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

    <!-- Throughput: true TPS + its denominator (generation window) + the companion
         time-to-first-token. All '—' for a non-streaming response (no measurable
         generation window), distinct from a measured 0. -->
    <section class="card">
      <h2 class="section-header">{$t('Throughput')}</h2>
      <p class="field-help mb-2">
        {$t(
          'How fast the response was generated — output tokens per second, the generation window, and the time to the first token. Measured only for streamed responses.',
        )}
      </p>
      <dl data-testid="throughput" class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <dt class="text-ink-muted">{$t('TPS')}</dt>
        <dd data-testid="tps" class="text-right font-mono text-ink-strong">{formatTps(d.tps)}</dd>

        <dt class="text-ink-muted">{$t('Time to first token')}</dt>
        <dd data-testid="ttfb" class="text-right font-mono text-ink-strong">
          {d.ttfb_ms === null ? '—' : `${d.ttfb_ms}ms`}
        </dd>

        <dt class="text-ink-muted">{$t('Generation time')}</dt>
        <dd data-testid="generation-ms" class="text-right font-mono text-ink-strong">
          {d.generation_ms === null ? '—' : `${d.generation_ms}ms`}
        </dd>
      </dl>
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
        <div>
          {$t('Error type')}:
          <span title={d.error.error_class}>{$t(attemptCodeLabel(d.error.error_class))}</span>
        </div>
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
