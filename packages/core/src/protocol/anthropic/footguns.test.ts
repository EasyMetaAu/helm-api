import { describe, expect, it } from "vitest";
import type { IRResponse } from "../ir.js";
import { transformRequestOut } from "./request.js";
import { mapStopReason, mapUsage, transformResponseIn } from "./response.js";
import {
  type AnthropicSSEEvent,
  convertOpenAIStreamToAnthropic,
  type OpenAIChunk,
} from "./stream.js";

// —— 协议互译 5 大坑专项回归测试矩阵 (docs/05「必须处理的坑」全 5 条) ————————————
//
// 这套测试是协议互译层的"防回归护城河"：即便底层 request/response/stream 被重构,
// 只要这 5 个反复让其他实现翻车的坑之一复活, 这里就会变红。断言措辞针对"坑的本质
// 行为"(不双算 / 无孤儿 delta / 不产出非法枚举), 而非实现细节, 以避免脆性。
// 复用既有导出, 不新增产品代码 (task protocol.footgun-tests)。

// —— shared helpers ——————————————————————————————————————————————————————————

/** Wrap chunks as the upstream OpenAI chunk feed. */
async function* feed(chunks: OpenAIChunk[]): AsyncIterable<OpenAIChunk> {
  for (const c of chunks) yield c;
}

/** Drain an async iterable into an array. */
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

/** The 4 legal Anthropic stop_reason values — anything else is a "lost response" bug. */
const LEGAL_STOP_REASONS = ["end_turn", "max_tokens", "stop_sequence", "tool_use"] as const;

