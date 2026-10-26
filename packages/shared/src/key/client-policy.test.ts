import { describe, expect, it } from "vitest";
import { ClientPolicySchema, classifyClient, evaluateClientPolicy } from "./client-policy.js";
import { CreateKeyRequestSchema, UpdateKeyRequestSchema } from "./schema.js";

describe("client access policy", () => {
  it.each([
    [
      "Codex Desktop/0.162.0-alpha.17.2 (Mac OS 26.6.2; arm64) unknown (Codex Desktop; 26.1007.30912)",
      "codex_app",
    ],
    ["codex-tui/0.159.0 (Mac OS 26.6.2; arm64) xterm-256color (codex-tui; 0.159.0)", "codex_cli"],
    ["codex_exec/0.159.0 (Mac OS 26.6.2; arm64) dumb", "codex_cli"],
    ["codex_cli_rs/0.100.0 (linux; x86_64)", "codex_cli"],
    ["codex_desktop/dev (macOS; arm64)", "codex_app"],
    ["CODEX-DESKTOP/20261026 (Windows; x64)", "codex_app"],
    ["Codex Desktop (macOS; arm64)", "codex_app"],
    ["Codex Desktop/next+build (macOS; arm64)", "codex_app"],
    ["codex-tui/nightly (linux; x86_64)", "codex_cli"],
    ["CODEX_EXEC/dev", "codex_cli"],
    ["codex_cli_rs (linux; x86_64)", "codex_cli"],
    ["claude-cli/2.1.295 (external, sdk-cli)", "claude_cli"],
    ["claude-cli/2.2.0 (external, cli)", "claude_cli"],
    ["grok-shell/1.0.50 (macos; aarch64)", "grok_cli"],
    [
      "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Claude/2.7032.0 Chrome/152.0 Electron/44.4.3 Safari/537.36",
      "claude_desktop",
    ],
  ])("recognizes the product boundary in %s", (ua, client) => {
    expect(classifyClient(ua)).toBe(client);
  });
  it.each([
    undefined,
    "",
    "curl/8",
    "not-Codex Desktop/1.0",
    "codex_desktop_helper/dev",
    "not-codex_desktop/dev",
    "codex-desktop-evil/dev",
    "Codex Desktop/",
    "Codex Desktop/dev/extra",
    "codex-tui/",
    "Mozilla/5.0 Electron/44.0",
    "claude-cli/2.1.0 (external, unknown)",
    "Codex Desktop/1.0\r\nInjected: yes",
    "x".repeat(4097),
  ])("rejects unknown or malformed UA %s", (ua) => {
    expect(classifyClient(ua)).toBeNull();
    expect(evaluateClientPolicy({ allowed_clients: ["codex_app"] }, ua).allowed).toBe(false);
  });
  it("rejects conflicting recognized products", () => {
    expect(classifyClient("Mozilla/5.0 Claude/2.0 Codex Desktop/1.0")).toBeNull();
    expect(classifyClient("codex_desktop/dev claude-cli/2.0 (external, cli)")).toBeNull();
    expect(classifyClient("codex_desktop/dev codex_exec/nightly")).toBeNull();
  });
  it("recognizes Codex identity independently of release numbering", () => {
    for (const version of ["1", "20261026", "nightly", "next+build", "vNext", "0.0.0-alpha.1"]) {
      const ua = `codex_desktop/${version} (Mac OS; arm64)`;
      expect(evaluateClientPolicy({ allowed_clients: ["codex_app"] }, ua)).toMatchObject({
        allowed: true,
        client: "codex_app",
      });
      expect(evaluateClientPolicy({ allowed_clients: ["codex_cli"] }, ua).allowed).toBe(false);
    }
  });
  it("keeps disabled and legacy policies unrestricted, but malformed policies fail closed", () => {
    expect(evaluateClientPolicy(null, undefined).allowed).toBe(true);
    expect(evaluateClientPolicy(undefined, "unknown").allowed).toBe(true);
    expect(evaluateClientPolicy({ allowed_clients: [] }, "codex-tui/1.0").allowed).toBe(false);
    expect(evaluateClientPolicy({ allowed_clients: ["future"] }, "codex-tui/1.0").allowed).toBe(
      false,
    );
  });
  it("allows only selected clients without mutating the policy", () => {
    const policy = { allowed_clients: ["codex_app", "grok_cli"] };
    expect(evaluateClientPolicy(policy, "Codex Desktop/2.0").allowed).toBe(true);
    expect(evaluateClientPolicy(policy, "codex_exec/2.0").allowed).toBe(false);
    expect(policy.allowed_clients).toEqual(["codex_app", "grok_cli"]);
  });
  it("validates nonempty bounded policy and partial update semantics", () => {
    expect(ClientPolicySchema.safeParse({ allowed_clients: [] }).success).toBe(false);
    expect(
      ClientPolicySchema.safeParse({ allowed_clients: ["codex_app"], bypass: true }).success,
    ).toBe(false);
    expect(
      CreateKeyRequestSchema.parse({ client_policy: { allowed_clients: ["codex_app"] } })
        .client_policy,
    ).toEqual({ allowed_clients: ["codex_app"] });
    expect(UpdateKeyRequestSchema.parse({ client_policy: null }).client_policy).toBeNull();
    expect(UpdateKeyRequestSchema.parse({}).client_policy).toBeUndefined();
  });
});
