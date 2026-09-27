// Row action menus are native <details class="menu">, which never close on their
// own. One document-level listener (installed by the root layout) gives every
// menu the standard popover behavior: a click outside, Escape, or choosing an
// item closes it, and opening one menu closes the others.
const OPEN_MENUS = 'details.menu[open]';

export function installMenuDismiss(doc: Document): () => void {
  const closeAll = (keep?: Element | null) => {
    for (const el of doc.querySelectorAll<HTMLDetailsElement>(OPEN_MENUS)) {
      if (el !== keep) el.open = false;
    }
  };
  // Capture phase so inner handlers that stopPropagation can't keep a menu stuck open.
  const onPointerDown = (e: Event) => {
    closeAll((e.target as Element | null)?.closest?.('details.menu'));
  };
  const onClick = (e: Event) => {
    const item = (e.target as Element | null)?.closest?.('.menu-panel button, .menu-panel a');
    const menu = item?.closest<HTMLDetailsElement>('details.menu');
    if (menu) menu.open = false;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeAll();
  };
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('click', onClick);
  doc.addEventListener('keydown', onKeyDown);
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('click', onClick);
    doc.removeEventListener('keydown', onKeyDown);
  };
}
