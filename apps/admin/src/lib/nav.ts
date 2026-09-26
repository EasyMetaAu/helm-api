// Where a detail page's Back link returns to. The originating list (the requests list
// OR a key detail page) passes its full path+filters as `?from=`; we return there
// verbatim so the user lands back on the exact page/filter state — surviving reload /
// new-tab, since it lives in the URL, not browser history. Accept ONLY a same-app
// relative path (single leading slash, no scheme / protocol-relative / backslash) so a
// crafted `from` can never become an open redirect; anything else falls back.
//
// Lives in $lib, not the route's +page.ts: SvelteKit rejects non-standard exports from
// route modules at runtime ("Invalid export 'safeBackTo'"), which 500'd the page.
export function safeBackTo(from: string | null, fallback: string): string {
  if (!from || !from.startsWith('/') || from[1] === '/' || from[1] === '\\') return fallback;
  return from;
}
