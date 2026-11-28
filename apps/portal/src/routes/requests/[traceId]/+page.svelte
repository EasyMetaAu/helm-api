<script lang="ts">
  import { page } from "$app/stores";
  import { base } from "$app/paths";
  import { ApiError } from "$lib/api/client";
  import { getRequestDetail, getRequests } from "$lib/api/portal";
  import {
    getRequestPayloadMeta,
    toRequestDetail,
    type RequestDetail,
    type RequestPayloadView,
  } from "$lib/api/request-trail";
  import RequestDetailView from "$lib/components/RequestDetailView.svelte";
  import { pollRequestDetail } from "$lib/request-detail-load";
  import { requestsBackTo } from "$lib/requests-filters";

  const requestId = $derived($page.params.traceId ?? "");
  const backTo = $derived(
    requestsBackTo($page.url.searchParams.get("from"), `${base}/requests`),
  );
  const replayProtocols = new Set([
    "openai_chat",
    "anthropic_messages",
    "openai_responses",
    "gemini",
  ]);

  let detail = $state<RequestDetail | null>(null);
  let payload = $state<RequestPayloadView | null>(null);
  let session = $state<{ ref: string; label?: string } | null>(null);
  let replayable = $state(false);
  let loadState = $state<
    "loading" | "pending" | "refresh" | "ready" | "notFound" | "error"
  >("loading");
  let refresh = $state(0);

  async function loadPayload(id: string, signal: AbortSignal): Promise<void> {
    const metadata = await getRequestPayloadMeta(id);
    if (!signal.aborted) payload = metadata;
  }

  async function loadSessionLabel(
    ref: string,
    signal: AbortSignal,
  ): Promise<void> {
    // The owned list route can resolve a retained label for this exact reference.
    try {
      const { items } = await getRequests({ session_ref: ref, pageSize: 1 });
      const row = items[0];
      if (!signal.aborted && row?.session_ref === ref && row.session_label) {
        session = { ref, label: row.session_label };
      }
    } catch {
      // The recorded session reference remains available.
    }
  }

  async function load(id: string, signal: AbortSignal): Promise<void> {
    loadState = "loading";
    detail = null;
    payload = null;
    session = null;
    replayable = false;
    try {
      const result = await pollRequestDetail(
        () => getRequestDetail(id, signal),
        (canRefresh) => {
          loadState = canRefresh ? "refresh" : "pending";
        },
        signal,
      );
      if (result.status === 202) return;

      if (signal.aborted) return;
      const { decision } = result.data;
      detail = toRequestDetail(result.data);
      session = decision.session ?? null;
      replayable =
        decision.request_content_mode !== "none" &&
        replayProtocols.has(decision.protocol ?? "");
      loadState = "ready";
    } catch (error) {
      if (!signal.aborted) {
        loadState =
          error instanceof ApiError && error.status === 404
            ? "notFound"
            : "error";
      }
      return;
    }

    void loadPayload(id, signal);
    if (session?.ref && !session.label) {
      void loadSessionLabel(session.ref, signal);
    }
  }

  $effect(() => {
    const id = requestId;
    void refresh;
    const controller = new AbortController();
    void load(id, controller.signal);
    return () => controller.abort();
  });
</script>

{#key requestId}
  <RequestDetailView
    data={{
      detail,
      payload,
      requestId,
      backTo,
      session,
      replayable,
      state: loadState,
    }}
    onRefresh={() => {
      refresh += 1;
    }}
  />
{/key}
