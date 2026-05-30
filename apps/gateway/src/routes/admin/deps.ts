import type { CreateKeyInput, KeyStore, Lane, PoliciesConfig, TelemetryStore } from "@helm/core";
import type { ClassifierConfig, DecisionRecord } from "@helm/shared";

// Injected dependency contracts for the admin API. Per CLAUDE.md principle 1 the
// route files are PURE HTTP glue — they own no business logic and never touch the
// filesystem or DB directly. Two落点 are deliberately separate (CLAUDE.md 原则2
// 配置即代码):
//   - RULE config (lanes / policies / classifier) -> RuleStore (config/*.yaml or
//     a runtime ConfigStore). Versionable, never the DB.
//   - RUNTIME state (keys / telemetry) -> KeyStore / TelemetryStore. Never yaml.
// The concrete RuleStore (YAML-backed) is wired in server.ts; tests inject an
// in-memory fake so the routes stay framework- and IO-free to unit test.

// A typed read/write seam for the rule configs. Each accessor returns/accepts an
// already-validated config object — the routes Zod-validate the inbound body
// BEFORE calling `set*` so an invalid config is rejected (400) and never written
// (fail-closed, 原则2). `lanes` is a name->Lane map matching LanesConfig minus the
// `balanced`-required refinement concern (the route enforces shape via LaneSchema).
export interface RuleStore {
  getLanes(): Promise<Record<string, Lane>>;
  setLanes(lanes: Record<string, Lane>): Promise<void>;
  getPolicies(): Promise<PoliciesConfig>;
  setPolicies(policies: PoliciesConfig): Promise<void>;
  getClassifier(): Promise<ClassifierConfig>;
  setClassifier(cfg: ClassifierConfig): Promise<void>;
}

// Key creation needs to mint a plaintext + hash + prefix. We inject the generator
// (auth.keygen.generateKey) so the route never depends on crypto directly and the
// plaintext is produced at exactly one place, returned once, never persisted.
export interface GeneratedKeyParts {
  plaintext: string;
  hash: string;
  prefix: string;
}

export interface AdminApiDeps {
  rules: RuleStore;
  keyStore: KeyStore;
  telemetry: TelemetryStore;
  // Mint a fresh key (crypto). Injected for testability + single-source plaintext.
  genKey: () => GeneratedKeyParts;
  // Generate a key_id for a new key. Injected so tests get deterministic ids.
  genKeyId: () => string;
  // The account a newly-created admin key belongs to (MVP: single account).
  accountId: string;
}

// Re-exported for route signatures.
export type { CreateKeyInput };

// ── Wire shapes (admin-API-only response/request projections) ────────────────

// A redacted key summary for the list view: prefix only, NEVER hash full-text or
// plaintext (原则7, docs/06). `key_id` identifies the row for revocation.
export interface KeySummary {
  key_id: string;
  prefix: string;
  role: "root" | "user";
  max_lane: string | null;
  allowed_lanes: string[] | null;
  allow_custom_model: boolean;
  disabled: boolean;
}

// New-key response: the ONLY place plaintext is ever returned, once.
export interface CreatedKey {
  key_id: string;
  plaintext: string;
}

// Request-debug detail: the full decision trail (docs/07). BOTH the list and the
// detail endpoints return the whole DecisionRecord — it already carries
// classification层级, 命中策略, lane 候选链, provider 尝试, 成本, 错误, trace_id and
// contains NO plaintext key/payload, so the SPA stays a pure consumer (原则1) and
// the two fallback stages stay distinct (原则5) without backend re-projection.
export type RequestDetail = DecisionRecord;
