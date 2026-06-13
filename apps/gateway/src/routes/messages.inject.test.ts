import type { ExecutionResult, InjectDeps, ObserveDeps, RouteOptions } from "@helm/core";
import type { InternalRequest } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  type MessagesIdentity,
  type MessagesRouteDeps,
  registerMessagesRoute,
} from "./messages.js";
import { createMessagesPipeline, type InjectWiring, type RouteFn } from "./messages-pipeline.js";

// gateway.messages.inject (docs/08 Phase 2, #217 Phase 4 TRAILING-REMINDER model) —
// PROVE the inject-phase wiring through the shared pipeline that backs /v1/messages,
// /v1/responses AND the Gemini surface. The pipeline is identical across the surfaces
// (only the stamped Protocol differs for telemetry), so we exercise it over the
// /v1/messages route with ALL THREE Protocol values: the assembled memory block is
// APPENDED as ONE trailing <system-reminder> user turn AFTER the VERBATIM live
// conversation (no full-replace, no system-prefix edit, no D7 gate) so the client's
// cached prefix is untouched; non-inject modes leave messages untouched; inject is
// fail-open.

const AUTH = { "x-api-key": "helm_live_secret", "Content-Type": "application/json" };
const IDENTITY: MessagesIdentity = { keyId: "k1", accountId: "acct" };
const INJECT_HEADERS = { "x-memory-mode": "inject", "x-thread-id": "t1", "x-project-id": "p1" };

function makeFakeStore(opts: {
  reflection?: string;
  observations?: string[];
  recent?: Array<{ role: "user" | "assistant"; content: string }>;
}) {
  const store = {
    ensureThread: vi.fn(async () => {}),
    appendMessage: vi.fn(async () => "m"),
    listMessages: vi.fn(async () =>
      (opts.recent ?? []).map((m, i) => ({
        id: `r${i}`,
        threadId: "t1",
        role: m.role,
        content: m.content,
        tokenEstimate: 2,
        createdAt: new Date(2026, 0, 1, 0, 0, i),
      })),
    ),
    appendObservation: vi.fn(async () => "o"),
    listObservations: vi.fn(async () =>
      (opts.observations ?? []).map((text, i) => ({
        id: `o${i}`,
        threadId: "t1",
        sourceMessageRange: ["a", "b"] as [string, string],
        observationText: text,
        observedAt: new Date(2026, 0, 1, 0, 0, i),
      })),
    ),
    getReflection: vi.fn(async (scope: { projectId?: string }) =>
      scope.projectId !== undefined && opts.reflection !== undefined
        ? {
            id: "ref",
            projectId: scope.projectId,
            resourceId: null,
            threadId: null,
            reflectionText: opts.reflection,
            version: 1,
            tokenEstimate: 4,
            updatedAt: new Date(2026, 0, 1),
          }
        : null,
    ),
    upsertReflection: vi.fn(async () => "r"),
    updateJobStatus: vi.fn(async () => {}),
    enqueueJob: vi.fn(async () => "job-1"),
    claimPendingJobs: vi.fn(async () => []),
  };
  return { store };
}

function observeDeps(store: unknown): ObserveDeps {
  return {
    memoryStore: store as ObserveDeps["memoryStore"],
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    estimateTokens: (t: string) => Math.ceil(t.length / 4),
    log: vi.fn(),
  };
}