/** A minimal text-only OpenAI chunk. */
function textChunk(content: string, finish: string | null = null): OpenAIChunk {
  return {
    id: "chatcmpl-fg",
    model: "gpt-x",
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 坑 #1 — finish/stop 枚举错配
//   OpenAI SDK 遇到非法 stop_reason 枚举会 DROP 整个响应。映射必须永远落在合法枚举,
//   未知/null 兜底 end_turn, 且原始值始终入 provider_raw.stop_reason。
// ════════════════════════════════════════════════════════════════════════════

describe("footgun #1 — finish/stop enum mismatch never produces an illegal enum", () => {
  it("maps every known finish_reason to a LEGAL Anthropic stop_reason and preserves the raw", () => {
    const known = ["stop", "length", "tool_calls", "content_filter", "function_call"];
    for (const finish of known) {
      const { stop_reason, raw } = mapStopReason(finish);
      // The mapped value is ALWAYS one of the 4 legal enums (no dropped response).
      expect(LEGAL_STOP_REASONS).toContain(stop_reason);
      // The original value is never lost — it is what the caller stashes in provider_raw.
      expect(raw).toBe(finish);
    }
  });

  it("falls back to end_turn for an UNKNOWN finish_reason without emitting an illegal enum", () => {
    const { stop_reason, raw } = mapStopReason("totally_made_up_reason");
    expect(stop_reason).toBe("end_turn");
    expect(LEGAL_STOP_REASONS).toContain(stop_reason);
    expect(raw).toBe("totally_made_up_reason");
  });

  it("transformResponseIn lands on a legal stop_reason and stashes the raw in provider_raw", () => {
    // content_filter has no perfect Anthropic equivalent: it must map to a legal enum,
    // and the raw "content_filter" must survive in provider_raw.stop_reason.
    const ir: IRResponse = {
      id: "resp_cf",
      model: "gpt-x",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "blocked" },
          finish_reason: "content_filter",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    };
    const out = transformResponseIn(ir);
    expect(LEGAL_STOP_REASONS).toContain(out.stop_reason);
    expect(out.provider_raw?.stop_reason).toBe("content_filter");
  });

  it("never produces an illegal enum for a null/empty finish_reason (bottoms out at end_turn)", () => {
    // A null upstream finish_reason becomes "" in the IR→native path; it must NOT
    // collapse into an illegal value — it bottoms out at the legal end_turn.
    const ir: IRResponse = {
      id: "resp_null",
      model: "gpt-x",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: null }],
    };
    const out = transformResponseIn(ir);
    expect(out.stop_reason).toBe("end_turn");
    expect(LEGAL_STOP_REASONS).toContain(out.stop_reason);
    // raw of a null/absent finish_reason is recorded as "" (the original absence).
    expect(out.provider_raw?.stop_reason).toBe("");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 坑 #2 — usage 缓存双重计费 (~10× 成本错误)
//   缓存读 token 被当全价输入算 → ~10× 成本。input_tokens = prompt − cached,
//   cache_read 单列, 缓存读绝不计入 input。非流式与流式两路必须一致, 都不双算。
// ════════════════════════════════════════════════════════════════════════════

describe("footgun #2 — cached tokens are never double-billed as full-price input", () => {
  // IR.prompt_tokens is ALREADY the non-cached input (the inbound transformer did
  // prompt − cached), so a healthy IR has prompt=200, cached=800 for a 1000-token
  // prompt of which 800 were cache reads.
  const NON_CACHED_INPUT = 200;
  const CACHE_READ = 800;
  const OUTPUT = 20;

  it("non-streaming: input_tokens excludes cache reads, cache_read is its own line", () => {
    const usage = mapUsage({
      prompt_tokens: NON_CACHED_INPUT,
      completion_tokens: OUTPUT,
      cached_tokens: CACHE_READ,
    });
    expect(usage.input_tokens).toBe(NON_CACHED_INPUT);
    expect(usage.cache_read_input_tokens).toBe(CACHE_READ);
    // The cache read is NOT folded into input (that would be the ~10× overcharge).
    expect(usage.input_tokens).not.toBe(NON_CACHED_INPUT + CACHE_READ);
  });

  it("streaming: the terminal message_delta carries the SAME non-double-counted usage", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          textChunk("x"),
          {
            id: "c",
            model: "m",
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            usage: {
              prompt_tokens: NON_CACHED_INPUT,
              completion_tokens: OUTPUT,
              cached_tokens: CACHE_READ,
            },
          },
          textChunk("", "stop"),
        ]),
      ),
    );

    // Usage rides ONLY the terminal message_delta — never billed mid-stream.
    const md = events.find((e) => e.type === "message_delta");
    expect(md?.type).toBe("message_delta");
    if (md?.type === "message_delta") {
      expect(md.usage.input_tokens).toBe(NON_CACHED_INPUT);
      expect(md.usage.cache_read_input_tokens).toBe(CACHE_READ);
      expect(md.usage.input_tokens).not.toBe(NON_CACHED_INPUT + CACHE_READ);
    }
  });

  it("both paths agree: streaming input_tokens == non-streaming input_tokens (no divergence)", async () => {
    const nonStreaming = mapUsage({
      prompt_tokens: NON_CACHED_INPUT,
      completion_tokens: OUTPUT,
      cached_tokens: CACHE_READ,
    });
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          textChunk("x"),
          textChunk("", "stop"),
          // usage may arrive on the SAME chunk as finish or a trailing one; both buffer.
          {
            id: "c",
            model: "m",
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            usage: {
              prompt_tokens: NON_CACHED_INPUT,
              completion_tokens: OUTPUT,
              cached_tokens: CACHE_READ,
            },
          },
        ]),
      ),
    );
    const md = events.find((e) => e.type === "message_delta");
    if (md?.type === "message_delta") {
      expect(md.usage.input_tokens).toBe(nonStreaming.input_tokens);
      expect(md.usage.cache_read_input_tokens).toBe(nonStreaming.cache_read_input_tokens);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 坑 #3 — tool-call 流式 index/id 错配
//   并行 tool 的 OpenAI 整数 index 必须稳定映射到 Anthropic block, 分片不串;
//   id 仅首片缺失时用临时 id 后补升级; 截断 partial_json 累积容忍不崩。
// ════════════════════════════════════════════════════════════════════════════

describe("footgun #3 — parallel tool-call index/id reconciliation", () => {
  it("interleaved index 0/1 fragments never cross blocks and temp id upgrades to the real id", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          // index 1 arrives FIRST and WITHOUT an id (temp id territory). Its first
          // fragment carries NO args yet, so START is deferred until the id settles.
          // index 0 arrives with a full id + a first arg fragment.
          {
            id: "c",
            model: "m",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 1, function: { name: "beta", arguments: "" } },
                    { index: 0, id: "call_a", function: { name: "alpha", arguments: '{"a' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          // index 1's real id arrives BEFORE its first arg fragment → temp id is
          // upgraded to the real id before START is emitted. Fragments stay out of order.
          {
            id: "c",
            model: "m",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: '":1}' } },
                    { index: 1, id: "call_b", function: { arguments: '{"b":2}' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    );

    const starts = events.filter(
      (e): e is Extract<AnthropicSSEEvent, { type: "content_block_start" }> =>
        e.type === "content_block_start",
    );
    expect(starts).toHaveLength(2);
    // Block index is allocated by FIRST-SEEN OpenAI index, not by id: index 1 was seen
    // first → block 0 = beta, index 0 → block 1 = alpha. The mapping is STABLE.
    const byBlock = new Map(starts.map((s) => [s.index, s.content_block]));
    const beta = byBlock.get(0);
    const alpha = byBlock.get(1);
    expect(beta).toMatchObject({ type: "tool_use", name: "beta" });
    expect(alpha).toMatchObject({ type: "tool_use", id: "call_a", name: "alpha" });
    // The late-arriving temp id was upgraded to the real id before the START emit.
    expect(beta).toMatchObject({ id: "call_b" });

    // argBuffer accumulates per-block without cross-contamination.
    const argsFor = (blockIndex: number) =>
      events
        .filter(
          (e): e is Extract<AnthropicSSEEvent, { type: "content_block_delta" }> =>
            e.type === "content_block_delta" && e.index === blockIndex,
        )
        .map((e) => (e.delta.type === "input_json_delta" ? e.delta.partial_json : ""))
        .join("");
    expect(argsFor(0)).toBe('{"b":2}'); // beta
    expect(argsFor(1)).toBe('{"a":1}'); // alpha
  });

  it("tolerates truncated partial_json fragments without throwing an uncaught error", async () => {
    // A tool whose argument fragments are cut off mid-object must not crash the stream;
    // the partials are forwarded as-is (jsonrepair is the response-path's job).
    const run = collect(
      convertOpenAIStreamToAnthropic(
        feed([
          {
            id: "c",
            model: "m",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: "t", function: { name: "f", arguments: '{"q":"unterm' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          // Stream ends mid-JSON — no closing brace ever arrives.
          { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    );
    await expect(run).resolves.toBeDefined();
    const events = await run;
    // The truncated fragment was forwarded; the block opened and closed cleanly.
    expect(events.filter((e) => e.type === "content_block_start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "content_block_stop")).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 坑 #4 — block/role 一致性 (孤儿 delta + 重复 stop)
//   每个 content_block_delta 前必有同 index 的 content_block_start (无孤儿 delta);
//   start/stop 配对; 关闭守卫幂等 (无重复 stop)。首片带 role:"assistant" 语义。
// ════════════════════════════════════════════════════════════════════════════

describe("footgun #4 — block/role consistency: no orphan delta, idempotent close", () => {
  it("every content_block_delta is preceded by a same-index content_block_start", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          textChunk("a"),
          {
            id: "c",
            model: "m",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, id: "t", function: { name: "f", arguments: "{}" } }],
                },
                finish_reason: null,
              },
            ],
          },
          textChunk("b"),
          textChunk("", "stop"),
        ]),
      ),
    );

    const started = new Set<number>();
    for (const e of events) {
      if (e.type === "content_block_start") started.add(e.index);
      if (e.type === "content_block_delta") {
        // No orphan delta: the block must already be open.
        expect(started.has(e.index)).toBe(true);
      }
    }
  });

  it("emits content_block_stop / message_stop / message_delta exactly once despite redundant finish chunks", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          textChunk("hi"),
          textChunk("", "stop"),
          textChunk("", "stop"),
          textChunk("", "length"),
        ]),
      ),
    );
    // Close guard is idempotent — each terminal event fires at most once.
    expect(events.filter((e) => e.type === "content_block_stop")).toHaveLength(1);
    expect(events.filter((e) => e.type === "message_stop")).toHaveLength(1);
    expect(events.filter((e) => e.type === "message_delta")).toHaveLength(1);
  });

  it('starts the message with role:"assistant" semantics on the first event', async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(feed([textChunk("x"), textChunk("", "stop")])),
    );
    const first = events[0];
    expect(first?.type).toBe("message_start");
    if (first?.type === "message_start") {
      expect(first.message.role).toBe("assistant");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 坑 #5 — system + 多模态结构错配
//   顶层 system 提升为 IR system 消息; 连续同角色被合并 (无连续 user/tool);
//   图像 source:{base64} 字段拆分保留 media_type/data。
// ════════════════════════════════════════════════════════════════════════════

describe("footgun #5 — system hoist, same-role merge, image source split", () => {
  it("hoists top-level system, merges adjacent user turns, and preserves image media_type", () => {
    const ir = transformRequestOut({
      model: "claude-x",
      system: "You are helpful.",
      messages: [
        { role: "user", content: "first" },
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
      ],
    });

    // System hoisted to the head as a system message.
    expect(ir.messages[0]).toMatchObject({ role: "system", content: "You are helpful." });

    // The two adjacent user turns are MERGED into one (no consecutive same-role).
    const userMsgs = ir.messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    // No two consecutive messages share a (non-tool) role.
    for (let i = 1; i < ir.messages.length; i++) {
      const prev = ir.messages[i - 1]!;
      const cur = ir.messages[i]!;
      if (prev.role !== "tool" && cur.role !== "tool") {
        expect(prev.role).not.toBe(cur.role);
      }
    }

    // The image part survives with its media_type and base64 data intact.
    const user = userMsgs[0]!;
    expect(Array.isArray(user.content)).toBe(true);
    if (Array.isArray(user.content)) {
      const image = user.content.find((p) => p.type === "image");
      expect(image).toBeDefined();
      if (image?.type === "image") {
        expect(image.mediaType).toBe("image/png");
        // The base64 data is preserved inside the synthesized data-url.
        expect(image.url).toBe("data:image/png;base64,AAAA");
      }
    }
  });
});
