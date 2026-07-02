import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";
import { registerOAuthRoutes } from "./oauth.js";
import type { OAuthTester, TestStreamEvent } from "./oauth-test.js";

function app(deps: Partial<AdminApiDeps>) {
  const a = new Hono<AppEnv>();
  registerOAuthRoutes(a, deps as AdminApiDeps);
  return a;
}

const JSONH = { "Content-Type": "application/json" };

// Build an OAuthTester whose test() replays a fixed event list, or runs a custom
// async generator (for the mid-stream error case). vi.fn so we can assert params.
function testerOf(events: TestStreamEvent[] | (() => AsyncIterable<TestStreamEvent>)): OAuthTester {
  const gen = (): AsyncIterable<TestStreamEvent> => {
    if (typeof events === "function") return events();
    return (async function* () {
      for (const e of events) yield e;
    })();
  };
  return { test: vi.fn(() => gen()) };
}

// Pull the JSON payloads out of the `data:` lines of an SSE response body.
function sseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>);
}

describe("POST /admin/api/oauth/:provider/test", () => {
  it("503s when no tester is wired (OAuth disabled)", async () => {
    const res = await app({}).request("/admin/api/oauth/anthropic/test", {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify({ account: "default", model: "m" }),
    });
    expect(res.status).toBe(503);
  });

  it("400s when account or model is missing", async () => {
    const a = app({ oauthTester: testerOf([]) });
    const noAccount = await a.request("/admin/api/oauth/anthropic/test", {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify({ model: "m" }),
    });
    expect(noAccount.status).toBe(400);
    const noModel = await a.request("/admin/api/oauth/anthropic/test", {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify({ account: "default" }),
    });
    expect(noModel.status).toBe(400);
  });

  it("streams start -> content -> finish -> done as SSE and forwards the params", async () => {
    const tester = testerOf([
      { type: "content", text: "He" },
      { type: "content", text: "llo" },
      { type: "finish", reason: "stop" },
    ]);
    const res = await app({ oauthTester: tester }).request("/admin/api/oauth/anthropic/test", {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify({ account: "default", model: "claude-x", prompt: "yo" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = sseEvents(await res.text());
    expect(events[0]).toMatchObject({ type: "start", model: "claude-x" });
    expect(
      events
        .filter((e) => e.type === "content")
        .map((e) => e.text)
        .join(""),
    ).toBe("Hello");
    expect(events.some((e) => e.type === "finish")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done" });

    expect(tester.test).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "anthropic",
        account: "default",
        model: "claude-x",
        prompt: "yo",
      }),
    );
  });

  it("records successful test usage and clears any stale account cooldown", async () => {
    const tester = testerOf([
      { type: "content", text: "OK" },
      { type: "usage", promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      { type: "finish", reason: "stop" },
    ]);
    const oauthUsage = {
      record: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthUsage"];
    const applyUsageLimit = vi.fn(async () => {});

    const res = await app({ oauthTester: tester, oauthUsage, applyUsageLimit }).request(
      "/admin/api/oauth/anthropic/test",
      {
        method: "POST",
        headers: JSONH,
        body: JSON.stringify({ account: "default", model: "claude-x" }),
      },
    );

    expect(res.status).toBe(200);
    expect(sseEvents(await res.text()).at(-1)).toMatchObject({ type: "done" });
    expect(oauthUsage?.record).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "anthropic",
        account: "default",
        tokens: 12,
        costUsd: null,
      }),
    );
    expect(applyUsageLimit).toHaveBeenCalledWith("anthropic", "default", null, "replace");
  });

  it("emits an in-band error event (HTTP 200, not 5xx) when the tester throws mid-stream", async () => {
    const tester = testerOf(() =>
      (async function* () {
        yield { type: "content", text: "partial" } as TestStreamEvent;
        throw new Error("upstream returned 429");
      })(),
    );
    const res = await app({ oauthTester: tester }).request("/admin/api/oauth/anthropic/test", {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify({ account: "default", model: "m" }),
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    const err = events.find((e) => e.type === "error");
    expect(err?.error).toMatch(/429/);
    // No spurious done event after a failure.
    expect(events.some((e) => e.type === "done")).toBe(false);
  });
});
