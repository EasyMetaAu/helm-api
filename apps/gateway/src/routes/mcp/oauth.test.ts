import { createHash } from "node:crypto";
import { type ApiKeyRecord, hashKey } from "@helm/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app.js";
import { deriveMcpSigningKey, type McpOAuthDeps, mcpAuth, registerMcpOAuth } from "./oauth.js";

const KEY = "helm_live_secret";
const REDIRECT = "https://chatgpt.com/connector/oauth/abc123";
const ENC_KEY = Buffer.alloc(32, 7);

function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    key_id: "k1",
    hash: hashKey(KEY),
    prefix: "helm_live_ab",
    account_id: "acct-42",
    role: "user",
    name: null,
    allowed_lanes: null,
    allow_custom_model: false,
    allow_fast_mode: false,
    disabled: false,
    rate_limit_rpm: null,
    rate_limit_tpm: null,
    budget_requests: null,
    budget_tokens: null,
    budget_spend_usd: null,
    budget_window_seconds: null,
    over_budget_behavior: "degrade",
    degrade_lane: null,
    concurrency_limit: null,
    memory_mode: "inject",
    memory_project_id: "proj-9",
    memory_thread_source: "header",
    ...overrides,
  };
}

// PKCE S256 challenge for a given verifier (mirrors the client side).
function challengeFor(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function build(rec: ApiKeyRecord | null, overrides: Partial<McpOAuthDeps> = {}) {
  let nowMs = 1_000_000_000_000;
  const deps: McpOAuthDeps = {
    // Hash-faithful: only the real key resolves (a real store returns null for
    // anything else), so a tampered bearer that falls through to API-key auth 401s.
    keyStore: { getByHash: vi.fn(async (h: string) => (rec && h === hashKey(KEY) ? rec : null)) },
    signingKey: deriveMcpSigningKey(ENC_KEY),
    accessTtlSeconds: 3600,
    allowedRedirectPrefixes: ["https://chatgpt.com/connector/oauth/"],
    now: () => nowMs,
    ...overrides,
  };
  const app = new Hono<AppEnv>();
  registerMcpOAuth(app, deps);
  app.use("/mcp", mcpAuth(deps));
  // Probe route: echoes the resolved identity so we can assert auth wiring.
  app.post("/mcp", (c) => {
    const id = c.get("identity");
    return c.json({ accountId: id.accountId, projectId: id.caps.memory.projectId });
  });
  return { app, deps, setNow: (ms: number) => (nowMs = ms) };
}

// Run the GET→POST authorize → POST token flow, returning the access token.
async function fullFlow(app: Hono<AppEnv>, verifier = "verifier-0123456789-abcdefghij") {
  const challenge = challengeFor(verifier);
  const authzQs = new URLSearchParams({
    response_type: "code",
    client_id: "chatgpt",
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: "https://helm.example/mcp",
  }).toString();

  const authzRes = await app.request(`/authorize?${authzQs}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `${authzQs}&api_key=${encodeURIComponent(KEY)}`,
  });
  if (authzRes.status !== 302) return { authzRes, token: null as string | null };
  const loc = new URL(authzRes.headers.get("location") as string);
  const code = loc.searchParams.get("code") as string;

  const tokenRes = await app.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    }).toString(),
  });
  return { authzRes, tokenRes, state: loc.searchParams.get("state") };
}

describe("deriveMcpSigningKey", () => {
  it("is deterministic and distinct from the input key", () => {
    const a = deriveMcpSigningKey(ENC_KEY);
    const b = deriveMcpSigningKey(ENC_KEY);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(ENC_KEY)).toBe(false);
    expect(a.length).toBe(32);
  });
});

describe("discovery metadata", () => {
  it("advertises the resource + AS derived from forwarded headers", async () => {
    const { app } = build(record());
    const res = await app.request("/.well-known/oauth-protected-resource", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "helm.example" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("https://helm.example/mcp");
    expect(body.authorization_servers).toEqual(["https://helm.example"]);
  });

  it("the path-suffixed protected-resource form also resolves", async () => {
    const { app } = build(record());
    const res = await app.request("/.well-known/oauth-protected-resource/mcp", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "helm.example" },
    });
    expect(res.status).toBe(200);
  });

  it("the AS metadata requires S256 PKCE", async () => {
    const { app } = build(record());
    const res = await app.request("/.well-known/oauth-authorization-server", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "helm.example" },
    });
    const body = (await res.json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.authorization_endpoint).toBe("https://helm.example/authorize");
    expect(body.token_endpoint).toBe("https://helm.example/token");
  });
});

describe("GET /authorize", () => {
  it("renders the login form for a valid request", async () => {
    const { app } = build(record());
    const qs = new URLSearchParams({
      response_type: "code",
      redirect_uri: REDIRECT,
      code_challenge: "cc",
      code_challenge_method: "S256",
      state: "st",
    }).toString();
    const res = await app.request(`/authorize?${qs}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="api_key"');
    expect(html).toContain('name="code_challenge" value="cc"');
    expect(html).toContain('name="state" value="st"');
  });

  it("rejects a redirect_uri outside the allowlist", async () => {
    const { app } = build(record());
    const qs = new URLSearchParams({
      redirect_uri: "https://evil.example/cb",
      code_challenge: "cc",
    }).toString();
    const res = await app.request(`/authorize?${qs}`);
    expect(res.status).toBe(400);
  });

  it("requires PKCE (missing code_challenge → 400)", async () => {
    const { app } = build(record());
    const res = await app.request(`/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}`);
    expect(res.status).toBe(400);
  });

  it("escapes reflected params (no XSS)", async () => {
    const { app } = build(record());
    const qs = new URLSearchParams({
      redirect_uri: REDIRECT,
      code_challenge: "cc",
      state: '"><script>x</script>',
    }).toString();
    const res = await app.request(`/authorize?${qs}`);
    const html = await res.text();
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("POST /authorize", () => {
  it("rejects an invalid API key with the form re-rendered", async () => {
    const { app } = build(null); // getByHash → null
    const qs = new URLSearchParams({
      redirect_uri: REDIRECT,
      code_challenge: "cc",
      code_challenge_method: "S256",
    }).toString();
    const res = await app.request("/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `${qs}&api_key=wrong`,
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Invalid or disabled API key");
  });

  it("rejects a disabled key", async () => {
    const { app } = build(record({ disabled: true }));
    const qs = new URLSearchParams({ redirect_uri: REDIRECT, code_challenge: "cc" }).toString();
    const res = await app.request("/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `${qs}&api_key=${encodeURIComponent(KEY)}`,
    });
    expect(res.status).toBe(401);
  });
});

describe("end-to-end authorize → token → /mcp", () => {
  it("issues an access token that resolves to the key's account + project", async () => {
    const { app } = build(record());
    const { authzRes, tokenRes, state } = await fullFlow(app);
    expect(authzRes.status).toBe(302);
    expect(state).toBe("xyz");
    expect(tokenRes?.status).toBe(200);
    const tok = (await tokenRes?.json()) as { access_token: string; token_type: string };
    expect(tok.token_type).toBe("Bearer");

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountId: "acct-42", projectId: "proj-9" });
  });

  it("rejects a token exchange with the wrong PKCE verifier", async () => {
    const { app } = build(record());
    const challenge = challengeFor("the-real-verifier-aaaaaaaaaa");
    const qs = new URLSearchParams({
      response_type: "code",
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const authzRes = await app.request("/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `${qs}&api_key=${encodeURIComponent(KEY)}`,
    });
    const code = new URL(authzRes.headers.get("location") as string).searchParams.get(
      "code",
    ) as string;

    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: "WRONG-verifier-bbbbbbbbbbbb",
        redirect_uri: REDIRECT,
      }).toString(),
    });
    expect(tokenRes.status).toBe(400);
    expect((await tokenRes.json()) as { error: string }).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects an expired authorization code", async () => {
    const { app, setNow } = build(record());
    const verifier = "verifier-cccccccccc-dddddddddd";
    const challenge = challengeFor(verifier);
    const qs = new URLSearchParams({
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const authzRes = await app.request("/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `${qs}&api_key=${encodeURIComponent(KEY)}`,
    });
    const code = new URL(authzRes.headers.get("location") as string).searchParams.get(
      "code",
    ) as string;

    setNow(1_000_000_000_000 + 120_000); // +120s, past the 60s code TTL
    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
      }).toString(),
    });
    expect(tokenRes.status).toBe(400);
  });
});

describe("mcpAuth fallback", () => {
  it("still accepts a raw API key (back-compat)", async () => {
    const { app } = build(record());
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountId: "acct-42", projectId: "proj-9" });
  });

  it("rejects a request with no credentials", async () => {
    const { app } = build(record());
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a forged access token (bad signature)", async () => {
    const { app } = build(record());
    const { tokenRes } = await fullFlow(app);
    const tok = (await tokenRes?.json()) as { access_token: string };
    const tampered = `${tok.access_token.slice(0, -3)}xxx`;
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${tampered}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
