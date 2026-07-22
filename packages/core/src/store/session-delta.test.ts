import { describe, expect, it } from "vitest";
import {
  restoreSessionRequestJson,
  restoreSessionRevisionJson,
  splitSessionRequestJson,
} from "./session-delta.js";

describe("session request delta", () => {
  it("stores only the new suffix after a linear messages prefix", () => {
    const first = splitSessionRequestJson(
      '{"model":"x","messages":[{"role":"user","content":"one"}]}',
    );
    const second = splitSessionRequestJson(
      '{"model":"x","messages":[{"role":"user","content":"one"},{"role":"assistant","content":"two"}]}',
      first.eventsJson,
    );
    expect(second).toMatchObject({ eventKey: "messages", retainCount: 1 });
    expect(second.eventsJson).toBe('[{"role":"assistant","content":"two"}]');
    expect(
      restoreSessionRequestJson(
        second.envelopeJson,
        '[{"role":"user","content":"one"},{"role":"assistant","content":"two"}]',
      ),
    ).toBe(
      '{"model":"x","messages":[{"role":"user","content":"one"},{"role":"assistant","content":"two"}]}',
    );
  });

  it("restores a branch from its explicit parent rather than its newest sibling", () => {
    const root = splitSessionRequestJson('{"messages":["one"]}');
    const left = splitSessionRequestJson('{"messages":["one","left"]}', root.eventsJson);
    const right = splitSessionRequestJson('{"messages":["one","right"]}', root.eventsJson);
    expect(
      restoreSessionRevisionJson(
        [
          {
            requestId: "root",
            parentRequestId: null,
            retainCount: root.retainCount,
            requestDeltaJson: root.eventsJson,
            requestEnvelopeJson: root.envelopeJson,
          },
          {
            requestId: "left",
            parentRequestId: "root",
            retainCount: left.retainCount,
            requestDeltaJson: left.eventsJson,
            requestEnvelopeJson: left.envelopeJson,
          },
          {
            requestId: "right",
            parentRequestId: "root",
            retainCount: right.retainCount,
            requestDeltaJson: right.eventsJson,
            requestEnvelopeJson: right.envelopeJson,
          },
        ],
        "right",
      ),
    ).toBe('{"messages":["one","right"]}');
  });

  it("does not inherit input before a previous_response_id baseline", () => {
    const delta = splitSessionRequestJson(
      '{"previous_response_id":"resp_1","input":[{"role":"user","content":"next"}]}',
      '[{"role":"user","content":"old"}]',
    );
    expect(delta).toMatchObject({
      eventKey: "input",
      retainCount: 0,
      eventsJson: '[{"role":"user","content":"next"}]',
    });
  });

  it("expands a Responses continuation with the parent output and removes the opaque pointer", () => {
    const root = splitSessionRequestJson(
      '{"model":"gpt-5","input":[{"role":"user","content":"one"}]}',
    );
    const child = splitSessionRequestJson(
      '{"model":"gpt-5","previous_response_id":"resp_1","input":[{"role":"user","content":"two"}]}',
      root.eventsJson,
    );
    expect(
      restoreSessionRevisionJson(
        [
          {
            requestId: "root",
            parentRequestId: null,
            retainCount: 0,
            requestDeltaJson: root.eventsJson,
            requestEnvelopeJson: root.envelopeJson,
            responseJson:
              '{"id":"resp_1","output":[{"type":"reasoning","summary":[]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}]}',
          },
          {
            requestId: "child",
            parentRequestId: "root",
            retainCount: 0,
            requestDeltaJson: child.eventsJson,
            requestEnvelopeJson: child.envelopeJson,
            responseJson: null,
          },
        ],
        "child",
      ),
    ).toBe(
      '{"model":"gpt-5","input":[{"role":"user","content":"one"},{"type":"reasoning","summary":[]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]},{"role":"user","content":"two"}]}',
    );
  });

  it("expands a three-level Responses chain while keeping only the current instructions", () => {
    const root = splitSessionRequestJson('{"instructions":"root","input":["root-input"]}');
    const child = splitSessionRequestJson(
      '{"instructions":"child","previous_response_id":"resp_root","input":["child-input"]}',
    );
    const grandchild = splitSessionRequestJson(
      '{"instructions":"current","previous_response_id":"resp_child","input":["grandchild-input"]}',
    );
    expect(
      restoreSessionRevisionJson(
        [
          {
            requestId: "root",
            parentRequestId: null,
            retainCount: 0,
            requestDeltaJson: root.eventsJson,
            requestEnvelopeJson: root.envelopeJson,
            responseJson: '{"id":"resp_root","output":["root-output"]}',
          },
          {
            requestId: "child",
            parentRequestId: "root",
            retainCount: 0,
            requestDeltaJson: child.eventsJson,
            requestEnvelopeJson: child.envelopeJson,
            responseJson: '{"id":"resp_child","output":["child-output"]}',
          },
          {
            requestId: "grandchild",
            parentRequestId: "child",
            retainCount: 0,
            requestDeltaJson: grandchild.eventsJson,
            requestEnvelopeJson: grandchild.envelopeJson,
            responseJson: null,
          },
        ],
        "grandchild",
      ),
    ).toBe(
      '{"instructions":"current","input":["root-input","root-output","child-input","child-output","grandchild-input"]}',
    );
  });

  it("fails closed when a linked Responses parent has no output array", () => {
    const root = splitSessionRequestJson('{"input":["root"]}');
    const child = splitSessionRequestJson('{"previous_response_id":"resp_root","input":["child"]}');
    expect(() =>
      restoreSessionRevisionJson(
        [
          {
            requestId: "root",
            parentRequestId: null,
            retainCount: 0,
            requestDeltaJson: root.eventsJson,
            requestEnvelopeJson: root.envelopeJson,
            responseJson: '{"id":"resp_root","output":null}',
          },
          {
            requestId: "child",
            parentRequestId: "root",
            retainCount: 0,
            requestDeltaJson: child.eventsJson,
            requestEnvelopeJson: child.envelopeJson,
            responseJson: null,
          },
        ],
        "child",
      ),
    ).toThrow("session response output unavailable");
  });

  it("fails closed when an opaque Responses continuation has no linked parent", () => {
    const orphan = splitSessionRequestJson(
      '{"previous_response_id":"resp_missing","input":["child"]}',
    );
    expect(() =>
      restoreSessionRevisionJson(
        [
          {
            requestId: "orphan",
            parentRequestId: null,
            retainCount: 0,
            requestDeltaJson: orphan.eventsJson,
            requestEnvelopeJson: orphan.envelopeJson,
            responseJson: null,
          },
        ],
        "orphan",
      ),
    ).toThrow("session continuation parent unavailable");
  });

  it("rejects a continuation whose opaque id does not match its linked parent", () => {
    const root = splitSessionRequestJson('{"input":["root"]}');
    const child = splitSessionRequestJson(
      '{"previous_response_id":"resp_expected","input":["child"]}',
    );
    expect(() =>
      restoreSessionRevisionJson(
        [
          {
            requestId: "root",
            parentRequestId: null,
            retainCount: 0,
            requestDeltaJson: root.eventsJson,
            requestEnvelopeJson: root.envelopeJson,
            responseId: "resp_different",
            responseJson: '{"id":"resp_different","output":[]}',
          },
          {
            requestId: "child",
            parentRequestId: "root",
            retainCount: 0,
            requestDeltaJson: child.eventsJson,
            requestEnvelopeJson: child.envelopeJson,
            responseJson: null,
          },
        ],
        "child",
      ),
    ).toThrow("session continuation response mismatch");
  });

  it("rejects a continuation with a non-zero retain count", () => {
    const root = splitSessionRequestJson('{"input":["root"]}');
    const child = splitSessionRequestJson('{"previous_response_id":"resp_root","input":["child"]}');
    expect(() =>
      restoreSessionRevisionJson(
        [
          {
            requestId: "root",
            parentRequestId: null,
            retainCount: 0,
            requestDeltaJson: root.eventsJson,
            requestEnvelopeJson: root.envelopeJson,
            responseId: "resp_root",
            responseJson: '{"id":"resp_root","output":[]}',
          },
          {
            requestId: "child",
            parentRequestId: "root",
            retainCount: 1,
            requestDeltaJson: child.eventsJson,
            requestEnvelopeJson: child.envelopeJson,
            responseJson: null,
          },
        ],
        "child",
      ),
    ).toThrow("invalid session continuation retain_count");
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
