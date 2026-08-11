import type { ChatCompletionRequest, ProviderClient } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import {
  createOAuthAccountTester,
  createOpenAiStreamParser,
  DEFAULT_TEST_MAX_TOKENS,
  DEFAULT_TEST_PROMPT,
  OAUTH_TEST_MAX_SSE_LINE_BYTES,
  type TestStreamEvent,
} from "./oauth-test.js";

// One OpenAI `chat.completion.chunk` SSE frame, terminated with the blank line a
// real upstream sends.
function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function delta(content: string): unknown {
  return { choices: [{ index: 0, delta: { content }, finish_reason: null }] };
}

// Drain a parser over a list of raw byte-chunks (push) + a final flush.
function run(
  parser: ReturnType<typeof createOpenAiStreamParser>,
  chunks: string[],
): TestStreamEvent[] {
  const out: TestStreamEvent[] = [];
  for (const c of chunks) out.push(...parser.push(c));
  out.push(...parser.flush());
  return out;
}

describe("createOpenAiStreamParser — normalizes OpenAI chunk SSE to test events", () => {
  it("extracts a content delta from a single complete frame", () => {
    const p = createOpenAiStreamParser();
    expect(run(p, [frame(delta("Hello"))])).toEqual([{ type: "content", text: "Hello" }]);
  });

  it("reassembles a frame split arbitrarily across byte-chunks (not frame-aligned)", () => {
    // The upstream body is decoded in chunks that DO NOT align to SSE frames; the
    // parser must buffer the partial `data:` line until its newline arrives.
    const raw = frame(delta("Hi")) + frame(delta(" there"));
    const a = raw.slice(0, 10);
    const b = raw.slice(10, 25);
    const c = raw.slice(25);
    expect(run(createOpenAiStreamParser(), [a, b, c])).toEqual([
      { type: "content", text: "Hi" },
      { type: "content", text: " there" },
    ]);
  });

  it("emits content + finish + usage across multiple frames in one push", () => {
    const p = createOpenAiStreamParser();
    const chunk =
      frame(delta("Hi")) +
      frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      frame({
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }) +
      "data: [DONE]\n\n";
    expect(run(p, [chunk])).toEqual([
      { type: "content", text: "Hi" },
      { type: "finish", reason: "stop" },
      { type: "usage", promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    ]);
  });

  it("ignores [DONE], comments, and unparseable data lines (fail-open)", () => {
    const p = createOpenAiStreamParser();
    const chunk = ": keep-alive\n\n" + "data: not-json\n\n" + "data: [DONE]\n\n";
    expect(run(p, [chunk])).toEqual([]);
  });

  it("flush() drains a trailing frame that arrived without a final newline", () => {
    const p = createOpenAiStreamParser();
    // No trailing \n — some upstreams close the socket right after the last frame.
    expect(run(p, [`data: ${JSON.stringify(delta("bye"))}`])).toEqual([
      { type: "content", text: "bye" },
    ]);
  });

  it("rejects an unterminated SSE line after one MiB of buffered UTF-8", () => {
    const p = createOpenAiStreamParser();
    expect(() => p.push("你".repeat(Math.floor(OAUTH_TEST_MAX_SSE_LINE_BYTES / 3) + 1))).toThrow(
      /SSE line exceeds 1048576 bytes/,
    );
  });

  it("skips empty content deltas (e.g. the priming role-only frame)", () => {
    const p = createOpenAiStreamParser();
    const chunk =
      frame({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
      frame(delta("ok"));
    expect(run(p, [chunk])).toEqual([{ type: "content", text: "ok" }]);
  });
});

// A fake ProviderClient whose stream yields the given raw chunks. Only
// chatCompletionStream is exercised by the tester.
function fakeClient(
  chunks: string[],
  capture?: (req: ChatCompletionRequest) => void,
): ProviderClient {
  return {
    chatCompletion: vi.fn(),
    async *chatCompletionStream(req: ChatCompletionRequest) {
      capture?.(req);
      for (const c of chunks) yield c;
    },
  } as unknown as ProviderClient;
}

describe("createOAuthAccountTester — streams a real completion through one account", () => {
  it("builds the account client and yields normalized content events", async () => {
    let seen: ChatCompletionRequest | undefined;
    const tester = createOAuthAccountTester({
      buildClient: async () =>
        fakeClient(
          [`data: ${JSON.stringify({ choices: [{ delta: { content: "Hey" } }] })}\n\n`],
          (r) => {
            seen = r;
          },
        ),
    });
    const out: TestStreamEvent[] = [];
    for await (const ev of tester.test({
      providerId: "anthropic",
      account: "default",
      model: "claude-x",
    })) {
      out.push(ev);
    }
    expect(out).toEqual([{ type: "content", text: "Hey" }]);
    // The request carries the chosen model, a single user turn, stream:true and the
    // default prompt + token cap.
    expect(seen?.model).toBe("claude-x");
    expect(seen?.stream).toBe(true);
    expect(seen?.max_tokens).toBe(DEFAULT_TEST_MAX_TOKENS);
    expect(seen?.messages).toEqual([{ role: "user", content: DEFAULT_TEST_PROMPT }]);
  });

  it("uses the operator-supplied prompt when present (trimmed, non-empty)", async () => {
    let seen: ChatCompletionRequest | undefined;
    const tester = createOAuthAccountTester({
      buildClient: async () =>
        fakeClient([], (r) => {
          seen = r;
        }),
    });
    for await (const _ of tester.test({
      providerId: "anthropic",
      account: "default",
      model: "m",
      prompt: "  ping?  ",
    })) {
      // drain
    }
    expect(seen?.messages).toEqual([{ role: "user", content: "ping?" }]);
  });

  it("throws a clear error when the account has no buildable client (not connected)", async () => {
    const tester = createOAuthAccountTester({ buildClient: async () => null });
    await expect(async () => {
      for await (const _ of tester.test({ providerId: "x", account: "default", model: "m" })) {
        // drain
      }
    }).rejects.toThrow(/not connected/i);
  });

  it("propagates an upstream stream error to the caller", async () => {
    const tester = createOAuthAccountTester({
      buildClient: async () =>
        ({
          chatCompletion: vi.fn(),
          // biome-ignore lint/correctness/useYield: deliberately throws before yielding (error path)
          async *chatCompletionStream() {
            throw new Error("upstream returned 401");
          },
        }) as unknown as ProviderClient,
    });
    await expect(async () => {
      for await (const _ of tester.test({ providerId: "x", account: "default", model: "m" })) {
        // drain
      }
    }).rejects.toThrow(/401/);
  });
});
