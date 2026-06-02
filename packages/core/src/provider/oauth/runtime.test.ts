import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildOAuthRequestSignal,
  createOAuthLoginCancelledError,
  generateOAuthState,
  generatePKCE,
  nonNegativeSecondsToSafeMs,
  parseOAuthAuthorizationInput,
  resolveExpiresAtMsFromEpochSeconds,
  resolveOAuthTokenExpiresAt,
  throwIfOAuthLoginAborted,
  withOAuthLoginAbort,
} from "./runtime.js";

const b64url = (s: string) =>
  Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

describe("PKCE + state", () => {
  it("derives an S256 challenge as base64url(sha256(verifier))", () => {
    const { verifier, challenge } = generatePKCE();
    const expected = b64url(createHash("sha256").update(verifier).digest().toString("binary"));
    // recompute directly to avoid binary-string pitfalls
    const direct = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(challenge).toBe(direct);
    expect(challenge).not.toContain("=");
    expect(expected.length).toBeGreaterThan(0);
  });

  it("produces unique verifiers and states", () => {
    expect(generatePKCE().verifier).not.toBe(generatePKCE().verifier);
    expect(generateOAuthState()).not.toBe(generateOAuthState());
  });
});

describe("parseOAuthAuthorizationInput", () => {
  it("parses a full redirect URL", () => {
    expect(parseOAuthAuthorizationInput("http://localhost:1455/cb?code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
  });
  it("parses a code#state pair", () => {
    expect(parseOAuthAuthorizationInput("abc#xyz")).toEqual({ code: "abc", state: "xyz" });
  });
  it("parses a bare query string", () => {
    expect(parseOAuthAuthorizationInput("code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
  });
  it("treats a bare value as the code", () => {
    expect(parseOAuthAuthorizationInput("just-a-code")).toEqual({ code: "just-a-code" });
  });
  it("returns empty for blank input", () => {
    expect(parseOAuthAuthorizationInput("   ")).toEqual({});
  });
});

describe("expiry math", () => {
  it("converts expires_in seconds to absolute ms minus skew", () => {
    expect(resolveOAuthTokenExpiresAt(3600, { nowMs: 1_000_000, refreshSkewMs: 60_000 })).toBe(
      1_000_000 + 3_600_000 - 60_000,
    );
  });
  it("rejects non-positive / non-numeric durations", () => {
    expect(resolveOAuthTokenExpiresAt(0)).toBeUndefined();
    expect(resolveOAuthTokenExpiresAt("nope")).toBeUndefined();
  });
  it("converts epoch-seconds expires_at to ms minus buffer", () => {
    expect(resolveExpiresAtMsFromEpochSeconds(2000, { bufferMs: 1000 })).toBe(2_000_000 - 1000);
  });
  it("nonNegativeSecondsToSafeMs allows zero, rejects negatives", () => {
    expect(nonNegativeSecondsToSafeMs(0)).toBe(0);
    expect(nonNegativeSecondsToSafeMs(-1)).toBeUndefined();
  });
});

describe("abort helpers", () => {
  it("throwIfOAuthLoginAborted throws only when aborted", () => {
    const c = new AbortController();
    expect(() => throwIfOAuthLoginAborted(c.signal)).not.toThrow();
    c.abort();
    expect(() => throwIfOAuthLoginAborted(c.signal)).toThrow("Login cancelled");
  });

  it("withOAuthLoginAbort rejects + runs onAbort when the signal fires", async () => {
    const c = new AbortController();
    let cleaned = false;
    const p = withOAuthLoginAbort(new Promise(() => {}), c.signal, () => {
      cleaned = true;
    });
    c.abort();
    await expect(p).rejects.toThrow("Login cancelled");
    expect(cleaned).toBe(true);
  });

  it("withOAuthLoginAbort resolves normally without a signal", async () => {
    await expect(withOAuthLoginAbort(Promise.resolve(42))).resolves.toBe(42);
  });

  it("buildOAuthRequestSignal returns an AbortSignal", () => {
    expect(buildOAuthRequestSignal({ timeoutMs: 1000 })).toBeInstanceOf(AbortSignal);
  });

  it("createOAuthLoginCancelledError has the canonical message", () => {
    expect(createOAuthLoginCancelledError().message).toBe("Login cancelled");
  });
});
