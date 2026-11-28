<script lang="ts">
  import { base } from "$app/paths";
  import { ApiError } from "$lib/api/client";
  import { replayRequest, type ReplayResponse } from "$lib/api/portal";
  import { t } from "$lib/i18n";
  import { requestDetailHref } from "$lib/requests-filters";
  import Modal from "./Modal.svelte";

  let {
    requestId,
    backTo,
    onclose,
  }: {
    requestId: string;
    backTo: string;
    onclose: () => void;
  } = $props();

  let idempotencyKey: string | undefined;
  let controller: AbortController | null = null;
  let sending = $state(false);
  let outcome = $state<ReplayResponse["data"] | null>(null);
  let error = $state("");
  let canRetry = $state(true);

  $effect(() => () => controller?.abort());

  function explainError(failure: unknown): string {
    if (failure instanceof ApiError) {
      if (failure.status === 401) {
        return $t(
          "This key can no longer send requests. Sign in again with a valid key.",
        );
      }
      if (failure.status === 404) {
        return $t("The original request is no longer available.");
      }
      if (failure.status === 429) {
        return failure.retryAfter
          ? $t("Too many replays. Try again in {seconds} seconds.", {
              seconds: failure.retryAfter,
            })
          : $t("Too many replays. Wait a moment and try again.");
      }
      switch (failure.code) {
        case "replay_payload_unavailable":
          return $t("The original request cannot be recovered for replay.");
        case "idempotency_conflict":
        case "idempotency_key_required":
          return $t(
            "This replay could not be started. Close this dialog and try again.",
          );
        case "replay_unavailable":
          return $t("Replay is temporarily unavailable. Try again later.");
      }
    }
    return $t(
      "The replay may have been sent. Helm could not confirm the result.",
    );
  }

  async function send(): Promise<void> {
    if (sending || !canRetry) return;
    sending = true;
    outcome = null;
    error = "";
    try {
      idempotencyKey ??= crypto.randomUUID();
      controller = new AbortController();
      const response = await replayRequest(
        requestId,
        idempotencyKey,
        controller.signal,
      );
      outcome = response.data;
      canRetry = outcome.status === "outcome_unknown";
      switch (outcome.status) {
        case "rejected":
          error =
            outcome.code === "replay_payload_unavailable"
              ? $t("The original request cannot be recovered for replay.")
              : outcome.upstream_status === 429
                ? $t("The request was blocked by a rate or usage limit.")
                : $t("Helm rejected the request before it could be recorded.");
          break;
        case "outcome_unknown":
          error = $t(
            "The replay may have been sent. Helm could not confirm the result.",
          );
          break;
      }
    } catch (failure) {
      canRetry =
        idempotencyKey !== undefined &&
        (!(failure instanceof ApiError) ||
          ![400, 401, 404, 409].includes(failure.status));
      error = idempotencyKey
        ? explainError(failure)
        : $t("Replay needs a secure browser connection.");
    } finally {
      controller = null;
      sending = false;
    }
  }

  function cancelOrClose(): void {
    if (controller) {
      controller.abort();
      return;
    }
    onclose();
  }
</script>

<Modal label={$t("Replay request")} {onclose} dismissible={!sending}>
  <h2 class="section-header">{$t("Replay request")}</h2>
  <p class="field-help mt-1">
    {$t(
      "Replay sends this request again with your API key. It counts toward your usage, budget, and limits.",
    )}
  </p>

  {#if error}
    <p class="alert-error mt-2" role="alert">{error}</p>
  {/if}

  {#if sending}
    <p class="field-help mt-2 flex items-center gap-2" aria-live="polite">
      <span
        class="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
        aria-hidden="true"
      ></span>
      {$t("Sending the request again…")}
    </p>
  {:else if outcome && (outcome.status === "recorded" || outcome.status === "in_progress" || outcome.status === "recording_pending")}
    <div class="field-help mt-2" role="status">
      {#if outcome.status === "recorded"}
        <p>{$t("The replay was recorded.")}</p>
      {:else if outcome.status === "in_progress"}
        <p>{$t("This replay is still in progress.")}</p>
      {:else}
        <p>{$t("The replay finished, but its record is still unavailable.")}</p>
      {/if}
      {#if outcome.request_id}
        <a
          class="link-inline"
          href={requestDetailHref(
            `${base}/requests`,
            outcome.request_id,
            backTo,
          )}
        >
          {$t("Open new request")}
        </a>
      {/if}
    </div>
  {/if}

  <div class="mt-4 flex justify-end gap-2">
    <button type="button" class="btn-secondary" onclick={cancelOrClose}>
      {outcome || error ? $t("Close") : $t("Cancel")}
    </button>
    {#if canRetry || sending}
      <button
        type="button"
        class="btn-primary"
        disabled={sending}
        onclick={send}
      >
        {sending ? $t("Sending…") : error ? $t("Try again") : $t("Replay")}
      </button>
    {/if}
  </div>
</Modal>
