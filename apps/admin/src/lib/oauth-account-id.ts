// The account-detail route keys on a single path segment that must carry BOTH the
// provider id and the account (an email, containing '@' and '.'). Encode as
// `<provider>:<account>` then percent-encode the whole thing so '@'/'.'/'/' survive
// the URL. Decode splits on the FIRST ':' only (a provider id never contains ':',
// but an account theoretically could). Pure — shared by the link builder and loader.

export function encodeAccountId(providerId: string, account: string): string {
  return encodeURIComponent(`${providerId}:${account}`);
}

export function decodeAccountId(param: string): { providerId: string; account: string } | null {
  const raw = decodeURIComponent(param);
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx >= raw.length - 1) return null;
  return { providerId: raw.slice(0, idx), account: raw.slice(idx + 1) };
}

// `<base>/providers/<encoded>` — the account-detail link for a provider row.
export function accountDetailHref(base: string, providerId: string, account: string): string {
  return `${base}/providers/${encodeAccountId(providerId, account)}`;
}
