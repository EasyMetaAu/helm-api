// Svelte action: call `handler` when a pointerdown happens outside `node`.
// Used to dismiss open dropdown menus (account menu, refresh cadence) when the
// user clicks the blank area — the standard "click-away to close" behavior.
// Uses pointerdown (not click) so it fires before the toggle button's own click,
// and ignores clicks on the node itself and its descendants.
export function clickOutside(node: HTMLElement, handler: () => void) {
  function onPointerDown(event: PointerEvent) {
    const target = event.target as Node | null;
    if (target && !node.contains(target)) handler();
  }
  // capture:true so it still fires when inner handlers stopPropagation.
  document.addEventListener("pointerdown", onPointerDown, true);
  return {
    destroy() {
      document.removeEventListener("pointerdown", onPointerDown, true);
    },
  };
}
