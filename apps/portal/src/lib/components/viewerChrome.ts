// Shared chrome for the request/response body viewers (JsonViewer + StreamViewer).
// Both lock their panels to a fixed height, which is painful for large captured
// payloads (full chat transcripts). These helpers give every panel the same two
// escape hatches — a native vertical resize handle, and a fullscreen mode — so the
// two viewers behave identically (see FullscreenToggle.svelte for the button).

/**
 * Sizing classes for a viewer panel.
 * - default: content-fit height capped at 40vh, draggable taller/shorter via the
 *   browser's native `resize-y` handle (needs `overflow != visible`, which every
 *   panel already sets). `resize` is clamped to `max-h`, so fullscreen covers the
 *   "show everything" case.
 * - fullscreen: fill the flex container instead of capping/resizing.
 */
export function viewerSizing(fullscreen: boolean): string {
  return fullscreen
    ? "flex-1 min-h-0 max-h-none resize-none"
    : "min-h-32 max-h-[40vh] resize-y";
}

/** Root-container classes that turn a viewer into a full-viewport overlay. */
export const VIEWER_FS_CONTAINER =
  "fixed inset-0 z-50 flex flex-col gap-2 overflow-hidden bg-surface p-4";
