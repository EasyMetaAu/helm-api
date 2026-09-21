import { describe, expect, it, vi } from "vitest";
import { createJevInvoker } from "./jev.js";

const input = {
  messages: [
    { role: "system", content: "private system prompt" },
    { role: "user", content: "写排序函数" },
  ],
  tools: null,
  attachments: null,
  response_format: null,
};
function response() {
  return {
    model: "typesafe/jev-1.13-20260917",
    answers: {
      task_type: { type: "choice", choice: "coding", confidence: 0.9 },
      complexity: { type: "choice", choice: "simple", confidence: 0.8 },
    },
    usage: { cost: 0.00002 },
  };
}
describe("Jev Decisions boundary", () => {
  it("sends two typed questions with minimal state, bearer auth and cancellation", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response()));
    const signal = new AbortController().signal;
    const invoke = createJevInvoker({ apiKey: () => "secret", fetch: fetcher });
    expect(await invoke(input, "typesafe/jev-1.13", signal)).toEqual({
      text: JSON.stringify({ complexity: "simple", task_type: "coding", confidence: 0.8 }),
      cost_usd: 0.00002,
      model: "typesafe/jev-1.13-20260917",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://openrouter.ai/api/alpha/decisions",
      expect.objectContaining({ signal, redirect: "error" }),
    );
    const options = fetcher.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(options.body));
    expect(body.state.last_user_message).toBe("写排序函数");
    expect(body.questions.task_type.type).toBe("choice");
    expect(body.questions.complexity.type).toBe("choice");
    expect(String(options.body)).not.toContain("private system prompt");
    expect(String(options.body)).not.toContain("temperature");
  });
  it("rejects missing credentials before network access", async () => {
    const fetcher = vi.fn();
    await expect(
      createJevInvoker({ apiKey: () => undefined, fetch: fetcher })(
        input,
        "typesafe/jev-1.13",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    "unknown_enum",
    "missing_confidence",
    "out_of_range",
  ])("rejects %s but preserves billed cost", async (mode) => {
    const data = response();
    if (mode === "unknown_enum") data.answers.task_type.choice = "admin";
    else if (mode === "missing_confidence")
      delete (data.answers.complexity as { confidence?: number }).confidence;
    else data.answers.complexity.confidence = 2;
    const result = await createJevInvoker({
      apiKey: () => "secret",
      fetch: vi.fn<typeof fetch>(async () => Response.json(data)),
    })(input, "typesafe/jev-1.13", new AbortController().signal);
    expect(result.text).toBe("");
    expect(result.cost_usd).toBe(0.00002);
  });
  it("bounds input and redacts upstream errors", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("secret upstream body", { status: 429 }),
    );
    const invoke = createJevInvoker({ apiKey: () => "secret", fetch: fetcher });
    await expect(invoke(input, "typesafe/jev-1.13", new AbortController().signal)).rejects.toThrow(
      "Jev HTTP 429",
    );
    fetcher.mockClear();
    await expect(
      invoke(
        { ...input, messages: [{ role: "user", content: "x".repeat(40_000) }] },
        "typesafe/jev-1.13",
        new AbortController().signal,
      ),
    ).rejects.toThrow("input too large");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("external Decisions transport", () => {
  it("retains all probabilities and unknown usage without chat fallback", async () => {
    const { createJevDecisionsInvoker } = await import("./jev.js");
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: "typesafe/jev-1.13-20260917",
        answers: { q: { type: "noul", noul: 0.8 } },
      }),
    );
    const result = await createJevDecisionsInvoker({ apiKey: () => "secret", fetch: fetcher })(
      {
        model: "~typesafe/jev-latest",
        state: "synthetic",
        questions: { q: { type: "noul", instructions: "Match?" } },
      },
      new AbortController().signal,
    );
    expect(result.answers.q).toEqual({ type: "noul", noul: 0.8 });
    expect(result.usage.cost).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("bounds upstream response and never includes its text in an error", async () => {
    const { createJevDecisionsInvoker } = await import("./jev.js");
    const invoke = createJevDecisionsInvoker({
      apiKey: () => "secret",
      fetch: async () => new Response("private".repeat(50_000)),
    });
    await expect(
      invoke(
        {
          model: "~typesafe/jev-latest",
          state: "synthetic",
          questions: { q: { type: "noul", instructions: "Match?" } },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("invalid Jev response");
  });
});
