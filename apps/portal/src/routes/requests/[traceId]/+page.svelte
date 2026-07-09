<script lang="ts">
  import { base } from "$app/paths";
  import { page } from "$app/stores";
  import { t } from "$lib/i18n";
  import { formatUsd, formatTokens } from "$lib/format";
  import Conversation from "$lib/components/Conversation.svelte";
  import TokenUsage from "$lib/components/TokenUsage.svelte";
  import CostBreakdown from "$lib/components/CostBreakdown.svelte";
  import { toTokenUsageView } from "$lib/api/requests";
  import {
    getRequestDetail,
    getPayloadPart,
    type PortalRequestDetail,
  } from "$lib/api/portal";

  const traceId = $derived($page.params.traceId);

  let detail = $state<PortalRequestDetail | null>(null);
  let requestBody = $state<unknown>(null);
  let responseBody = $state<unknown>(null);
  let loading = $state(true);
  let notFound = $state(false);
  let error = $state("");

  async function load(id: string) {
    loading = true;
    notFound = false;
    error = "";
    try {
      detail = await getRequestDetail(id);
      // Payload is best-effort — capture may be off, or pruned.
      const [req, resp] = await Promise.all([
        getPayloadPart(id, "request").catch(() => null),
        getPayloadPart(id, "response").catch(() => null),
      ]);
      requestBody = req?.value ?? null;
      responseBody = resp?.value ?? null;
    } catch (e) {
      if (e instanceof Error && e.message.includes("404")) notFound = true;
      else error = e instanceof Error ? e.message : "load failed";
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    if (traceId) void load(traceId);
  });

  // Portal shows only the user's total cost — eval/routing self-cost stays null
  // (supply-chain economics, §4.3).
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
  <p class="section-desc mb-4 font-mono text-xs">{detail.request_id}</p>

  <!-- Result summary (lane/result view only — no supply chain, §4.3) -->
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

  <!-- The user's own request/response bodies (their data; §4.3) -->
  {#if requestBody !== null || responseBody !== null}
    <section class="card mt-4">
      <h2 class="section-header mb-3">{$t("Conversation")}</h2>
      <Conversation request={requestBody} response={responseBody} />
    </section>
  {:else}
    <div class="card empty-state mt-4">
      {$t("No request body was captured for this request.")}
    </div>
  {/if}
{/if}
