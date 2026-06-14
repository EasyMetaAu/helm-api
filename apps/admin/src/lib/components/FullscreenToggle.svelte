<script lang="ts">
  import { t } from '$lib/i18n';

  // Reusable fullscreen toggle shared by JsonViewer and StreamViewer so both body
  // viewers expose the exact same affordance. `active` is bindable: the parent
  // swaps its root/panel classes (see viewerChrome.ts) off this flag. This button
  // also owns the Escape-to-exit shortcut so the parents don't each re-implement it.
  let { active = $bindable(false), testid }: { active?: boolean; testid?: string } = $props();

  const label = $derived(active ? $t('Exit fullscreen') : $t('Fullscreen'));
</script>

<svelte:window
  onkeydown={(e) => {
    if (active && e.key === 'Escape') active = false;
  }}
/>

<button
  type="button"
  data-testid={testid}
  aria-label={label}
  title={label}
  aria-pressed={active}
  class="rounded border border-border bg-surface px-2 py-1 text-ink-muted hover:bg-canvas"
  onclick={() => (active = !active)}
>
  {#if active}
    <!-- arrows-pointing-in -->
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      class="h-4 w-4"
      aria-hidden="true"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M15 9h4.5M15 9V4.5M15 9l5.25-5.25M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25"
      />
    </svg>
  {:else}
    <!-- arrows-pointing-out -->
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      class="h-4 w-4"
      aria-hidden="true"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9m11.25-5.25h-4.5m4.5 0v4.5m0-4.5L15 9m-11.25 11.25h4.5m-4.5 0v-4.5m0 4.5L9 15m11.25 5.25h-4.5m4.5 0v-4.5m0 4.5L15 15"
      />
    </svg>
  {/if}
</button>
