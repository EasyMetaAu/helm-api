import { listKeys } from '$lib/api/keys.js';
import { listScopes } from '$lib/api/memory.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the memory scope groups (the "By Scope" tab) plus the redacted
// key list (the "By Key" tab's selector — prefix only, never plaintext) from the
// gateway admin API. Facts + reflections for a chosen scope load client-side on
// selection (the table below is driven by user interaction, not the initial load).
export const load: PageLoad = async () => {
  const [scopes, keys] = await Promise.all([listScopes(), listKeys()]);
  return { scopes, keys };
};
