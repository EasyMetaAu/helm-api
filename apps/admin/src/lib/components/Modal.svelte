<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '$lib/i18n';

  // Reusable centered modal: fixed full-screen backdrop, a scrim that dismisses on
  // click, Escape-to-close, and body scroll-lock while open. The panel carries the
  // `role="dialog"` + aria-label so callers render plain content inside it.
  //
  // `dismissible` gates BOTH the scrim and Escape. Set it false when the dialog must
  // be acknowledged (e.g. the one-time API-key plaintext reveal — CLAUDE.md 原则7):
  // there is then no scrim and Escape is ignored, so the only exit is an explicit
  // action the caller wires up.
  let {
    label,
    onclose,
    dismissible = true,
    children,
  }: {
    label: string;
    onclose: () => void;
    dismissible?: boolean;
    children: Snippet;
  } = $props();

  let panel = $state<HTMLDivElement | null>(null);

  function onKeydown(e: KeyboardEvent): void {
    if (dismissible && e.key === 'Escape') {
      e.stopPropagation();
      onclose();
    }
  }

  // Lock background scroll and move focus into the panel while the modal is open;
  // both are restored when it unmounts.
  $effect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<div class="modal-backdrop">
  {#if dismissible}
    <!-- A real button (not a click-handler on the scrim div) keeps this keyboard-
         reachable and a11y-clean; it sits behind the panel and fills the backdrop. -->
    <button
      type="button"
      class="modal-scrim"
      data-testid="modal-scrim"
      aria-label={$t('Close')}
      onclick={onclose}
    ></button>
  {/if}
  <div
    bind:this={panel}
    class="modal-panel"
    role="dialog"
    aria-modal="true"
    aria-label={label}
    tabindex="-1"
  >
    {@render children()}
  </div>
</div>
