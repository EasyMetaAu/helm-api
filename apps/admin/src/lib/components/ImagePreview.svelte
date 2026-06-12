<script lang="ts">
  import { t } from '$lib/i18n';
  import Modal from './Modal.svelte';

  // "See it as a picture" affordance for the JSON tree. A base64 image field is
  // otherwise an unreadable wall of characters; this renders the decoded image in a
  // roomy modal via its `data:` URL (already resolved by the caller). Read-only —
  // never mutates the value.
  let { src, label }: { src: string; label?: string } = $props();

  let open = $state(false);
</script>

<button
  type="button"
  class="ml-2 cursor-pointer text-link underline"
  data-testid="image-preview-open"
  onclick={() => (open = true)}>{$t('View image')}</button
>

{#if open}
  <Modal label={label ?? $t('View image')} onclose={() => (open = false)} wide>
    <div class="flex max-h-[80vh] flex-col">
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 class="truncate font-mono text-sm text-ink-body">{label ?? $t('View image')}</h2>
        <button
          type="button"
          class="btn-secondary"
          data-testid="image-preview-close"
          onclick={() => (open = false)}>{$t('Close')}</button
        >
      </div>
      <div
        class="min-h-0 flex-1 overflow-auto rounded bg-canvas p-3 [background-image:repeating-conic-gradient(theme(colors.slate.200)_0_25%,transparent_0_50%)] [background-position:0_0] [background-size:16px_16px]"
      >
        <img
          data-testid="image-preview-img"
          {src}
          alt={label ?? $t('View image')}
          class="mx-auto block max-w-full"
        />
      </div>
    </div>
  </Modal>
{/if}
