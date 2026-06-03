// Admin models API client. The catalog of routable `provider/model` aliases the
// gateway exposes at /admin/api/models (sourced from config/providers.yaml). The
// Lanes UI uses it for combobox suggestions so an operator picks a real alias
// instead of hand-typing one. The admin UI stays a pure HTTP consumer (Principle 1) —
// no core/gateway import.

const ENDPOINT = '/admin/api/models';

// One routable model: its `provider/model` alias + the subscription account(s)
// exposing it (empty for configured providers). The Lanes picker shows the
// account(s) under each model so the operator knows which bound account backs it.
export interface ModelOption {
  alias: string;
  accounts: string[];
}

// GET /admin/api/models -> ModelOption[].
//
// This is a UI convenience, NOT a security boundary: if the catalog can't be
// fetched (network blip, older gateway without the endpoint) we degrade to an
// empty list so the Lanes page still renders and the combobox just behaves as a
// plain text input. We never throw here — a broken suggestion list must not take
// down the whole editor. Tolerates BOTH the new object shape and a legacy bare
// `string[]` (older gateway), normalizing each entry to a ModelOption.
export async function listModels(): Promise<ModelOption[]> {
  try {
    const res = await fetch(ENDPOINT, { headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return [];
    return body.flatMap((x): ModelOption[] => {
      if (typeof x === 'string') return [{ alias: x, accounts: [] }];
      if (x && typeof x === 'object' && typeof (x as { alias?: unknown }).alias === 'string') {
        const raw = (x as { accounts?: unknown }).accounts;
        const accounts = Array.isArray(raw)
          ? raw.filter((a): a is string => typeof a === 'string')
          : [];
        return [{ alias: (x as { alias: string }).alias, accounts }];
      }
      return [];
    });
  } catch {
    return [];
  }
}
