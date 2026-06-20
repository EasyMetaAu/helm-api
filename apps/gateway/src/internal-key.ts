// Fixed key_id of the auto-minted internal LLM key. The gateway re-mints this key at
// every startup (server.ts) so internal memory + eval LLM calls can authenticate their
// self-HTTP calls to /v1 (memory-self-http.ts). It is PROTECTED from admin revoke/delete
// (routes/admin/keys.ts) — removing it mid-run would silently break internal LLM calls
// (they fail-open to the deterministic stub) until the next restart re-mints it.
export const INTERNAL_API_KEY_ID = "k_internal";
