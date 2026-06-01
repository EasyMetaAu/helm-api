// Admin models API client. The catalog of routable `provider/model` aliases the
// gateway exposes at /admin/api/models (sourced from config/providers.yaml). The
// Lanes UI uses it for combobox suggestions so an operator picks a real alias
// instead of hand-typing one. The admin UI stays a pure HTTP consumer (Principle 1) —
// no core/gateway import.

const ENDPOINT = '/admin/api/models';

// GET /admin/api/models -> string[] of aliases.
//
// This is a UI convenience, NOT a security boundary: if the catalog can't be
// fetched (network blip, older gateway without the endpoint) we degrade to an
// empty list so the Lanes page still renders and the combobox just behaves as a
// plain text input. We never throw here — a broken suggestion list must not take
// down the whole editor.
export async function listModels(): Promise<string[]> {
  try {
    const res = await fetch(ENDPOINT, { headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? body.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
