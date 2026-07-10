import { describe, expect, it } from "vitest";
import { createCodexModelsEtagTracker } from "./codex-model-etag-tracker.js";

describe("createCodexModelsEtagTracker", () => {
  it("normalizes prerelease versions for record and response lookup", () => {
    const tracker = createCodexModelsEtagTracker();

    expect(tracker.record("key-1", "0.145.0-alpha.4", '"models-v1"')).toBe(true);
    expect(tracker.forResponse("key-1", "0.145.0")).toBe('"models-v1"');
    expect(tracker.forResponse("key-1", "0.145.0-beta.1")).toBe('"models-v1"');
  });

  it("returns a different synthetic ETag after invalidation until models are relisted", () => {
    const tracker = createCodexModelsEtagTracker();
    tracker.record("key-1", "0.145.0", '"models-v1"');

    tracker.invalidate();
    const stale = tracker.forResponse("key-1", "0.145.0");

    expect(stale).toMatch(/^"helm-codex-stale-/);
    expect(stale).not.toBe('"models-v1"');
    expect(tracker.forResponse("key-1", "0.145.0")).toBe(stale);

    tracker.record("key-1", "0.145.0", '"models-v2"');
    expect(tracker.forResponse("key-1", "0.145.0")).toBe('"models-v2"');
  });

  it("uses a synthetic ETag for a valid unlisted version and rejects invalid versions", () => {
    const tracker = createCodexModelsEtagTracker();

    expect(tracker.forResponse("key-1", "0.145.0")).toMatch(/^"helm-codex-stale-/);
    expect(tracker.record("key-1", "latest", '"models-v1"')).toBe(false);
    expect(tracker.forResponse("key-1", "latest")).toBeNull();
  });

  it("bounds tracked key/version entries and evicts the least recently used entry", () => {
    const tracker = createCodexModelsEtagTracker({ maxEntries: 2 });
    tracker.record("key-1", "0.145.0", '"models-1"');
    tracker.record("key-2", "0.145.0", '"models-2"');
    expect(tracker.forResponse("key-1", "0.145.0")).toBe('"models-1"');

    tracker.record("key-3", "0.145.0", '"models-3"');

    expect(tracker.forResponse("key-1", "0.145.0")).toBe('"models-1"');
    expect(tracker.forResponse("key-2", "0.145.0")).toMatch(/^"helm-codex-stale-/);
    expect(tracker.forResponse("key-3", "0.145.0")).toBe('"models-3"');
  });
});
