import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveSessionCapture, stampSessionCapture } from "./session-capture.js";

function headers(values: Record<string, string | undefined>): (name: string) => string | undefined {
  return (name) => values[name];
}

const scope = { accountId: "account-a", apiKeyId: "key-a" };
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

describe("resolveSessionCapture", () => {
  it("uses the explicit sources in fixed precedence order", () => {
    const native = { metadata: { thread_id: "metadata-thread", conversation_id: "conversation" } };

    expect(
      resolveSessionCapture(
        headers({ "x-thread-id": "header-thread", "x-session-key": "key" }),
        native,
        scope,
      ),
    ).toMatchObject({ rawId: "header-thread", source: "x-thread-id" });
    expect(resolveSessionCapture(headers({ "x-session-key": "key" }), native, scope)).toMatchObject(
      {
        rawId: "metadata-thread",
        source: "metadata.thread_id",
      },
    );
    expect(
      resolveSessionCapture(
        headers({ "x-session-key": "key" }),
        { metadata: { conversation_id: "conversation" } },
        scope,
      ),
    ).toMatchObject({ rawId: "conversation", source: "metadata.conversation_id" });
    expect(resolveSessionCapture(headers({ "x-session-key": "key" }), {}, scope)).toMatchObject({
      rawId: "key",
      source: "x-session-key",
    });
  });

  it("returns stable raw-id and scope hashes without exposing identity in the reference", () => {
    const resolved = resolveSessionCapture(headers({ "x-thread-id": "thread-1" }), {}, scope);

    expect(resolved).toEqual({
      rawId: "thread-1",
      source: "x-thread-id",
      fingerprint: sha256("thread-1"),
      sessionRef: sha256(JSON.stringify(["account-a", "key-a", "x-thread-id", "thread-1"])),
    });
    expect(
      resolveSessionCapture(
        headers({ "x-thread-id": "thread-1" }),
        {},
        { ...scope, apiKeyId: "key-b" },
      )?.sessionRef,
    ).not.toBe(resolved?.sessionRef);
  });

  it("recognizes inbound Codex and Claude Code session signals", () => {
    expect(
      resolveSessionCapture(headers({ "thread-id": "codex-thread" }), {}, scope),
    ).toMatchObject({
      rawId: "codex-thread",
      source: "thread-id",
    });
    expect(
      resolveSessionCapture(
        headers({}),
        {
          metadata: {
            user_id: JSON.stringify({ device_id: "device", session_id: "claude-session" }),
          },
        },
        scope,
      ),
    ).toMatchObject({
      rawId: "claude-session",
      source: "metadata.user_id.session_id",
    });
    expect(
      resolveSessionCapture(headers({ "session-id": "codex-session" }), {}, scope),
    ).toMatchObject({
      rawId: "codex-session",
      source: "session-id",
    });
  });

  it("accepts metadata.user_id only when it is a JSON object with a valid session_id", () => {
    for (const userId of [
      "plain-user",
      "[]",
      "null",
      '{"session_id":1}',
      '{"session_id":"bad\\nvalue"}',
    ]) {
      expect(
        resolveSessionCapture(headers({}), { metadata: { user_id: userId } }, scope),
      ).toBeNull();
    }
  });

  it.each([
    "",
    "bad\nvalue",
    "bad\u007fvalue",
    "x".repeat(257),
  ])("rejects an invalid selected identifier", (value) => {
    expect(
      resolveSessionCapture(
        headers({ "x-thread-id": value, "x-session-key": "fallback" }),
        {},
        scope,
      ),
    ).toBeNull();
  });

  it("ignores non-string body metadata and returns null when no source is valid", () => {
    expect(
      resolveSessionCapture(
        headers({}),
        { metadata: { thread_id: 1, conversation_id: [] } },
        scope,
      ),
    ).toBeNull();
    expect(resolveSessionCapture(headers({}), null, scope)).toBeNull();
  });

  it("stamps only the bounded session metadata onto a decision", () => {
    const decision = { session: null } as never;
    stampSessionCapture(
      decision,
      resolveSessionCapture(headers({ "x-thread-id": "thread-1" }), {}, scope),
      scope,
    );
    expect((decision as { session: unknown }).session).toEqual({
      ref: sha256(JSON.stringify(["account-a", "key-a", "x-thread-id", "thread-1"])),
      label: "thread-1",
      source: "x-thread-id",
    });
  });

  it("derives a one-request Session when the client supplies no usable identifier", () => {
    const decision = { request_id: "request-fallback", session: null } as never;
    const fallbackLabel = `helm-request:${sha256("request-fallback")}`;

    stampSessionCapture(decision, null, scope);

    expect((decision as { session: unknown }).session).toEqual({
      ref: sha256(JSON.stringify(["account-a", "key-a", "request_id", "request-fallback"])),
      label: fallbackLabel,
      source: "session-id",
    });
    expect(resolveSessionCapture(headers({ "session-id": fallbackLabel }), {}, scope)).toBeNull();
    const otherKey = { ...scope, apiKeyId: "key-b" };
    const otherDecision = { request_id: "request-fallback", session: null } as never;
    stampSessionCapture(otherDecision, null, otherKey);
    expect((otherDecision as { session: { ref: string } }).session.ref).not.toBe(
      (decision as { session: { ref: string } }).session.ref,
    );
  });
});
