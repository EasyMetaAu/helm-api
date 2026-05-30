import type { InternalRequest } from "@helm/shared";
import { describe, expect, it } from "vitest";
import {
  buildEvalCacheKey,
  type CanonicalEvalInput,
  type ClassifierInput,
  toCanonicalInput,
} from "./cache-key.js";

// eval.cache-key — the canonical content-hash that keys the eval cache. The
// algorithm must hash ONLY the inputs that actually influence classification
// (last user message trimmed, turn count, sorted tool names, response_format
// JSON-ness, attachment/vision presence) so that two logically identical
// requests collapse to the same key — otherwise the hit rate is 0. Volatile
// fields (trace/request/message ids, timestamps, model name, stream flag,
// account/user ids) MUST be excluded. The field set is EXACTLY the 5 pinned in
// implementation-notes (2026-05-30). No lowercasing (case can change meaning).

// Build a full InternalRequest-shaped input; cache-key only consumes the
// classifier subset, but we exercise volatile-field exclusion with the real
// shape so the contract is honest.
function makeInput(over: Partial<InternalRequest> = {}): ClassifierInput {
  const base = {
    request_id: "req-stable-1",
    protocol: "openai_chat",
    account_id: "acct-1",
    api_key_id: "key-1",
    user_id: "user-1",
    org_id: null,
    requested_model: "gpt-4o",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "What is the capital of France?" },
    ],
    tools: null,
    response_format: null,
    attachments: null,
    max_tokens: 256,
    stream: false,
    metadata: {
      conversation_id: "conv-1",
      thread_id: null,
      resource_id: null,
      project_id: null,
      memory_mode: "off",
    },
  } satisfies InternalRequest;
  return { ...base, ...over } as ClassifierInput;
}

describe("buildEvalCacheKey — same logical request → same key", () => {
  it("ignores volatile fields (request_id / account / user / model / stream)", () => {
    const a = makeInput();
    const b = makeInput({
      request_id: "req-totally-different-2",
      account_id: "acct-9",
      api_key_id: "key-9",
      user_id: "user-9",
      requested_model: "claude-3-5-sonnet",
      stream: true,
      metadata: {
        conversation_id: "conv-DIFFERENT",
        thread_id: "thread-x",
        resource_id: "res-y",
        project_id: "proj-z",
        memory_mode: "inject",
      },
    });
    expect(buildEvalCacheKey(a)).toBe(buildEvalCacheKey(b));
  });

  it("is a 64-char lowercase hex sha256 digest", () => {
    expect(buildEvalCacheKey(makeInput())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildEvalCacheKey — tool order independence", () => {
  it("sorts tool names so array order does not change the key", () => {
    const tools1 = [
      { type: "function", function: { name: "zebra_tool" } },
      { type: "function", function: { name: "alpha_tool" } },
      { type: "function", function: { name: "mango_tool" } },
    ];
    const tools2 = [
      { type: "function", function: { name: "mango_tool" } },
      { type: "function", function: { name: "alpha_tool" } },
      { type: "function", function: { name: "zebra_tool" } },
    ];
    expect(buildEvalCacheKey(makeInput({ tools: tools1 }))).toBe(
      buildEvalCacheKey(makeInput({ tools: tools2 })),
    );
  });

  it("hashes tool names only, not schema bodies", () => {
    const a = makeInput({
      tools: [{ type: "function", function: { name: "search", description: "search the web v1" } }],
    });
    const b = makeInput({
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            description: "TOTALLY DIFFERENT DESCRIPTION",
            parameters: {},
          },
        },
      ],
    });
    expect(buildEvalCacheKey(a)).toBe(buildEvalCacheKey(b));
  });
});

describe("buildEvalCacheKey — last-user-message normalization", () => {
  it("trims surrounding whitespace ('  Hello  ' === 'Hello')", () => {
    const a = makeInput({ messages: [{ role: "user", content: "  Hello  " }] });
    const b = makeInput({ messages: [{ role: "user", content: "Hello" }] });
    expect(buildEvalCacheKey(a)).toBe(buildEvalCacheKey(b));
  });

  it("does NOT lowercase ('Hello' !== 'hello')", () => {
    const a = makeInput({ messages: [{ role: "user", content: "Hello" }] });
    const b = makeInput({ messages: [{ role: "user", content: "hello" }] });
    expect(buildEvalCacheKey(a)).not.toBe(buildEvalCacheKey(b));
  });

  it("keys off the LAST user message, ignoring earlier ones", () => {
    const a = makeInput({
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "an answer" },
        { role: "user", content: "the real question" },
      ],
    });
    const b = makeInput({
      messages: [
        { role: "user", content: "a COMPLETELY different first" },
        { role: "assistant", content: "another answer" },
        { role: "user", content: "the real question" },
      ],
    });
    // turn_count (user-message count) is equal (2) and last user message equal →
    // same key even though the earlier user message text differs.
    expect(buildEvalCacheKey(a)).toBe(buildEvalCacheKey(b));
  });
});

describe("buildEvalCacheKey — semantic differences → different keys", () => {
  const baseline = buildEvalCacheKey(makeInput());

  it("differs when the last user message changes", () => {
    const other = makeInput({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "What is the capital of Germany?" },
      ],
    });
    expect(buildEvalCacheKey(other)).not.toBe(baseline);
  });

  it("differs when turn_count (user-message count) changes", () => {
    const other = makeInput({
      messages: [
        { role: "user", content: "earlier turn" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "What is the capital of France?" },
      ],
    });
    expect(buildEvalCacheKey(other)).not.toBe(baseline);
  });

  it("differs when response_format JSON-ness changes", () => {
    const other = makeInput({ response_format: { type: "json_object" } });
    expect(buildEvalCacheKey(other)).not.toBe(baseline);
  });

  it("differs when attachment/vision presence changes", () => {
    const other = makeInput({ attachments: [{ type: "image_url", image_url: { url: "x" } }] });
    expect(buildEvalCacheKey(other)).not.toBe(baseline);
  });

  it("differs when tool names change", () => {
    const other = makeInput({
      tools: [{ type: "function", function: { name: "search" } }],
    });
    expect(buildEvalCacheKey(other)).not.toBe(baseline);
  });
});

describe("toCanonicalInput — exact field set", () => {
  it("emits EXACTLY the 5 pinned keys, no extras", () => {
    const canonical = toCanonicalInput(makeInput());
    expect(Object.keys(canonical).sort()).toEqual(
      [
        "has_attachments",
        "last_user_message",
        "response_format_json",
        "tool_names",
        "turn_count",
      ].sort(),
    );
  });

  it("reflects the source request faithfully", () => {
    const canonical = toCanonicalInput(
      makeInput({
        messages: [
          { role: "user", content: "  spaced  " },
          { role: "assistant", content: "x" },
          { role: "user", content: "  final  " },
        ],
        tools: [
          { type: "function", function: { name: "zebra" } },
          { type: "function", function: { name: "alpha" } },
        ],
        response_format: { type: "json_schema", json_schema: {} },
        attachments: [{ type: "image" }],
      }),
    );
    const expected: CanonicalEvalInput = {
      last_user_message: "final",
      turn_count: 2,
      tool_names: ["alpha", "zebra"],
      response_format_json: true,
      has_attachments: true,
    };
    expect(canonical).toEqual(expected);
  });
});
