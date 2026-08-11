import { describe, expect, it } from "vitest";
import { restoreSessionRequestJson, restoreSessionRevisionJson } from "./session-delta.js";

// These tests build revision rows from hand-written delta/envelope literals so the
// shared restore logic is verified WITHOUT importing the core write-side splitter.
// Envelope = the request with the event carrier emptied ([]); delta = the suffix
// events persisted for that revision.

describe("restoreSessionRequestJson", () => {
  it("reinserts events into the emptied carrier", () => {
    expect(
      restoreSessionRequestJson(
        '{"model":"x","messages":[]}',
        '[{"role":"user","content":"one"},{"role":"assistant","content":"two"}]',
      ),
    ).toBe(
      '{"model":"x","messages":[{"role":"user","content":"one"},{"role":"assistant","content":"two"}]}',
    );
  });
});

describe("restoreSessionRevisionJson", () => {
  it("appends each revision's suffix along a linear messages chain", () => {
    expect(
      restoreSessionRevisionJson(
        [
          {
            requestId: "root",
            parentRequestId: null,
            retainCount: 0,
            requestDeltaJson: '[{"role":"user","content":"one"}]',
            requestEnvelopeJson: '{"model":"x","messages":[]}',
          },
          {
            requestId: "next",
            parentRequestId: "root",
            retainCount: 1,
            requestDeltaJson: '[{"role":"assistant","content":"two"}]',
            requestEnvelopeJson: '{"model":"x","messages":[]}',
          },
        ],
        "next",
      ),
    ).toBe(
      '{"model":"x","messages":[{"role":"user","content":"one"},{"role":"assistant","content":"two"}]}',
    );
  });

  it("reconstructs a long linear chain without copying the full prefix per revision", () => {
    const revisions = Array.from({ length: 40_000 }, (_, index) => ({
      requestId: `request-${index}`,
      parentRequestId: index === 0 ? null : `request-${index - 1}`,
      retainCount: index,
      requestDeltaJson: `[${index}]`,
      requestEnvelopeJson: '{"messages":[]}',
    }));

    const restored = JSON.parse(
      restoreSessionRevisionJson(revisions, `request-${revisions.length - 1}`),
    ) as { messages: number[] };

    expect(restored.messages).toHaveLength(revisions.length);
    expect(restored.messages.at(-1)).toBe(revisions.length - 1);
  }, 1_000);

  it("restores a branch from its explicit parent rather than its newest sibling", () => {
    expect(
      restoreSessionRevisionJson(
        [
          {
            requestId: "root",
            parentRequestId: null,
            retainCount: 0,
            requestDeltaJson: '["one"]',
            requestEnvelopeJson: '{"messages":[]}',
          },
          {
            requestId: "left",
            parentRequestId: "root",
            retainCount: 1,
            requestDeltaJson: '["left"]',
            requestEnvelopeJson: '{"messages":[]}',
          },
          {
            requestId: "right",
            parentRequestId: "root",
            retainCount: 1,
            requestDeltaJson: '["right"]',
            requestEnvelopeJson: '{"messages":[]}',
          },
        ],
        "right",
      ),
    ).toBe('{"messages":["one","right"]}');
  });

  it("expands a Responses continuation with the parent output and drops the opaque pointer", () => {
    expect(
      restoreSessionRevisionJson(
        [
          {
            requestId: "root",
            parentRequestId: null,
            retainCount: 0,
            requestDeltaJson: '[{"role":"user","content":"one"}]',
            requestEnvelopeJson: '{"model":"gpt-5","input":[]}',
            responseId: "resp_1",
            responseJson:
              '{"id":"resp_1","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}]}',
          },
          {
            requestId: "child",
            parentRequestId: "root",
            retainCount: 0,
            requestDeltaJson: '[{"role":"user","content":"two"}]',
            requestEnvelopeJson: '{"model":"gpt-5","previous_response_id":"resp_1","input":[]}',
            responseJson: null,
          },
        ],
        "child",
      ),
    ).toBe(
      '{"model":"gpt-5","input":[{"role":"user","content":"one"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]},{"role":"user","content":"two"}]}',
    );
  });

  it("fails closed when a linked Responses parent has no output array", () => {
    expect(() =>
      restoreSessionRevisionJson(
        [
          {
            requestId: "root",
            parentRequestId: null,
            retainCount: 0,
            requestDeltaJson: '["root"]',
            requestEnvelopeJson: '{"input":[]}',
            responseId: "resp_root",
            responseJson: '{"id":"resp_root","output":null}',
          },
          {
            requestId: "child",
            parentRequestId: "root",
            retainCount: 0,
            requestDeltaJson: '["child"]',
            requestEnvelopeJson: '{"previous_response_id":"resp_root","input":[]}',
            responseJson: null,
          },
        ],
        "child",
      ),
    ).toThrow("session response output unavailable");
  });

  it("rejects a continuation whose opaque id does not match its linked parent", () => {
    expect(() =>
      restoreSessionRevisionJson(
        [
          {
            requestId: "root",
            parentRequestId: null,
            retainCount: 0,
            requestDeltaJson: '["root"]',
            requestEnvelopeJson: '{"input":[]}',
            responseId: "resp_different",
            responseJson: '{"id":"resp_different","output":[]}',
          },
          {
            requestId: "child",
            parentRequestId: "root",
            retainCount: 0,
            requestDeltaJson: '["child"]',
            requestEnvelopeJson: '{"previous_response_id":"resp_expected","input":[]}',
            responseJson: null,
          },
        ],
        "child",
      ),
    ).toThrow("session continuation response mismatch");
  });

  it("rejects a corrupted parent cycle instead of recursing forever", () => {
    expect(() =>
      restoreSessionRevisionJson(
        [
          {
            requestId: "one",
            parentRequestId: "two",
            retainCount: 0,
            requestDeltaJson: "[]",
            requestEnvelopeJson: '{"messages":[]}',
          },
          {
            requestId: "two",
            parentRequestId: "one",
            retainCount: 0,
            requestDeltaJson: "[]",
            requestEnvelopeJson: '{"messages":[]}',
          },
        ],
        "one",
      ),
    ).toThrow("session revision cycle");
  });

  it.each([-1, 1.5])("rejects a corrupt retain_count %s", (retainCount) => {
    expect(() =>
      restoreSessionRevisionJson(
        [
          {
            requestId: "bad",
            parentRequestId: null,
            retainCount,
            requestDeltaJson: "[]",
            requestEnvelopeJson: '{"messages":[]}',
            responseJson: null,
          },
        ],
        "bad",
      ),
    ).toThrow("invalid session retain_count");
  });

  it("rejects a non-array persisted delta", () => {
    expect(() =>
      restoreSessionRevisionJson(
        [
          {
            requestId: "bad",
            parentRequestId: null,
            retainCount: 0,
            requestDeltaJson: '{"not":"an array"}',
            requestEnvelopeJson: '{"messages":[]}',
            responseJson: null,
          },
        ],
        "bad",
      ),
    ).toThrow("session revision delta must be an array");
  });
});
