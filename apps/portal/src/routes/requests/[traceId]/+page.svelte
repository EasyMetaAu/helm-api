<script lang="ts">
  import { base } from "$app/paths";
  import { page } from "$app/stores";
  import {
    getPayloadMeta,
    getPayloadPart,
    getRequestDetail,
    type PayloadMeta,
    type PortalRequestDetail,
  } from "$lib/api/portal";
  import { toTokenUsageView } from "$lib/api/requests";
  import Conversation from "$lib/components/Conversation.svelte";
  import CostBreakdown from "$lib/components/CostBreakdown.svelte";
  import ImagePreview from "$lib/components/ImagePreview.svelte";
  import JsonViewer from "$lib/components/JsonViewer.svelte";
  import StreamViewer from "$lib/components/StreamViewer.svelte";
  import TokenUsage from "$lib/components/TokenUsage.svelte";
  import { t } from "$lib/i18n";
  import { buildMediaGroups } from "$lib/request-detail-media";
  import { isSseStream } from "$lib/sse";

  type PayloadPartName = "request" | "response";
  type PartStatus = "idle" | "loading" | "loaded" | "error";

  const requestId = $derived($page.params.traceId);

  let detail = $state<PortalRequestDetail | null>(null);
  let payloadMeta = $state<PayloadMeta>({ captured: false });
  let payloadValues = $state<Partial<Record<PayloadPartName, unknown>>>({});
  let payloadStatus = $state<Record<PayloadPartName, PartStatus>>({
    request: "idle",
    response: "idle",
  });
  let payloadErrors = $state<Partial<Record<PayloadPartName, string>>>({});
  let loading = $state(true);
  let notFound = $state(false);
  let error = $state("");
  let reqView = $state<"chat" | "raw">("chat");

  function resetPayloadState(): void {
    payloadMeta = { captured: false };
    payloadValues = {};
    payloadStatus = { request: "idle", response: "idle" };
    payloadErrors = {};
  }

  async function load(id: string): Promise<void> {
    loading = true;
    notFound = false;
    error = "";
    detail = null;
    resetPayloadState();
    try {
      const [nextDetail, nextMeta] = await Promise.all([
        getRequestDetail(id),
        getPayloadMeta(id).catch((): PayloadMeta => ({ captured: false })),
      ]);
      if (requestId !== id) return;
      detail = nextDetail;
      payloadMeta = nextMeta;
    } catch (e) {
      if (requestId !== id) return;
      if (e instanceof Error && e.message.includes("404")) notFound = true;
      else error = e instanceof Error ? e.message : "load failed";
    } finally {
      if (requestId === id) loading = false;
    }
  }

  $effect(() => {
    if (requestId) void load(requestId);
  });

  function hasPayloadPart(part: PayloadPartName): boolean {
    return payloadMeta.captured === true && payloadMeta.parts?.[part] === true;
  }

  async function loadPayloadPart(part: PayloadPartName): Promise<unknown> {
    const id = requestId;
    if (!id) return null;
    if (!hasPayloadPart(part)) return null;
    if (payloadStatus[part] === "loaded") return payloadValues[part];
    if (payloadStatus[part] === "loading") return null;

    payloadStatus[part] = "loading";
    payloadErrors[part] = undefined;
    try {
      const result = await getPayloadPart(id, part);
      if (requestId !== id) return null;
      if (result.captured !== true || result.part !== part) {
        payloadStatus[part] = "error";
        payloadErrors[part] = $t("Payload was not available.");
        return null;
      }
      payloadValues[part] = result.value ?? null;
      payloadStatus[part] = "loaded";
      return payloadValues[part];
    } catch (e) {
      if (requestId !== id) return null;
      payloadStatus[part] = "error";
      payloadErrors[part] =
        e instanceof Error ? e.message : $t("Payload was not available.");
      return null;
    }
  }

  async function loadConversation(): Promise<void> {
    await Promise.all([
      loadPayloadPart("request"),
      hasPayloadPart("response")
        ? loadPayloadPart("response")
        : Promise.resolve(null),
    ]);
  }

  const requestLoaded = $derived(payloadStatus.request === "loaded");
  const responseLoaded = $derived(payloadStatus.response === "loaded");
  const mediaGroups = $derived(
    buildMediaGroups(
      requestLoaded ? payloadValues.request : null,
      responseLoaded ? payloadValues.response : null,
    ),
  );

  const costView = $derived(
    detail
      ? {
          cost_breakdown: {
            routing_usd: null,
            eval_usd: null,
            completion_usd: detail.cost_usd,
            total_usd: detail.cost_usd,
          },
        }
      : null,
  );
