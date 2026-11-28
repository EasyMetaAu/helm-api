import { DecisionRecordSchema } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { createPortalDecisionProjection, loadPortalPseudonymSecret } from "./privacy.js";

function record() {
  return DecisionRecordSchema.parse({
    request_id: "request",
    trace_id: "owner@gmail.com",
    requested_model: "auto",
    classifier: {
      task_type: "chat",
      complexity: "low",
      confidence: 1,
      decided_by: "rules",
      eval_cache_hit: null,
      constraints: {},
      explanation: [],
    },
    policy: { matched_policy_id: null, reason: "" },
    lane: { selected_lane: "balanced", candidate_chain: [] },
    provider_attempts: [
      {
        alias: "model",
        skipped: false,
        skip_reason: null,
        status: "error",
        error_class: "upstream_error",
        latency_ms: 1,
        cost_usd: null,
        error_detail: {
          upstream_status: 429,
          message: "owner@gmail.com",
          provider_raw: {
            account: "owner@gmail.com",
            account_ref: "owner@gmail.com",
            installation_id: "raw-installation",
            nested: { "x-codex-installation-id": "header-installation" },
          },
        },
        passthrough_mutations: {
          codex_installation_id: "bound-installation",
          codex_installation_id_client: "client-installation",
          codex_installation_id_source: "rebound",
        },
      },
    ],
    final: { model_alias: null, provider_model: null, status: "error", error_reason: "quota" },
    serving_account: { provider_id: "claude", account: "owner@gmail.com" },
  });
}

describe("portal account privacy", () => {
  it("does not provide a pseudonym oracle through client trace IDs or reflected error fields", () => {
    const project = createPortalDecisionProjection("test-server-secret");
    const out = project(record());
    const account = out.serving_account!.account;
    expect(account).toMatch(/^acct_[a-f0-9]{24}$/);
    expect(out.trace_id).not.toContain(account);
    expect(JSON.stringify(out.provider_attempts[0]?.error_detail)).not.toContain(account);
    expect(JSON.stringify(out)).not.toContain("gmail.com");
    expect(project(record()).serving_account!.account).toBe(account);
    const other = record();
    other.serving_account!.provider_id = "other-provider";
    expect(project(other).serving_account!.account).not.toBe(account);
  });
  it("drops both rebound and client installation identifiers recursively", () => {
    expect(JSON.stringify(createPortalDecisionProjection("secret")(record()))).not.toContain(
      "-installation",
    );
  });
  it("atomically initializes one durable secret across concurrent starts", async () => {
    const values = new Map<string, string>();
    const store = {
      get: async (k: string) => values.get(k) ?? null,
      set: async (k: string, v: string) => {
        values.set(k, v);
      },
      compareAndSet: async (k: string, old: string | null, next: string) => {
        if ((values.get(k) ?? null) !== old) return false;
        values.set(k, next);
        return true;
      },
    };
    const [a, b] = await Promise.all([
      loadPortalPseudonymSecret(store),
      loadPortalPseudonymSecret(store),
    ]);
    expect(a).toBe(b);
    expect(await loadPortalPseudonymSecret(store)).toBe(a);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

it("sanitizes every header container and Unicode emails and organization IDs", () => {
  const input = record();
  input.provider_attempts[0]!.error_detail!.provider_raw = {
    message: "quota org-AbC123 for 用户@example.com",
    Headers: { "x-request-id": "keep", "openai-organization": "PRIVATE" },
    response_headers: [
      ["CF-Ray", "keep-ray"],
      ["Authorization", "PRIVATE"],
    ],
    rawHeaders: ["request-id", "keep-id", "OpenAI-Organization", "PRIVATE"],
  };
  const out = JSON.stringify(createPortalDecisionProjection("secret")(input));
  expect(out).not.toMatch(/PRIVATE|org-AbC123|用户@example.com/);
  expect(out).toContain("keep-ray");
  expect(out).toContain("keep-id");
});

it("encrypts and atomically upgrades an existing pseudonym secret without changing it", async () => {
  const values = new Map([["portal.pseudonym-secret.v1", "a".repeat(64)]]);
  const store = {
    get: async (k: string) => values.get(k) ?? null,
    set: async (k: string, v: string) => {
      values.set(k, v);
    },
    compareAndSet: async (k: string, old: string | null, next: string) => {
      if ((values.get(k) ?? null) !== old) return false;
      values.set(k, next);
      return true;
    },
  };
  const key = Buffer.alloc(32, 5);
  expect(await loadPortalPseudonymSecret(store, key)).toBe("a".repeat(64));
  expect(values.get("portal.pseudonym-secret.v1")).toMatch(/^v1:/);
  expect(await loadPortalPseudonymSecret(store, key)).toBe("a".repeat(64));
  expect(await loadPortalPseudonymSecret(store)).toBeNull();
});

it("does not block gateway startup for non-atomic custom config stores", async () => {
  expect(
    await loadPortalPseudonymSecret({ get: async () => null, set: async () => {} }),
  ).toBeNull();
});
