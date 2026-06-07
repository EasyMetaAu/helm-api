import type { Context } from "hono";
import type { AppEnv } from "../../app.js";

// Rule-config writes (RuleStore.set* → yaml-writeback.ts) persist to the mounted
// config/*.yaml BEFORE rebinding the live config (rule-store.ts, fail-closed). A
// persist failure is therefore a LOCAL fault — most commonly EACCES because the
// docker-compose ./config volume is owned by root while the container runs as
// uid 10001 — NOT an upstream provider error. Without this guard the throw falls
// through app.onError's redacted upstream_error(502) fallback and masquerades as
// a provider outage, hiding the actual fix from the operator.
//
// The admin plane is operator-facing (behind basic auth), so surfacing the raw
// fs error message here is the point, not a leak — it names the file that could
// not be written. The data-plane HelmError model (docs/07) is deliberately NOT
// used: admin endpoints speak the plain `{ error: string }` shape.

const FS_PERMISSION_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

const NOT_WRITABLE_HINT =
  " — the config directory is not writable by the gateway process; fix ownership of the mounted ./config volume (e.g. `chown -R 10001:999 config`)";

function errnoCode(err: unknown): string | null {
  if (err instanceof Error && "code" in err) {
    const code = (err as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

// Render a rule-persist failure as an actionable admin 500. Also logs one
// structured error line (the direct c.json return bypasses app.onError's log).
export function rulePersistErrorResponse(c: Context<AppEnv>, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  const code = errnoCode(err);
  const hint = code !== null && FS_PERMISSION_CODES.has(code) ? NOT_WRITABLE_HINT : "";
  c.get("logger").log("error", "admin.rule_persist_failed", {
    trace_id: c.get("trace_id"),
    message,
  });
  return c.json({ error: `failed to persist rule config: ${message}${hint}` }, 500);
}