</script>

<a class="link-inline" href={`${base}/requests`}>← {$t("Back to requests")}</a>

{#if loading}
  <p class="section-desc mt-4">{$t("Loading…")}</p>
{:else if notFound}
  <div class="card empty-state mt-4">{$t("Request not found.")}</div>
{:else if error}
  <p class="alert-error mt-4">{error}</p>
{:else if detail}
  <h1 class="page-title mb-1 mt-2">{$t("Request")}</h1>
  <div class="section-desc mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs">
    <span>
      {$t("Request ID")}:
      <code class="font-mono">{detail.request_id}</code>
    </span>
    {#if detail.trace_id !== detail.request_id}
      <span>
        {$t("Client trace ID")}:
        <code class="font-mono">{detail.trace_id}</code>
      </span>
    {/if}
  </div>

  <div class="card mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
    <div>
      <div class="section-desc">{$t("Model")}</div>
      <div class="mt-1 font-medium">{detail.served_model ?? "—"}</div>
    </div>
    <div>
      <div class="section-desc">{$t("Lane")}</div>
      <div class="mt-1 font-medium">{detail.lane}</div>
    </div>
    <div>
      <div class="section-desc">{$t("Status")}</div>
      <div class="mt-1">
        <span
          class="badge {detail.status === 'ok' ? 'badge-ok' : 'badge-error'}"
          >{detail.status}</span
        >
      </div>
    </div>
    <div>
      <div class="section-desc">{$t("Latency")}</div>
      <div class="mt-1 font-medium">{detail.latency_ms}ms</div>
    </div>
  </div>

  {#if detail.status === "error" && detail.error_reason}
    <p class="alert-error mb-4">{detail.error_reason}</p>
  {/if}

  <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
    <div class="card">
      <TokenUsage usage={toTokenUsageView(detail.usage)} />
    </div>
    {#if costView}
      <div class="card">
        <CostBreakdown cost={costView.cost_breakdown} />
      </div>
    {/if}
  </div>

  {#if mediaGroups.length > 0}
    <section data-testid="media-overview" class="card mt-4 text-sm">
      <h2 class="section-header">{$t("Images")}</h2>
      <p class="field-help mb-3">
        {$t(
          "All images sent in the request and returned in the response — click any to view full size.",
        )}
      </p>
      <div class="flex flex-col gap-4">
        {#each mediaGroups as group (group.kind)}
          <div data-testid="media-group">
            <p
              class="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted"
            >
              {group.kind === "request" ? $t("Request") : $t("Response")}
            </p>
            <div class="flex flex-wrap gap-3">
              {#each group.images as image (image.url)}
                <ImagePreview
                  src={image.url}
                  label={`${group.kind === "request" ? $t("Request") : $t("Response")} · ${image.path}`}
                  variant="thumb"
                />
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <section class="card mt-4 text-sm">
    <h2 class="section-header">{$t("Request")}</h2>
    {#if payloadMeta.captured && hasPayloadPart("request")}
      <p class="field-help mb-2">
        {$t(
          "Payload capture is available for this call. Large bodies are loaded on demand.",
        )}
      </p>
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="request-view-chat"
          class={`rounded border px-3 py-1 text-sm ${reqView === "chat" ? "border-action bg-action text-white" : "border-border bg-surface text-ink-muted hover:bg-canvas"}`}
          onclick={() => (reqView = "chat")}>{$t("Conversation")}</button
        >
        <button
          type="button"
          data-testid="request-view-raw"
          class={`rounded border px-3 py-1 text-sm ${reqView === "raw" ? "border-action bg-action text-white" : "border-border bg-surface text-ink-muted hover:bg-canvas"}`}
          onclick={() => (reqView = "raw")}>{$t("Raw")}</button
        >
      </div>

      {#if reqView === "chat"}
        {#if !requestLoaded || (hasPayloadPart("response") && !responseLoaded)}
          <div class="rounded border border-dashed border-border bg-canvas p-3">
            <p class="field-help mb-2">
              {$t(
                "Load the captured request and response only when you need the transcript.",
              )}
            </p>
            <button
              type="button"
              data-testid="load-conversation"
              class="btn-secondary"
              disabled={payloadStatus.request === "loading" ||
                payloadStatus.response === "loading"}
              onclick={loadConversation}
              >{payloadStatus.request === "loading" ||
              payloadStatus.response === "loading"
                ? $t("Loading")
                : $t("Load conversation")}</button
            >
            {#if payloadErrors.request || payloadErrors.response}
              <p class="mt-2 text-sm text-red-600">
                {payloadErrors.request ?? payloadErrors.response}
              </p>
            {/if}
          </div>
        {:else}
          <Conversation
            request={payloadValues.request}
            response={payloadValues.response}
            testid="conversation"
          />
        {/if}
      {:else if !requestLoaded}
        <div class="rounded border border-dashed border-border bg-canvas p-3">
          <p class="field-help mb-2">
            {$t("Load the raw request body only when you need to inspect it.")}
          </p>
          <button
            type="button"
            data-testid="load-request-body"
            class="btn-secondary"
            disabled={payloadStatus.request === "loading"}
            onclick={() => loadPayloadPart("request")}
            >{payloadStatus.request === "loading"
              ? $t("Loading")
              : $t("Load request body")}</button
          >
          {#if payloadErrors.request}
            <p class="mt-2 text-sm text-red-600">{payloadErrors.request}</p>
          {/if}
        </div>
      {:else}
        <JsonViewer value={payloadValues.request} testid="request-body" />
      {/if}
    {:else}
      <div class="empty-state">
        {$t("No request body was captured for this request.")}
      </div>
    {/if}
  </section>

  {#if payloadMeta.captured && hasPayloadPart("response")}
    <section class="card mt-4 text-sm">
      <h2 class="section-header">{$t("Response")}</h2>
      {#if !responseLoaded}
        <div class="rounded border border-dashed border-border bg-canvas p-3">
          <p class="field-help mb-2">
            {$t(
              "Load the full response body only when you need to inspect it.",
            )}
          </p>
          <button
            type="button"
            data-testid="load-response-body"
            class="btn-secondary"
            disabled={payloadStatus.response === "loading"}
            onclick={() => loadPayloadPart("response")}
            >{payloadStatus.response === "loading"
              ? $t("Loading")
              : $t("Load response body")}</button
          >
          {#if payloadErrors.response}
            <p class="mt-2 text-sm text-red-600">{payloadErrors.response}</p>
          {/if}
        </div>
      {:else if isSseStream(payloadValues.response)}
        <p class="field-help mb-2">
          {$t("Streaming response — assembled from the recorded SSE stream.")}
        </p>
        <StreamViewer
          raw={payloadValues.response as string}
          testid="response-body"
        />
      {:else}
        <p class="field-help mb-2">
          {$t("Full response body recorded for this call.")}
        </p>
        <JsonViewer value={payloadValues.response} testid="response-body" />
      {/if}
    </section>
  {/if}
{/if}
