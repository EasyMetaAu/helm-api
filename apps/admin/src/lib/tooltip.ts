// Instant tooltip for small icon controls (`use:tooltip={text}`). The native
// `title` waits ~1s before showing; this one appears on hover or keyboard focus at
// once. It renders in the top-level layer (appended to <body>, position: fixed) so a
// table or scroll container never clips it, prefers the space above the trigger,
// flips below when there is no room, and shifts sideways to stay on screen.

const GAP = 6;
const EDGE = 8;
let seq = 0;

export function tooltip(node: HTMLElement, text: string) {
  let current = text;
  let el: HTMLDivElement | null = null;
  const id = `tooltip-${++seq}`;

  function place(): void {
    if (!el) return;
    const r = node.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const roomAbove = r.top - GAP - h >= EDGE;
    const top = roomAbove ? r.top - GAP - h : r.bottom + GAP;
    const maxLeft = window.innerWidth - EDGE - w;
    const left = Math.max(EDGE, Math.min(r.left + r.width / 2 - w / 2, maxLeft));
    el.dataset.side = roomAbove ? 'top' : 'bottom';
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
  }

  function show(): void {
    if (!current) return;
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.setAttribute('role', 'tooltip');
      el.className = 'tooltip';
      document.body.append(el);
    }
    el.textContent = current;
    node.setAttribute('aria-describedby', id);
    place();
    window.addEventListener('scroll', hide, true);
  }

  function hide(): void {
    el?.remove();
    el = null;
    node.removeAttribute('aria-describedby');
    window.removeEventListener('scroll', hide, true);
  }

  node.addEventListener('mouseenter', show);
  node.addEventListener('mouseleave', hide);
  node.addEventListener('focus', show);
  node.addEventListener('blur', hide);

  return {
    update(next: string) {
      current = next;
      if (el) {
        el.textContent = next;
        place();
      }
    },
    destroy() {
      hide();
      node.removeEventListener('mouseenter', show);
      node.removeEventListener('mouseleave', hide);
      node.removeEventListener('focus', show);
      node.removeEventListener('blur', hide);
    },
  };
}
