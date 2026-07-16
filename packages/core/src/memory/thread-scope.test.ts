import { describe, expect, it } from "vitest";
import {
  clientThreadIdFromStorageId,
  ownerScopedThreadId,
  projectScopedThreadId,
  quarantinedParentThreadId,
  quarantinedRawThreadId,
} from "./thread-scope.js";

describe("Memory physical thread scope", () => {
  it.each([
    "thread",
    "acct:thread",
    "v2:n:thread",
    "v2:p:00:thread",
    "线程:一",
  ])("round-trips opaque client id %s through a trusted project-scoped row", (clientThreadId) => {
    const physical = projectScopedThreadId("acct", "项目", clientThreadId);
    expect(clientThreadIdFromStorageId(physical, "acct")).toBe(clientThreadId);
  });

  it("decodes a proven legacy owner-scoped row", () => {
    const physical = ownerScopedThreadId("acct:one", "thread:one");
    expect(clientThreadIdFromStorageId(physical, "acct:one")).toBe("thread:one");
  });

  it("does not decode raw or mismatched storage values without trusted ownership", () => {
    expect(clientThreadIdFromStorageId("opaque:thread")).toBe("opaque:thread");
    const otherOwner = projectScopedThreadId("other", "p1", "thread");
    expect(clientThreadIdFromStorageId(otherOwner, "acct")).toBe(otherOwner);
  });

  it("keeps parent quarantine distinct from normal v2 ids and recovers the legacy client id", () => {
    const legacy = ownerScopedThreadId("acct", "thread:one");
    const quarantined = quarantinedParentThreadId("acct", legacy);

    expect(quarantined).toMatch(/^v2:q:p:/);
    expect(quarantined).not.toBe(projectScopedThreadId("acct", null, "thread:one"));
    expect(clientThreadIdFromStorageId(quarantined, "acct")).toBe("thread:one");
    expect(clientThreadIdFromStorageId(quarantined, "other")).toBe(quarantined);
  });

  it.each(["acct:foo", "v2:n:acct:foo", "v2:p:00:acct:foo", "线程:一"])(
    "preserves ambiguous raw long-tier id %s inside a separate quarantine namespace",
    (rawClientId) => {
      const quarantined = quarantinedRawThreadId("acct", rawClientId);
      expect(quarantined).toMatch(/^v2:q:r:/);
      expect(clientThreadIdFromStorageId(quarantined, "acct")).toBe(rawClientId);
      expect(clientThreadIdFromStorageId(quarantined, "other")).toBe(quarantined);
    },
  );

  it("separates parent, raw, owner, and live-v2 namespaces deterministically", () => {
    const opaque = "v2:n:acct:同一线程";
    const parent = quarantinedParentThreadId("acct", opaque);
    const raw = quarantinedRawThreadId("acct", opaque);

    expect(parent).not.toBe(raw);
    expect(parent).not.toBe(quarantinedParentThreadId("other", opaque));
    expect(raw).not.toBe(quarantinedRawThreadId("other", opaque));
    expect(parent).not.toMatch(/^v2:[pn]:/);
    expect(raw).not.toMatch(/^v2:[pn]:/);
    expect(quarantinedParentThreadId("acct", opaque)).toBe(parent);
    expect(quarantinedRawThreadId("acct", opaque)).toBe(raw);
  });
});
