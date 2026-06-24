import { expect, test } from "@playwright/test";
import { CAPTURE_PATH, type UpstreamCapture } from "./fixtures/mock-upstream.js";

// e2e.memory (docs/08 Phase 2) — black-box the inject + background-worker chain
// over real HTTP into a real gateway + the deterministic mock upstream. The unit
// tests prove inject assembly + the queue + the worker in isolation; this spec
// proves the SEAMS hold end-to-end:
//   (1) a streamed inject request still produces a correct SSE stream (inject must
//       not break protocol translation — CLAUDE.md principle 8 / docs/05);
//   (2) the assembled memory prefix actually reaches the upstream request;
//   (3) the background worker drains the enqueued observer job off the request path
//       (the inject request enqueues; the worker compresses LATER);
//   (4) inject is fully fail-open — a degenerate inject request still returns 200.
//
// Determinism: the mock is offline + fixed; the worker runs on a 250ms interval
// (playwright.config HELM_MEMORY_WORKER_INTERVAL_MS) so the drain happens inside
// the test window. Prompts hit the Layer-1 rule classifier (eval OFF).

const TEST_KEY = "helm_live_e2e_testkey";
const OPENAI_AUTH = { Authorization: `Bearer ${TEST_KEY}`, "Content-Type": "application/json" };
const MOCK_BASE_URL = `http://127.0.0.1:${process.env.MOCK_PORT ?? "8181"}`;

async function lastUpstreamRequest(request: {
  get: (url: string) => Promise<{ json: () => Promise<UpstreamCapture> }>;
}): Promise<UpstreamCapture> {
  const res = await request.get(`${MOCK_BASE_URL}${CAPTURE_PATH}`);
  return res.json();
}

function memHeaders(threadId: string) {
  return {
    ...OPENAI_AUTH,
    "x-memory-mode": "inject",
    "x-thread-id": threadId,
  };
}

test.describe("memory inject + worker", () => {
  test("streaming inject request produces a correct SSE stream", async ({ request }) => {
    const threadId = `t-stream-${Date.now()}`;

    // Seed prior turns on the thread (observe writes the originals).
    await request.post("/v1/chat/completions", {
      headers: { ...OPENAI_AUTH, "x-memory-mode": "observe", "x-thread-id": threadId },
      data: { model: "auto", messages: [{ role: "user", content: "remember: my name is Ada" }] },
    });

    // Now a STREAMING inject request on the same thread.
    const res = await request.post("/v1/chat/completions", {
      headers: memHeaders(threadId),
      data: { model: "auto", stream: true, messages: [{ role: "user", content: "who am I?" }] },
    });

    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/event-stream");
    const body = await res.text();
    // The SSE stream is intact: at least one data frame + the terminal [DONE].
    expect(body).toContain("data:");
    expect(body).toContain("[DONE]");
  });

  test("a compacted observation of dropped turns reaches the upstream request", async ({
    request,
  }) => {
    const threadId = `t-prefix-${Date.now()}`;

    // #230 trailing-reminder model: inject NO LONGER re-injects verbatim recent
    // turns (the client owns the live window). It injects DISTILLED memory —
    // facts / observations / reflections — as a trailing <system-reminder>. So to
    // prove the inject seam end-to-end we must first make the deterministic
    // observer FORM an observation: cross the size trigger (segment_min_tokens =
    // 2048), which ALWAYS compacts — memory formation is not economically gated
    // (compaction-policy.ts). Seed with INJECT-mode turns: compaction is enqueued
    // on the INJECT path (observe is write-only and never enqueues an observer
    // job — pure-observe threads defer compaction to idle-flush). Large turns
    // clear the size threshold.
    const filler = "lorem ipsum dolor sit amet consectetur ".repeat(90); // ~3.5 KB/turn
    for (let i = 0; i < 5; i++) {
      const res = await request.post("/v1/chat/completions", {
        headers: memHeaders(threadId),
        data: {
          model: "auto",
          messages: [{ role: "user", content: `marker-turn-${i}: ${filler}` }],
        },
      });
      expect(res.status()).toBe(200);
    }
    // Worker (250ms interval) drains the observer job + compacts the oldest segment.
    await new Promise((r) => setTimeout(r, 1500));

    // A fresh single-turn inject request: the observation covers dropped turns that
    // are NOT in this window, so it is non-redundant and rides upstream as a
    // trailing <system-reminder>, alongside the verbatim current turn.
    const res = await request.post("/v1/chat/completions", {
      headers: memHeaders(threadId),
      data: { model: "auto", messages: [{ role: "user", content: "what did we discuss?" }] },
    });
    expect(res.status()).toBe(200);

    const upstream = await lastUpstreamRequest(request);
    const contents = (upstream.body.messages ?? [])
      .map((m) => {
        const c = (m as { content?: unknown }).content;
        return typeof c === "string" ? c : "";
      })
      .join("\n");
    // The current turn rides through verbatim; the distilled observation of the
    // oldest (now dropped) turns is injected alongside it.
    expect(contents).toContain("what did we discuss?");
    expect(contents).toContain("marker-turn-0");
  });

  test("the background worker drains the enqueued observer job off the request path", async ({
    request,
  }) => {
    const threadId = `t-drain-${Date.now()}`;

    // Each turn enqueues an observer job (deduped to one pending) and returns
    // immediately — compaction happens LATER on the worker, never on the request
    // path. Seed enough large turns to clear the size trigger so the worker has a
    // compactable segment.
    const filler = "the quick brown fox jumps over the lazy dog ".repeat(80); // ~3.5 KB/turn
    for (let i = 0; i < 5; i++) {
      const res = await request.post("/v1/chat/completions", {
        headers: memHeaders(threadId),
        data: {
          model: "auto",
          messages: [{ role: "user", content: `drain-turn-${i}: ${filler}` }],
        },
      });
      expect(res.status()).toBe(200);
    }

    // The worker runs on a 250ms interval; give it a few ticks to claim + compress.
    // Proof the drain happened OFF the request path: the deterministic observation
    // exists ONLY after the worker ran, and a later inject request surfaces it (the
    // enqueuing requests above all returned 200 before any compaction).
    await new Promise((r) => setTimeout(r, 1500));

    const res = await request.post("/v1/chat/completions", {
      headers: memHeaders(threadId),
      data: { model: "auto", messages: [{ role: "user", content: "final question" }] },
    });
    expect(res.status()).toBe(200);
    const upstream = await lastUpstreamRequest(request);
    const contents = (upstream.body.messages ?? [])
      .map((m) => {
        const c = (m as { content?: unknown }).content;
        return typeof c === "string" ? c : "";
      })
      .join("\n");
    // The worker-produced observation of the dropped turns reached upstream.
    expect(contents).toContain("drain-turn-0");
    expect(contents).toContain("final question");
  });

  test("fail-open: an inject request with NO thread still returns 200", async ({ request }) => {
    // mode=inject but no x-thread-id: there is no memory to load + no writeback
    // target. inject must degrade to the minimal context and route normally.
    const res = await request.post("/v1/chat/completions", {
      headers: { ...OPENAI_AUTH, "x-memory-mode": "inject" },
      data: { model: "auto", messages: [{ role: "user", content: "hello with no thread" }] },
    });
    expect(res.status()).toBe(200);
    const upstream = await lastUpstreamRequest(request);
    const contents = (upstream.body.messages ?? [])
      .map((m) => {
        const c = (m as { content?: unknown }).content;
        return typeof c === "string" ? c : "";
      })
      .join("\n");
    expect(contents).toContain("hello with no thread");
  });
});
