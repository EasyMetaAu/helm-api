<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { replayRequest } from '$lib/api/requests.js';
  import Modal from '$lib/components/Modal.svelte';
  import { t } from '$lib/i18n';

  // Retry dialog: shows the recorded request body in an EDITABLE textarea (e.g. to
  // raise max_tokens after a truncated reasoning run), then re-sends it. The replay
  // is an isolated debug re-run server-side; on success we navigate to the NEW
  // trace's detail page. The browser only ever handles the request BODY — never a
  // key (it lives in the Authorization header, reconstructed server-side).
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
    try {
      const { trace_id } = await replayRequest(traceId, parsed);
      // Navigate to the freshly recorded re-run; the dialog unmounts with the page.
      await goto(`${base}/requests/${encodeURIComponent(trace_id)}`);
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to retry request');
    } finally {
      sending = false;
    }
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
    class="input mt-3 h-72 w-full resize-y font-mono text-xs"
    spellcheck="false"
    aria-label={$t('Request body')}
    bind:value={text}
  ></textarea>

  <div class="mt-4 flex justify-end gap-2">
    <button type="button" class="btn-secondary" disabled={sending} onclick={onclose}
      >{$t('Cancel')}</button
    >
    <button type="button" class="btn-primary" disabled={sending} onclick={handleSend}
      >{sending ? $t('Sending…') : $t('Send')}</button
    >
  </div>
</Modal>
