import { createHmac, randomBytes } from "node:crypto";
import type { ConfigStore } from "@helm/core";
import { decryptSecret, encryptSecret, redact } from "@helm/core";
import { type DecisionRecord, DecisionRecordSchema } from "@helm/shared";

// Atomic initialization works across gateway replicas and restarts. This random
// server-only salt is not derived from an email, API key, or public configuration.
export async function loadPortalPseudonymSecret(
  store: ConfigStore,
  encKey?: Buffer | null,
): Promise<string | null> {
  const key = "portal.pseudonym-secret.v1";
  // A custom/read-only store must not disable headless gateway traffic. Without
  // durable initialization (or decryption), only Portal projections fail closed.
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await store.get(key);
      if (existing?.startsWith("v1:")) return encKey ? decryptSecret(existing, encKey) : null;
      if (existing && !/^[a-f0-9]{64}$/.test(existing)) return null;
      if (existing && !encKey) return existing;
      if (!store.compareAndSet) return null;
      const secret = existing ?? randomBytes(32).toString("hex");
      if (await store.compareAndSet(key, existing, encKey ? encryptSecret(secret, encKey) : secret))
        return secret;
    }
    return null;
  } catch {
    return null;
  }
}

const allowedHeader =
  /^(?:x-request-id|request-id|x-amzn-requestid|cf-ray|openai-processing-ms|retry-after|anthropic-ratelimit-[a-z0-9-]+|x-ratelimit-[a-z0-9-]+)$/i;
const email =
  /[\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,10}/giu;
const hideEmails = (value: string) =>
  (value.includes("@") ? value.replace(email, "[redacted-account]") : value).replace(
    /org-[A-Za-z0-9]+/g,
    "[redacted-organization]",
  );

function safeHeaders(value: unknown): unknown {
  const entries: Array<[string, unknown]> = [];
  if (Array.isArray(value)) {
    if (value.every((v) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string")) {
      for (const pair of value) entries.push([pair[0], pair[1]]);
    } else {
      for (let i = 0; i + 1 < value.length; i += 2)
        if (typeof value[i] === "string") entries.push([value[i], value[i + 1]]);
    }
  } else if (value && typeof value === "object") entries.push(...Object.entries(value));
  else return null;
  return Object.fromEntries(
    entries
      .filter(([name]) => allowedHeader.test(name))
      .map(([name, v]) => [name.toLowerCase(), redactPortalDiagnostics(v)]),
  );
}

export function redactPortalDiagnostics(value: unknown): unknown {
  if (typeof value === "string") return hideEmails(value);
  if (Array.isArray(value)) return value.map(redactPortalDiagnostics);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, v]) => {
      if (
        /^(?:stack|cause|x-codex-turn-metadata)$/i.test(key) ||
        /^(?:x[-_])?(?:codex[-_])?installation[-_]id(?:[-_]client)?$/i.test(key)
      )
        return [];
      if (/headers?$/i.test(key)) return [[key, safeHeaders(v)]];
      if (
        /^(?:account|account_ref|account_id|account_uuid|email|user_id)$/i.test(key) &&
        typeof v === "string"
      )
        return [[key, "[redacted-account]"]];
      return [[hideEmails(key), redactPortalDiagnostics(v)]];
    }),
  );
}

export function createPortalDecisionProjection(secret = randomBytes(32).toString("hex")) {
  const pseudonym = (provider: string, account: string) =>
    `acct_${createHmac("sha256", secret)
      .update(JSON.stringify([provider, account]))
      .digest("hex")
      .slice(0, 24)}`;

  return (input: DecisionRecord): DecisionRecord => {
    const record = redact(DecisionRecordSchema.parse(input), { payloadKeys: [] });
    // HMAC only producer-owned identity fields: arbitrary text must not provide
    // a chosen-input oracle for low-entropy upstream account identities.
    const safe = DecisionRecordSchema.parse(redactPortalDiagnostics(record));
    const serving = record.serving_account;
    if (serving && safe.serving_account) {
      safe.serving_account.account = pseudonym(serving.provider_id, serving.account);
      if (serving.selection && safe.serving_account.selection) {
        safe.serving_account.selection.candidates = serving.selection.candidates.map(
          (candidate) => ({
            ...candidate,
            account: pseudonym(serving.provider_id, candidate.account),
          }),
        );
      }
    }
    for (const [index, attempt] of record.provider_attempts.entries()) {
      const outbound = safe.provider_attempts[index]?.outbound_requests;
      if (outbound)
        for (const [i, audit] of (attempt.outbound_requests ?? []).entries()) {
          if (audit.account_ref && outbound[i])
            outbound[i].account_ref = pseudonym(
              `${attempt.provider_name ?? "unknown"}:outbound`,
              audit.account_ref,
            );
        }
    }
    return safe;
  };
}
