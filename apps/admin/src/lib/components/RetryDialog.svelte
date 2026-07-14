<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { replayRequest } from '$lib/api/requests.js';
  import Modal from '$lib/components/Modal.svelte';
  import { formatDurationMs } from '$lib/format.js';
  import { t } from '$lib/i18n';

  // Retry dialog: shows the recorded request body in an EDITABLE textarea (e.g. to
  // raise max_tokens after a truncated reasoning run), then re-sends it. The replay
  // is an isolated debug re-run server-side; on success we navigate to the NEW
  // trace's detail page. The browser only ever handles the request BODY — never a
  // key (it lives in the Authorization header, reconstructed server-side).
  //
  // The replay endpoint runs the WHOLE upstream call (draining the full stream)
  // before returning the trace id, so a long completion keeps this dialog waiting
  // 30s+. The sending state therefore must never read as a hang: a ticking elapsed
  // counter + live progress note prove the UI is alive, the body locks (what's
  // shown is exactly what was sent), and Cancel aborts the in-flight replay — the
  // fetch signal propagates to the gateway, which aborts the upstream run.
  let {
    traceId,
    initialRequest,
    onclose,
  }: {
    traceId: string;
    initialRequest: unknown;
    onclose: () => void;
  } = $props();

  // Pretty-print the captured body as the starting point for edits. `untrack`
  // snapshots it ONCE on mount — the textarea is then the operator's to edit (the
  // dialog is recreated on each open, so a stale snapshot is impossible).
  let text = $state<string>(untrack(() => JSON.stringify(initialRequest, null, 2)));
  let error = $state<string | null>(null);
  let sending = $state<boolean>(false);
  let elapsed = $state<number>(0);
  let controller: AbortController | null = null;

  // Tick the elapsed counter while a replay is in flight; the interval dies with
  // the sending state (and on unmount) via the effect's cleanup.
  $effect(() => {
    if (!sending) return;
    const id = setInterval(() => {
      elapsed += 1;
    }, 1000);
    return () => clearInterval(id);
  });

  async function handleSend(): Promise<void> {
    error = null;
    // Parse client-side so a typo surfaces immediately instead of a 400 round-trip.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      error = $t('Invalid JSON in request body');
      return;
    }
    sending = true;
    elapsed = 0;
    controller = new AbortController();
    try {
      const { trace_id } = await replayRequest(traceId, parsed, controller.signal);
      // Navigate to the freshly recorded re-run; the dialog unmounts with the page.
      await goto(`${base}/requests/${encodeURIComponent(trace_id)}`);
      onclose();
    } catch (e) {
      // An abort is the operator's own Cancel, not a failure — return silently to
      // the editable state so they can tweak and resend.
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        error = e instanceof Error ? e.message : $t('Failed to retry request');
      }
    } finally {
      sending = false;
      controller = null;
    }
  }

  // One button, two meanings: while idle it closes the dialog; while sending it
  // aborts the in-flight replay (staying open for another edit/send). Keeping it
  // enabled is the point — a 30s+ wait with no exit is what felt like a hang.
  function handleCancel(): void {
    if (sending) {
      controller?.abort();
      return;
    }
    onclose();
  }
</script>

<Modal label={$t('Retry request')} {onclose} dismissible={!sending}>
  <h2 class="section-header">{$t('Retry request')}</h2>
  <p class="field-help mt-1">
    {$t(
      'Edit the request below, then send it again. This runs a fresh call and records a new trace.',
    )}
  </p>

  {#if error}
    <p class="alert-error mt-2" role="alert">{error}</p>
  {/if}

  <textarea
    data-testid="retry-body"
    class="input mt-3 h-72 w-full resize-y font-mono text-xs {sending ? 'opacity-60' : ''}"
    spellcheck="false"
    aria-label={$t('Request body')}
    readonly={sending}
    bind:value={text}
  ></textarea>

  {#if sending}
    <!-- aria-live so the wait announces itself; the visible note explains WHY it
         takes long (the gateway replays the full upstream call before recording). -->
    <p
      data-testid="retry-progress"
      class="field-help mt-2 flex items-center gap-2"
      aria-live="polite"
    >
      <span
        class="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
        aria-hidden="true"
      ></span>
      {$t(
        'Calling the upstream model and recording the full response — long replies can take a minute or two. You can cancel anytime.',
      )}
    </p>
  {/if}

  <div class="mt-4 flex justify-end gap-2">
    <button type="button" data-testid="retry-cancel" class="btn-secondary" onclick={handleCancel}
      >{$t('Cancel')}</button
    >
    <button
      type="button"
      data-testid="retry-send"
      class="btn-primary"
      disabled={sending}
      onclick={handleSend}
      >{sending
        ? $t('Sending… {duration}', { duration: formatDurationMs(elapsed * 1000) })
        : $t('Send')}</button
    >
  </div>
</Modal>
