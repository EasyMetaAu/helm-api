<script lang="ts">
  import { t } from "$lib/i18n";
  import Modal from "./Modal.svelte";

  // "See it as a picture" affordance for the JSON tree. A base64 image field is
  // otherwise an unreadable wall of characters; this renders the decoded image in a
  // roomy modal via its `data:` URL (already resolved by the caller). Read-only —
  // never mutates the value.
  // `variant` picks the trigger: 'link' is the inline "View image" text link shown
  // next to a base64 scalar in the JSON tree; 'thumb' renders the decoded image as a
  // clickable thumbnail for the gallery strip above the body. Both open the SAME zoom
  // modal below — the gallery just makes a generated image visible without expanding
  // the tree first.
  let {
    src,
    label,
    variant = "link",
  }: { src: string; label?: string; variant?: "link" | "thumb" } = $props();

  let open = $state(false);

  // Zoom state. `zoom` is a scale factor (1 = 100% = the image's natural pixels).
  // A decoded image is frequently far bigger or smaller than the modal, so the
  // viewer lets the user zoom in/out, jump to 1:1, or re-fit it to the window. The
  // fit math reads natural + viewport sizes straight from the live DOM.
  const STEP = 1.25;
  const MIN = 0.1;
  const MAX = 8;

  let zoom = $state(1);
  let naturalW = $state(0);
  let naturalH = $state(0);
  let viewport = $state<HTMLDivElement | null>(null);

  const percent = $derived(Math.round(zoom * 100));

  function clamp(z: number): number {
    return Math.min(MAX, Math.max(MIN, z));
  }

  function zoomBy(factor: number): void {
    zoom = clamp(zoom * factor);
  }

  function actualSize(): void {
    zoom = 1;
  }

  // Scale the image to sit fully inside the viewport; never upscale past 1:1 (a tiny
  // image blown up to fill a big window is just a blurry block — let the user zoom in
  // deliberately instead). No-op until both natural and viewport sizes are known.
  function fitToWindow(): void {
    if (!viewport || !naturalW || !naturalH) return;
    const availW = viewport.clientWidth - 24;
    const availH = viewport.clientHeight - 24;
    const f = Math.min(availW / naturalW, availH / naturalH, 1);
    if (Number.isFinite(f) && f > 0) zoom = clamp(f);
  }

  function onImageLoad(e: Event): void {
    const img = e.currentTarget as HTMLImageElement;
    naturalW = img.naturalWidth;
    naturalH = img.naturalHeight;
    fitToWindow();
  }

  // Ctrl/⌘ + wheel zooms (the OS image-viewer convention) and stops the page from
  // scrolling underneath. A plain wheel still scrolls the viewport normally.
  function onWheel(e: WheelEvent): void {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? STEP : 1 / STEP);
  }

  // data: URLs can't be opened as a top-level navigation in modern browsers, so we
  // pop a blank window and drop the decoded <img> into it rather than linking the
  // data: URL directly (which would just be blocked or download).
  function openInNewTab(): void {
    // NB: do NOT pass `noopener` — a no-opener window is spec'd to return null, which
    // would leave us no handle to write the <img> into and the tab would stay blank.
    // We sever `opener` ourselves instead; the page only ever shows our own data: URL.
    const win = window.open("", "_blank");
    if (!win) return;
    win.opener = null;
    win.document.title = label ?? "image";
    win.document.body.style.margin = "0";
    win.document.body.style.background = "#0b0b0b";
    const img = win.document.createElement("img");
    img.src = src;
    img.style.maxWidth = "100%";
    win.document.body.appendChild(img);
  }

  // Reset zoom on close so the next open starts fresh and re-fits to the window.
  function close(): void {
    open = false;
    zoom = 1;
    naturalW = 0;
    naturalH = 0;
  }
</script>

{#if variant === "thumb"}
  <button
    type="button"
    class="block overflow-hidden rounded border border-border bg-canvas transition-colors hover:border-action focus:border-action [background-image:repeating-conic-gradient(theme(colors.slate.200)_0_25%,transparent_0_50%)] [background-size:12px_12px]"
    data-testid="image-preview-open"
    title={label ?? $t("View image")}
    onclick={() => (open = true)}
  >
    <img
      {src}
      alt={label ?? $t("View image")}
      class="h-28 w-28 object-contain"
    />
  </button>
{:else}
  <button
    type="button"
    class="ml-2 cursor-pointer text-link underline"
    data-testid="image-preview-open"
    onclick={() => (open = true)}>{$t("View image")}</button
  >
{/if}

{#if open}
  <Modal label={label ?? $t("View image")} onclose={close} wide>
    <div class="flex max-h-[80vh] flex-col">
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 class="truncate font-mono text-sm text-ink-body">
          {label ?? $t("View image")}
        </h2>
        <button
          type="button"
          class="btn-secondary"
          data-testid="image-preview-close"
          onclick={close}>{$t("Close")}</button
        >
      </div>

      <div class="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="btn-secondary"
          data-testid="image-preview-zoom-out"
          aria-label={$t("Zoom out")}
          title={$t("Zoom out")}
          onclick={() => zoomBy(1 / STEP)}>−</button
        >
        <span
          class="min-w-[3.5rem] text-center font-mono text-sm tabular-nums text-ink-body"
          data-testid="image-preview-zoom-level">{percent}%</span
        >
        <button
          type="button"
          class="btn-secondary"
          data-testid="image-preview-zoom-in"
          aria-label={$t("Zoom in")}
          title={$t("Zoom in")}
          onclick={() => zoomBy(STEP)}>+</button
        >
        <button
          type="button"
          class="btn-secondary"
          data-testid="image-preview-zoom-actual"
          title={$t("Actual size")}
          onclick={actualSize}>1:1</button
        >
        <button
          type="button"
          class="btn-secondary"
          data-testid="image-preview-zoom-fit"
          onclick={fitToWindow}>{$t("Fit to window")}</button
        >
        <button
          type="button"
          class="btn-secondary ml-auto"
          data-testid="image-preview-open-tab"
          onclick={openInNewTab}>{$t("Open in new tab")}</button
        >
      </div>

      <div
        bind:this={viewport}
        onwheel={onWheel}
        class="min-h-0 flex-1 overflow-auto rounded bg-canvas p-3 [background-image:repeating-conic-gradient(theme(colors.slate.200)_0_25%,transparent_0_50%)] [background-position:0_0] [background-size:16px_16px]"
      >
        <img
          data-testid="image-preview-img"
          {src}
          alt={label ?? $t("View image")}
          onload={onImageLoad}
          style={naturalW
            ? `width:${Math.round(naturalW * zoom)}px;height:${Math.round(
                naturalH * zoom,
              )}px;max-width:none`
            : ""}
          class="mx-auto block max-w-full"
        />
      </div>
    </div>
  </Modal>
{/if}
