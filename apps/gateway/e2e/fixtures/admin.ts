// e2e.admin fixtures — credentials + seed helpers for the admin-UI end-to-end.
//
// The admin specs run against the SAME real gateway the other e2e specs use
// (e2e/fixtures/test-server.ts), built from the adapter-static SPA in
// apps/admin/build and served by Hono at /admin. We do NOT mock the front-end
// and do NOT call core directly — every assertion goes through the real HTTP
// authenticated Admin surface (docs/11).
//
// Credentials are injected into the gateway process via env (HELM_ADMIN_ENABLED
// / HELM_ADMIN_USER / HELM_ADMIN_PASSWORD; env wins over config — docs/11). The
// SAME values are mirrored here so Playwright's pre-emptive Authorization header
// and the seed requests authenticate. They are test-only constants, never real secrets,
// and never the API-key auth credential (which is Bearer, separate surface).

export const ADMIN_USER = "e2e-admin";
export const ADMIN_PASSWORD = "e2e-admin-pw";

// A test-only API-key PREFIX we expect to see (prefix-only) in the request
// debug views. The full plaintext below must NEVER appear in any admin page
// (Principle 7 redaction smoke test) — only its prefix may.
export const SEED_KEY_PREFIX = "helm_live_seed";
export const SEED_KEY_PLAINTEXT = "helm_live_seed_PLAINTEXT_MUST_NOT_LEAK_abcdef";

// The trace id of the pre-seeded decision record the requests views must show.
export const SEED_TRACE_ID = "e2e-admin-trace-1";

// The Basic credentials as the gateway expects them (env-injected).
export const adminEnv = {
  HELM_ADMIN_ENABLED: "1",
  HELM_ADMIN_USER: ADMIN_USER,
  HELM_ADMIN_PASSWORD: ADMIN_PASSWORD,
};

// Encode the Basic auth header value the way a browser would.
export function basicHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}
