import {
  type BudgetStore,
  createTranscriptionAccounting,
  MediaHttpError,
  type ProviderClient,
} from "@helm/core";
import type { MediaPricing, MediaSpendRecord } from "@helm/shared";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import { handleBailianAsrChat } from "./bailian-asr-chat.js";

// Synthetic billing contract; these are not asserted to be Bailian's actual rounding or FX.
const pricing: MediaPricing = {
  currency: "CNY",
  region: "test",
  providerModel: "qwen3-asr-flash",
  basis: "official_list_price",
  verifiedOn: "2026-11-13",
  source: "https://example.test/pricing",
  notes: [],
  rates: [{ direction: "input_audio", unit: "second", price: 0.01, conditions: {} }],
  billing: { roundingSeconds: 1, usdPerCurrencyUnit: 0.1 },
};
function wav() {
  const bytes = Buffer.alloc(44 + 40000);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(40000, 40);
  return bytes;
}
function setup(card: MediaPricing = pricing) {
  let saved: MediaSpendRecord | undefined;
  const reserveMediaSpend = vi.fn(async (record: MediaSpendRecord) => {
    saved = record;
    return true;
  });
  const store: BudgetStore = {
    peek: vi.fn(async () => ({ remaining: 1, ok: true })),
    debit: vi.fn(async () => ({ remaining: 1 })),
    reserveMediaSpend,
    settleMediaSpend: vi.fn(async (id, keyId, result) => {
      if (!saved || saved.id !== id || saved.keyId !== keyId) throw new Error("wrong operation");
      saved = {
        ...saved,
        state: result.costUsd === null ? "outcome_unknown" : "settled",
        costUsd: result.costUsd,
        usage: result.usage,
      };
      return saved;
    }),
  };
  const chatCompletion = vi.fn<ProviderClient["chatCompletion"]>(async () => {
    expect(saved?.state).toBe("reserved");
    return { choices: [{ message: { content: "Hello" } }], usage: { seconds: 1 } };
  });
  const record = vi.fn();
  const settleBudget = vi.fn();
  const app = new Hono<AppEnv>();
  app.post("/", async (c) => {
    c.set("identity", {
      keyId: "owner",
      accountId: "account",
      keyPrefix: "test",
      orgId: null,
      userId: null,
      role: "user",
      caps: {
        allowedLanes: ["transcription-short"],
        allowCustomModel: false,
        blockedModels: null,
        allowFastMode: false,
        rateLimit: { rpm: null, tpm: null },
        concurrencyLimit: null,
        memory: { mode: "off", projectId: null, threadSource: "auto" },
        requestContentMode: "none",
        maxReasoningEffort: null,
        budget: {
          spendUsd: 1,
          requests: null,
          tokens: null,
          windowSeconds: null,
          behavior: "reject",
          degradeLane: null,
        },
      },
    });
    return (
      (await handleBailianAsrChat(c, await c.req.json(), {
        resolve: () => ({
          client: { chatCompletion, chatCompletionStream: async function* () {} },
          alias: "bailian/qwen3-asr-flash",
          model: "qwen3-asr-flash",
          lane: "transcription-short",
          customModel: false,
          pricing: card,
        }),
        accounting: createTranscriptionAccounting(store, {
          defaultWindowSeconds: 86400,
          defaultDegradeLane: "economy",
        }),
        budgetGate: {
          check: async () => ({
            overBudget: false,
            limitedBy: null,
            behavior: "reject",
            degradeLane: null,
          }),
        },
        settleBudget,
        record,
      })) ?? c.text("unexpected fallback", 500)
    );
  });
  const inputAudio = { data: `data:audio/wav;base64,${wav().toString("base64")}` };
  const body = {
    model: "transcription-short",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: inputAudio,
          },
        ],
      },
    ],
    stream: false,
  };
  return {
    store,
    reserveMediaSpend,
    inputAudio,
    chatCompletion,
    record,
    settleBudget,
    body,
    saved: () => saved,
    send: (value: unknown = body) =>
      app.request("/", { method: "POST", body: JSON.stringify(value) }),
  };
}