function injectWiring(store: unknown): InjectWiring {
  const deps: InjectDeps = {
    memoryStore: store as InjectDeps["memoryStore"],
    estimateTokens: (t: string) => Math.ceil(t.length / 4),
    enqueueObserverJob: async () => "job-x",
    costSink: vi.fn(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    log: vi.fn(),
  };
  return { deps, tokenBudget: 4000 };
}

function captureRoute(): { route: RouteFn; seen: InternalRequest[] } {
  const seen: InternalRequest[] = [];
  const route: RouteFn = async (req: InternalRequest, _o: RouteOptions) => {
    seen.push(JSON.parse(JSON.stringify(req)) as InternalRequest);
    return {
      decision: { lane: { selected_lane: "balanced" } },
      final: { status: "ok" },
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      stream: null,
      error: null,
    } as unknown as ExecutionResult;
  };
  return { route, seen };
}

// Build the route around a real pipeline. The transformer HOISTS a top-level
// `system` into a leading IR system message — exactly what the real Anthropic
// inbound transformer does — so the pipeline reads systemPrompt from messages[0].
function buildApp(opts: {
  route: RouteFn;
  protocol: "anthropic_messages" | "openai_responses" | "gemini";
  memory?: { observe: ObserveDeps; inject?: InjectWiring };
}) {
  const pipeline = createMessagesPipeline(opts.route, opts.protocol, opts.memory);
  const deps: MessagesRouteDeps = {
    auth: { resolve: async () => IDENTITY },
    transformers: {
      anthropic: {
        transformRequestOut: (native: unknown) => {
          const n = native as Record<string, unknown>;
          const msgs = Array.isArray(n.messages) ? [...n.messages] : [];
          if (typeof n.system === "string") {
            msgs.unshift({ role: "system", content: n.system });
          }
          return { model: n.model, messages: msgs, stream: false, metadata: {} };
        },
        transformResponseOut: (ir: unknown) => ({ type: "message", __ir: ir }),
        transformStreamOut: (ev: { type: string }) => ({
          event: ev.type,
          data: JSON.stringify(ev),
        }),
        transformErrorOut: (err: { message: string }) => ({
          status: 502,
          body: { type: "error", error: { message: err.message } },
        }),
      },
    },
    pipeline,
  };
  const app = createApp({ logger: { log: () => {} } });
  registerMessagesRoute(app, deps);
  return app;
}

const SURFACE = "/v1/messages";
for (const protocol of ["anthropic_messages", "openai_responses", "gemini"] as const) {
  const surface = SURFACE;
  describe(`gateway.inject — pipeline protocol=${protocol}`, () => {
    it("APPENDS memory as a trailing <system-reminder> turn, conversation verbatim (#217 Phase 4)", async () => {
      const { store } = makeFakeStore({
        reflection: "PROJECT REFLECTION",
        observations: ["OBS-1"],
        recent: [{ role: "user", content: "earlier turn" }],
      });
      const { route, seen } = captureRoute();
      const app = buildApp({
        route,
        protocol,
        memory: { observe: observeDeps(store), inject: injectWiring(store) },
      });

      const res = await app.request(surface, {
        method: "POST",
        headers: { ...AUTH, ...INJECT_HEADERS },
        body: JSON.stringify({
          model: "claude-3-5-sonnet",
          system: "be terse",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(res.status).toBe(200);
      const msgs = seen[0]?.messages as Array<{ role: string; content: string }>;
      // TRAILING-REMINDER model: the hoisted system prompt "be terse" and the live turn
      // ride through VERBATIM (cached prefix untouched); memory is ONE trailing
      // <system-reminder> user turn carrying the reflection + observation. "earlier turn"
      // was only loaded for window-dedup, never re-injected.
      expect(msgs).toHaveLength(3);
      expect(msgs[0]).toEqual({ role: "system", content: "be terse" });
      expect(msgs[1]).toEqual({ role: "user", content: "hi" });
      expect(msgs[2]?.role).toBe("user");
      expect(msgs[2]?.content).toContain("PROJECT REFLECTION");
      expect(msgs[2]?.content).toContain("OBS-1");
      expect(msgs[2]?.content.startsWith("<system-reminder>")).toBe(true);
      expect(msgs[2]?.content.endsWith("</system-reminder>")).toBe(true);
    });

    it("preserves developer instructions under x-memory-mode=inject instead of silently dropping them", async () => {
      const { store } = makeFakeStore({
        reflection: "PROJECT REFLECTION",
        observations: ["OBS-1"],
        recent: [{ role: "user", content: "earlier turn" }],
      });
      const { route, seen } = captureRoute();
      const app = buildApp({
        route,
        protocol,
        memory: { observe: observeDeps(store), inject: injectWiring(store) },
      });

      const res = await app.request(surface, {
        method: "POST",
        headers: { ...AUTH, ...INJECT_HEADERS },
        body: JSON.stringify({
          model: "m",
          messages: [
            { role: "developer", content: "Always answer in JSON." },
            { role: "system", content: "be terse" },
            { role: "user", content: "hi" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      // TRAILING-REMINDER model: EVERY original turn (developer + system + user) rides
      // verbatim, in order; the memory block is appended as ONE trailing <system-reminder>
      // user turn — developer instructions preserved, never silently dropped, the live
      // conversation untouched.
      const msgs = seen[0]?.messages as Array<{ role: string; content: string }>;
      expect(msgs.slice(0, 3)).toEqual([
        { role: "developer", content: "Always answer in JSON." },
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ]);
      expect(msgs[3]?.role).toBe("user");
      expect(msgs[3]?.content).toContain("PROJECT REFLECTION");
      expect(msgs[3]?.content.startsWith("<system-reminder>")).toBe(true);
    });

    it("leaves messages untouched when mode is observe (not inject)", async () => {
      const { store } = makeFakeStore({ reflection: "R", observations: ["O"] });
      const { route, seen } = captureRoute();
      const app = buildApp({
        route,
        protocol,
        memory: { observe: observeDeps(store), inject: injectWiring(store) },
      });

      await app.request(surface, {
        method: "POST",
        headers: { ...AUTH, "x-memory-mode": "observe", "x-thread-id": "t1" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });

      expect(seen[0]?.messages).toEqual([{ role: "user", content: "hi" }]);
    });

    it("fail-open: store load failure preserves the ORIGINAL multi-turn messages", async () => {
      const { store } = makeFakeStore({});
      store.listObservations.mockRejectedValue(new Error("db down"));
      store.listMessages.mockRejectedValue(new Error("db down"));
      store.getReflection.mockRejectedValue(new Error("db down"));
      const { route, seen } = captureRoute();
      const app = buildApp({
        route,
        protocol,
        memory: { observe: observeDeps(store), inject: injectWiring(store) },
      });

      const res = await app.request(surface, {
        method: "POST",
        headers: { ...AUTH, ...INJECT_HEADERS },
        body: JSON.stringify({
          model: "m",
          system: "be terse",
          messages: [
            { role: "user", content: "old question" },
            { role: "assistant", content: "old answer" },
            { role: "user", content: "hi" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      expect(seen[0]?.messages).toEqual([
        { role: "system", content: "be terse" },
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "hi" },
      ]);
    });
  });
}

// P3 (review follow-up): the inject metadata the bridge computes must not be
// dropped at the gateway boundary — the pipeline stamps it onto the
// DecisionRecord so telemetry / the debug UI can see what memory did.
describe("gateway.inject — decision record metadata", () => {
  it("stamps inject metadata onto the decision record", async () => {
    const { store } = makeFakeStore({
      reflection: "PROJECT REFLECTION",
      observations: ["OBS-1"],
      recent: [],
    });
    // Keep a reference to the decision object the fake route returns so the
    // pipeline's post-route stamping is observable.
    const decision: Record<string, unknown> = {
      lane: { selected_lane: "balanced" },
      final: { status: "ok" },
    };
    const route: RouteFn = async () =>
      ({
        decision,
        final: { status: "ok" },
        body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
        stream: null,
        error: null,
      }) as unknown as ExecutionResult;
    const app = buildApp({
      route,
      protocol: "anthropic_messages",
      memory: { observe: observeDeps(store), inject: injectWiring(store) },
    });

    const res = await app.request(SURFACE, {
      method: "POST",
      headers: { ...AUTH, ...INJECT_HEADERS },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(200);
    expect(decision.memory).toMatchObject({
      memory_hydrated: true,
      observation_count: 1,
      memory_writeback_status: "queued",
    });
  });
});

// Issue #97 — ZERO-CLIENT-CHANGE memory on the Anthropic surface: key defaults
// turn memory on; the thread derives from body metadata.user_id (the
// session-stable hash Claude Code / OpenClaw already send). No x-memory-* headers.
describe("gateway.inject — per-key defaults + metadata.user_id fallback (issue #97)", () => {
  const MEMORY_IDENTITY: MessagesIdentity = {
    keyId: "k1",
    accountId: "acct",
    caps: {
      memory: { mode: "inject", projectId: "proj-key", threadSource: "auto" },
    },
  };

  it("hydrates with ZERO memory headers: key defaults + metadata.user_id as thread", async () => {
    const { store } = makeFakeStore({
      reflection: "PROJECT REFLECTION",
      observations: [],
      recent: [],
    });
    const { route, seen } = captureRoute();
    const pipeline = createMessagesPipeline(route, "anthropic_messages", {
      observe: observeDeps(store),
      inject: injectWiring(store),
    });
    const app = createApp({ logger: { log: () => {} } });
    registerMessagesRoute(app, {
      auth: { resolve: async () => MEMORY_IDENTITY },
      transformers: {
        anthropic: {
          transformRequestOut: (native: unknown) => {
            const n = native as Record<string, unknown>;
            return { model: n.model, messages: n.messages, stream: false, metadata: {} };
          },
          transformResponseOut: (ir: unknown) => ({ type: "message", __ir: ir }),
          transformStreamOut: (ev: { type: string }) => ({
            event: ev.type,
            data: JSON.stringify(ev),
          }),
          transformErrorOut: (err: { message: string }) => ({
            status: 502,
            body: { type: "error", error: { message: err.message } },
          }),
        },
      },
      pipeline,
    } as Parameters<typeof registerMessagesRoute>[1]);

    const res = await app.request(SURFACE, {
      method: "POST",
      headers: AUTH, // ← no x-memory-* headers
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: "cc-session-hash-1" },
      }),
    });

    expect(res.status).toBe(200);
    const msgs = seen[0]?.messages as Array<{ role: string; content: string }>;
    // The key default project's reflection was hydrated into the trailing <system-reminder>
    // user turn (TRAILING-REMINDER model) — appended after the conversation, not merged
    // into a system message, so assert containment on that trailing turn.
    expect(
      msgs.some(
        (m) =>
          m.role === "user" &&
          m.content.includes("PROJECT REFLECTION") &&
          m.content.startsWith("<system-reminder>"),
      ),
    ).toBe(true);
    // The derived thread is owner-scoped (account prefix) like an explicit one.
    expect(store.ensureThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acct:cc-session-hash-1" }),
    );
  });
});
