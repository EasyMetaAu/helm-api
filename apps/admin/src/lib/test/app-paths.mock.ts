// Test-only stub for SvelteKit's virtual `$app/paths` module. The standalone
// admin vitest config (plain `svelte()` plugin, not the kit plugin) cannot
// resolve `$app/*`, so it is aliased here. base='' mirrors the SvelteKit test
// default — internal links assert as `/requests/...` while production (base=
// '/admin') yields `/admin/requests/...`.
export const base = '';
export const assets = '';
export function resolveRoute(path: string): string {
  return path;
}
