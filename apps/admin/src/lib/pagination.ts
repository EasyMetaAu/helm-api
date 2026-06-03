// Page-number row for a numbered pager. Pure + deterministic (unit-tested):
// always shows the first and last page plus a window of `around` pages on each
// side of `current`, and an 'ellipsis' marker wherever the sequence skips. The
// view renders numbers as links and 'ellipsis' as a static gap.

export type PageItem = number | 'ellipsis';

export function paginationItems(current: number, totalPages: number, around = 1): PageItem[] {
  const total = Math.max(1, Math.floor(totalPages));
  const cur = Math.min(Math.max(1, Math.floor(current)), total);

  // First + last are always present; add the window around the current page.
  const pages = new Set<number>([1, total]);
  for (let p = cur - around; p <= cur + around; p++) {
    if (p >= 1 && p <= total) pages.add(p);
  }

  // Walk the sorted pages, inserting one 'ellipsis' per gap > 1.
  const sorted = [...pages].sort((a, b) => a - b);
  const items: PageItem[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) items.push('ellipsis');
    items.push(p);
    prev = p;
  }
  return items;
}
