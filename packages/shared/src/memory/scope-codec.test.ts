import { describe, expect, it } from "vitest";
import { decodeScopeId, encodeScopeId } from "./scope-codec.js";

// D1: memory_jobs.scope_id is a single TEXT column but a ReflectionScope has up to
// three levels. We encode it as canonical JSON (omit-undefined, stable key order)
// so the same scope always yields the same string (dedupe-friendly) and decodes
// back losslessly — robust to ids containing separator characters.

describe("scope codec", () => {
  it("round-trips a full scope", () => {
    const scope = { accountId: "acct-a", projectId: "p1", resourceId: "r1", threadId: "t1" };
    expect(decodeScopeId(encodeScopeId(scope))).toEqual(scope);
  });

  it("round-trips a thread-only scope", () => {
    const scope = { accountId: "acct-a", threadId: "t1" };
    expect(decodeScopeId(encodeScopeId(scope))).toEqual(scope);
  });

  it("is stable regardless of key insertion order (dedupe-friendly)", () => {
    const a = encodeScopeId({ accountId: "acct-a", threadId: "t1", projectId: "p1" });
    const b = encodeScopeId({ accountId: "acct-a", projectId: "p1", threadId: "t1" });
    expect(a).toBe(b);
  });

  it("omits undefined levels (no null leakage)", () => {
    const encoded = encodeScopeId({ accountId: "acct-a", threadId: "t1" });
    expect(encoded).not.toContain("project");
    expect(encoded).not.toContain("null");
  });

  it("survives ids containing JSON/separator characters", () => {
    const scope = { accountId: "acct-a", threadId: 't"1:{},', projectId: "p|1" };
    expect(decodeScopeId(encodeScopeId(scope))).toEqual(scope);
  });
});
