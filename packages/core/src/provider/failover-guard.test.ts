import { describe, expect, it } from "vitest";
import { guardPreOutputFailure, preOutputClassifierFor } from "./failover-guard.js";
import { UpstreamError } from "./openai.js";

// failover-guard — the pre-output streaming failure detector. A native upstream that
// returns HTTP 200 then fails IN-BAND (e.g. Responses `response.failed` /
// `server_is_overloaded` after only the unconditional `response.created` preamble)
// must count as a FAILED attempt so the executor falls back — not stream the error to
// the client as a success. The guard buffers preamble, commits on the first REAL
// output (flushing buffered bytes verbatim), and throws on a terminal error frame seen
// before any output (→ peekStream surfaces it as a pre-first-chunk failure).

async function* fromChunks(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

const responses = preOutputClassifierFor("openai_responses");
const anthropic = preOutputClassifierFor("anthropic_messages");
const chat = preOutputClassifierFor("openai_chat");
if (!responses || !anthropic || !chat) throw new Error("classifier missing");

describe("guardPreOutputFailure — openai_responses", () => {
  it("preamble then a terminal error frame → throws UpstreamError (no output yielded)", async () => {
    const src = fromChunks([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n',
      'event: error\ndata: {"type":"error","error":{"message":"server_is_overloaded"}}\n\n',
    ]);
    await expect(collect(guardPreOutputFailure(src, responses))).rejects.toThrow(
      /server_is_overloaded/,
    );
  });

  it("response.failed (nested error) before output → throws UpstreamError", async () => {
    const src = fromChunks([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"overloaded"}}}\n\n',
    ]);
    await expect(collect(guardPreOutputFailure(src, responses))).rejects.toThrow(UpstreamError);
  });

  it("preamble then real output → commits, replays every byte in order (preamble kept)", async () => {
    const chunks = [
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), responses));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("an SSE event split across chunk boundaries still classifies correctly", async () => {
    const chunks = [
      "event: response.created\nda",
      'ta: {"type":"response.created"}\n\nevent: response.output_text.delta\ndata: {"type":"resp',
      'onse.output_text.delta","delta":"Hi"}\n\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), responses));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("error and preamble batched in ONE chunk (error before any output) → throws", async () => {
    const src = fromChunks([
      'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"overloaded"}}}\n\n',
    ]);
    await expect(collect(guardPreOutputFailure(src, responses))).rejects.toThrow(UpstreamError);
  });

  it("output THEN error in the same chunk → commits (error relayed as bytes, NOT a failure)", async () => {
    const chunks = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\nevent: error\ndata: {"type":"error","error":{"message":"late"}}\n\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), responses));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("preamble-only stream that ends with no output and no error → throws (fallback)", async () => {
    const src = fromChunks([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n',
    ]);
    await expect(collect(guardPreOutputFailure(src, responses))).rejects.toThrow(UpstreamError);
  });
});

describe("guardPreOutputFailure — anthropic_messages", () => {
  it("message_start + ping then error → throws", async () => {
    const src = fromChunks([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n',
    ]);
    await expect(collect(guardPreOutputFailure(src, anthropic))).rejects.toThrow(/overloaded/);
  });

  it("message_start then content_block_delta → commits byte-for-byte", async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), anthropic));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("empty text block then terminal stop → throws so the executor can fall back", async () => {
    const src = fromChunks([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    await expect(collect(guardPreOutputFailure(src, anthropic))).rejects.toThrow(UpstreamError);
  });

  it("a valid tool_use block start counts as output even before input_json_delta", async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_123","name":"Bash","input":{}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), anthropic));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("tool argument deltas count as output", async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":"}}\n\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), anthropic));
    expect(out.join("")).toBe(chunks.join(""));
  });
});

describe("guardPreOutputFailure — openai_chat", () => {
  it("role-only preamble then an in-band error frame → throws", async () => {
    const src = fromChunks([
      'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"error":{"message":"server_is_overloaded"}}\n\n',
    ]);
    await expect(collect(guardPreOutputFailure(src, chat))).rejects.toThrow(/server_is_overloaded/);
  });

  it("role-only preamble then a content delta → commits byte-for-byte", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), chat));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("the translate path's {role,content:''} preamble defers, then content commits", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), chat));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("a bare content-less frame with no role (data: {}) commits immediately (non-regressive)", async () => {
    const chunks = ["data: {}\n\n"];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), chat));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("a finish_reason-only terminal chunk counts as output (commits, no fallback)", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), chat));
    expect(out.join("")).toBe(chunks.join(""));
  });
});

describe("preOutputClassifierFor", () => {
  it("returns null for gemini (no guard → unchanged commit-on-first behavior)", () => {
    expect(preOutputClassifierFor("gemini")).toBeNull();
  });
});
