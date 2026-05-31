import type { ExecutionResult, RouteOptions } from "@helm/core";
import { makeHelmError } from "@helm/shared";
import { describe, expect, it } from "vitest";
import type { MessagesIdentity } from "./messages.js";
import { createMessagesPipeline, PipelineError, type RouteFn } from "./messages-pipeline.js";

// messages-pipeline — the framework-agnostic bridge injected into both
// /v1/messages and /v1/responses. These tests pin the FAILURE seams the route
// handlers depend on: an all-providers-failed routing outcome and an empty
// request must surface as a structured PipelineError (never an empty 200), and
// per-key lane caps must be threaded into the route options.

const IDENTITY: MessagesIdentity = { keyId: "k1", accountId: "acct" };

function irOf(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    model: "claude-3-5-sonnet",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    metadata: { trace_id: "trace-1" },
    ...over,
  };
}

// Build an ExecutionResult-shaped stub. The pipeline reads body/stream/final/error.
function okResult(body: unknown): ExecutionResult {
  return {
    decision: { lane: { selected_lane: "balanced" } } as unknown as ExecutionResult["decision"],
    final: { status: "ok", alias: "x" },
    body,
    stream: null,
    error: null,
  };
}

function errorResult(stream: AsyncIterable<string> | null = null): ExecutionResult {
  return {
    decision: { lane: { selected_lane: "balanced" } } as unknown as ExecutionResult["decision"],
    final: { status: "error" },
    body: null,
    stream,
    error: makeHelmError({
      error_class: "all_providers_failed",
      message: "all providers failed",
      trace_id: "trace-1",
    }),
  };
}

describe("createMessagesPipeline — failure surfaces", () => {
  it("collect() throws a structured PipelineError when routing fails (no empty 200)", async () => {
    const route: RouteFn = async () => errorResult();
    const pipeline = createMessagesPipeline(route);
    const run = await pipeline.run(irOf(), IDENTITY, new AbortController().signal);
    await expect(run.collect()).rejects.toBeInstanceOf(PipelineError);
    await expect(run.collect()).rejects.toMatchObject({ error_class: "all_providers_failed" });
  });

  it("streamIR() throws a structured PipelineError when the stream is null after a failure", async () => {
    const route: RouteFn = async () => errorResult(null);
    const pipeline = createMessagesPipeline(route);
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    const iterate = async () => {
      for await (const _ of run.streamIR()) {
        // should never yield — the failure must throw before any event
      }
    };
    await expect(iterate()).rejects.toBeInstanceOf(PipelineError);
  });

  it("run() throws invalid_request when ir.messages is empty (no placeholder, no billing)", async () => {
    let routed = false;
    const route: RouteFn = async () => {
      routed = true;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route);
    await expect(
      pipeline.run(irOf({ messages: [] }), IDENTITY, new AbortController().signal),
    ).rejects.toMatchObject({ error_class: "invalid_request" });
    expect(routed).toBe(false);
  });

  it("run() throws invalid_request when ir.messages is missing/non-array", async () => {
    const route: RouteFn = async () => okResult({ id: "x" });
    const pipeline = createMessagesPipeline(route);
    await expect(
      pipeline.run(irOf({ messages: undefined }), IDENTITY, new AbortController().signal),
    ).rejects.toMatchObject({ error_class: "invalid_request" });
  });

  it("threads per-key lane caps from identity.caps into the route options", async () => {
    let sawOpts: RouteOptions | null = null;
    const route: RouteFn = async (_req, opts) => {
      sawOpts = opts;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route);
    const identity: MessagesIdentity = {
      keyId: "k1",
      accountId: "acct",
      caps: { allowCustomModel: false, maxLane: "economy", allowedLanes: null },
    };
    await pipeline.run(irOf(), identity, new AbortController().signal);
    expect(sawOpts).not.toBeNull();
    expect((sawOpts as RouteOptions | null)?.keyCaps).toEqual({
      maxLane: "economy",
      allowedLanes: null,
    });
  });

  it("threads null keyCaps when identity carries no caps", async () => {
    let sawOpts: RouteOptions | null = null;
    const route: RouteFn = async (_req, opts) => {
      sawOpts = opts;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route);
    await pipeline.run(irOf(), IDENTITY, new AbortController().signal);
    expect((sawOpts as RouteOptions | null)?.keyCaps).toEqual({
      maxLane: null,
      allowedLanes: null,
    });
  });
});