it("reserves complete WAV duration before dispatch and settles native seconds once", async () => {
  const t = setup();
  const res = await t.send();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { accounting: { operationId: string } };
  expect(body).toMatchObject({
    usage: { seconds: 1 },
    accounting: { state: "settled", reservedUsd: 0.002, costUsd: 0.001 },
  });
  expect(res.headers.get("x-helm-media-operation-id")).toBe(body.accounting.operationId);
  expect(t.saved()).toMatchObject({ keyId: "owner", usage: { type: "duration", seconds: 1 } });
  expect(t.chatCompletion).toHaveBeenCalledTimes(1);
  expect(t.store.settleMediaSpend).toHaveBeenCalledTimes(1);
  expect(t.settleBudget.mock.calls[0]?.[1]).toMatchObject({ spendUsd: null });
  expect(t.record.mock.calls[0]?.[4]).toMatchObject({ costUsd: 0.001, usage: { seconds: 1 } });
});

it.each([
  "roundingSeconds",
  "usdPerCurrencyUnit",
] as const)("keeps missing %s fail-closed before dispatch", async (field) => {
  const card = { ...pricing, billing: { ...pricing.billing } };
  delete card.billing[field];
  const t = setup(card);
  const response = await t.send();
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ error: { code: "media_pricing_unavailable" } });
  expect(t.store.reserveMediaSpend).not.toHaveBeenCalled();
  expect(t.chatCompletion).not.toHaveBeenCalled();
});

it("rejects exhausted reservation without sending", async () => {
  const t = setup();
  t.reserveMediaSpend.mockResolvedValue(false);
  expect((await t.send()).status).toBe(429);
  expect(t.chatCompletion).not.toHaveBeenCalled();
});

it("retains reservation and operation identity on an unknown paid outcome without replay", async () => {
  const t = setup();
  t.chatCompletion.mockRejectedValue(new Error("connection lost"));
  const response = await t.send();
  expect(response.status).toBe(502);
  const body = (await response.json()) as { error: unknown };
  expect(body.error).toMatchObject({ code: "outcome_unknown", operation_id: t.saved()?.id });
  expect(t.saved()).toMatchObject({ state: "outcome_unknown", reservedUsd: 0.002, costUsd: null });
  expect(t.chatCompletion).toHaveBeenCalledTimes(1);
});

it.each([
  "not_sent",
  "rejected",
] as const)("releases a confirmed %s operation without inventing usage", async (outcome) => {
  const t = setup();
  t.chatCompletion.mockRejectedValue(
    new MediaHttpError(outcome, "upstream_error", "confirmed rejection", null, 401),
  );
  expect((await t.send()).status).toBe(502);
  expect(t.saved()).toMatchObject({ state: "settled", costUsd: 0, usage: null });
  expect(t.chatCompletion).toHaveBeenCalledTimes(1);
});

it.each([
  undefined,
  -1,
])("keeps missing or invalid native seconds unknown (%s)", async (seconds) => {
  const t = setup();
  t.chatCompletion.mockResolvedValue({
    choices: [{ message: { content: "Hello" } }],
    usage: { seconds },
  });
  const response = await t.send();
  expect(response.status).toBe(200);
  const body = (await response.json()) as { accounting: unknown };
  expect(body.accounting).toMatchObject({
    state: "outcome_unknown",
    costUsd: null,
  });
  expect(t.saved()?.costUsd).toBeNull();
  expect(t.chatCompletion).toHaveBeenCalledTimes(1);
});

it.each(["url", "truncated", "stream"])("does not expand capped ASR to %s inputs", async (kind) => {
  const t = setup();
  if (kind === "stream") t.body.stream = true;
  else
    t.inputAudio.data =
      kind === "url"
        ? "https://example.test/audio.wav"
        : `data:audio/wav;base64,${wav().subarray(0, 100).toString("base64")}`;
  expect((await t.send()).status).toBe(422);
  expect(t.chatCompletion).not.toHaveBeenCalled();
});
