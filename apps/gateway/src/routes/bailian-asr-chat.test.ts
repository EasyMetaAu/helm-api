import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import { handleBailianAsrChat } from "./bailian-asr-chat.js";

it("preserves input_audio URLs and options without ordinary chat fallback", async () => {
  const chatCompletion = vi.fn(async (body) => ({ id: "asr", model: body.model, choices: [] }));
  const app = new Hono<AppEnv>();
  app.post("/", async (c) => {
    c.set("identity", {
      keyId: "key",
      accountId: "account",
      caps: { allowCustomModel: false, allowedLanes: ["transcription-short"] },
    } as never);
    return (
      (await handleBailianAsrChat(c, await c.req.json(), {
        resolve: () => ({
          client: { chatCompletion, chatCompletionStream: async function* () {} },
          alias: "ali/asr",
          model: "qwen3-asr-flash",
          lane: "transcription-short",
          customModel: false,
        }),
      })) ?? c.text("fallback")
    );
  });
  const body = {
    model: "transcription-short",
    messages: [
      {
        role: "user",
        content: [{ type: "input_audio", input_audio: { data: "https://cdn.example/audio.mp3" } }],
      },
    ],
    asr_options: { language: "zh", enable_itn: false },
  };
  const response = await app.request("/", { method: "POST", body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  expect(chatCompletion.mock.calls[0]?.[0]).toMatchObject({ ...body, model: "qwen3-asr-flash" });
  expect(chatCompletion.mock.calls[0]?.[0].messages[0].content[0].input_audio).not.toHaveProperty(
    "format",
  );
});
it("rejects spend-capped ASR before sending", async () => {
  const chatCompletion = vi.fn();
  const app = new Hono<AppEnv>();
  app.post("/", async (c) => {
    c.set("identity", {
      keyId: "key",
      caps: { budget: { spendUsd: 1 }, allowCustomModel: true },
    } as never);
    return (
      (await handleBailianAsrChat(
        c,
        { model: "asr" },
        {
          resolve: () => ({
            client: { chatCompletion, chatCompletionStream: async function* () {} },
            alias: "ali/asr",
            model: "qwen3-asr-flash",
            lane: "asr",
            customModel: true,
          }),
        },
      )) ?? c.text("fallback")
    );
  });
  expect((await app.request("/", { method: "POST" })).status).toBe(422);
  expect(chatCompletion).not.toHaveBeenCalled();
});
it("holds the ASR stream lease until cancellation and releases once", async () => {
  const release = vi.fn(async () => {});
  const claim = vi.fn(() => release);
  const app = new Hono<AppEnv>();
  app.post("/", async (c) => {
    c.set("identity", { keyId: "k", caps: { allowCustomModel: true } } as never);
    c.set("concurrencyClaim", claim);
    return (
      (await handleBailianAsrChat(
        c,
        {
          model: "asr",
          stream: true,
          messages: [
            {
              role: "user",
              content: [
                { type: "input_audio", input_audio: { data: "https://cdn.example/a.mp3" } },
              ],
            },
          ],
        },
        {
          resolve: () => ({
            client: {
              chatCompletion: vi.fn(),
              chatCompletionStream: async function* (_req, opts) {
                yield "data: {}\n\n";
                await new Promise<void>((r) =>
                  opts?.signal?.addEventListener("abort", () => r(), { once: true }),
                );
              },
            },
            alias: "ali/asr",
            model: "qwen3-asr-flash",
            lane: "asr",
            customModel: true,
          }),
        },
      )) ?? c.text("fallback")
    );
  });
  const r = await app.request("/", { method: "POST" });
  expect(claim).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();
  const reader = r.body?.getReader();
  await reader?.read();
  await reader?.cancel();
  await new Promise((r) => setTimeout(r, 0));
  expect(release).toHaveBeenCalledTimes(1);
});
it("fails closed for an ASR selection with no available credential", async () => {
  const app = new Hono<AppEnv>();
  app.post("/", async (c) => {
    c.set("identity", { keyId: "k", caps: { allowCustomModel: true } } as never);
    return (
      (await handleBailianAsrChat(
        c,
        {
          model: "asr",
          messages: [
            {
              role: "user",
              content: [
                { type: "input_audio", input_audio: { data: "https://cdn.example/audio.mp3" } },
              ],
            },
          ],
        },
        {
          resolve: () => ({
            client: null,
            alias: "ali/asr",
            model: "qwen3-asr-flash",
            lane: "asr",
            customModel: true,
          }),
        },
      )) ?? c.text("fallback")
    );
  });
  expect((await app.request("/", { method: "POST" })).status).toBe(503);
});
