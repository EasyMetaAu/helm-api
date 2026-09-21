import { describe, expect, it } from "vitest";
import { DecisionsRequestSchema, validateDecisionsResponse } from "./decisions.js";

export const request = {
  model: "~typesafe/jev-latest",
  state: { message: "synthetic private text" },
  questions: {
    match: { type: "noul", instructions: "Is this a quote request?" },
    intent: {
      type: "choice",
      instructions: "Select intent",
      criteria: { buy: "Purchase", other: "Other" },
    },
    risk: { type: "score", instructions: "Risk", criteria: ["Low", "Medium", "High"] },
  },
};
export const response = {
  id: "gen-dec-test",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: {
    match: { type: "noul", noul: 0.9 },
    intent: {
      type: "choice",
      choice: "buy",
      confidence: 0.8,
      probabilities: { buy: 0.9, other: 0.1 },
    },
    risk: {
      type: "score",
      score: 0.3,
      confidence: 0.8,
      probabilities: { "0": 0.8, "1": 0.1, "2": 0.1 },
      legend: { "0": "Low", "1": "Medium", "2": "High" },
    },
  },
  usage: { input_tokens: 100, output_tokens: 20, cost: 0.000005 },
};

describe("Decisions contract", () => {
  it("retains typed distributions, actual version, usage and structured guidance", () => {
    const input = DecisionsRequestSchema.parse(request);
    expect(validateDecisionsResponse(input, response)).toEqual(response);
    expect(
      DecisionsRequestSchema.safeParse({
        ...request,
        state: [],
        questions: {
          q: {
            type: "choice",
            instructions: { task: "choose" },
            criteria: { a: null, b: ["other"] },
          },
        },
      }).success,
    ).toBe(true);
  });
  it.each([
    { model: "openai/gpt-4o" },
    { provider: { base_url: "https://evil.invalid" } },
    { api_key: "secret" },
    { state: null },
    { questions: {} },
    { questions: { x: { type: "choice", instructions: "x", criteria: {} } } },
    { questions: { x: { type: "score", instructions: "x", criteria: [] } } },
    { questions: { x: { type: "noul", instructions: "x", criteria: { true: "yes" } } } },
  ])("rejects invalid input %j", (change) => {
    expect(DecisionsRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
  });
  it.each([
    "missing",
    "extra",
    "type",
    "choice",
    "sum",
    "negative",
    "infinite",
    "keys",
    "score",
    "model",
    "usage",
    "winner",
    "mean",
  ])("rejects invalid response: %s", (mode) => {
    const data = structuredClone(response);
    if (mode === "missing") Reflect.deleteProperty(data.answers, "match");
    if (mode === "extra") Reflect.set(data.answers, "extra", data.answers.match);
    if (mode === "type") Reflect.set(data.answers, "match", data.answers.intent);
    if (mode === "choice") data.answers.intent.choice = "unknown";
    if (mode === "sum") data.answers.intent.probabilities.buy = 0.2;
    if (mode === "negative") data.answers.match.noul = -0.1;
    if (mode === "infinite") data.answers.intent.confidence = Infinity;
    if (mode === "keys") Reflect.deleteProperty(data.answers.risk.probabilities, "2");
    if (mode === "score") data.answers.risk.score = 5;
    if (mode === "model") data.model = "~typesafe/jev-latest";
    if (mode === "usage") data.usage.cost = -1;
    if (mode === "winner") data.answers.intent.choice = "other";
    if (mode === "mean") data.answers.risk.score = 1.9;
    expect(() => validateDecisionsResponse(DecisionsRequestSchema.parse(request), data)).toThrow();
  });
  it("normalizes missing usage and cost to unknown", () => {
    expect(
      validateDecisionsResponse(DecisionsRequestSchema.parse(request), {
        ...response,
        usage: undefined,
      }).usage,
    ).toEqual({ input_tokens: null, output_tokens: null, cost: null });
    expect(
      validateDecisionsResponse(DecisionsRequestSchema.parse(request), {
        ...response,
        usage: { input_tokens: 10 },
      }).usage,
    ).toEqual({ input_tokens: 10, output_tokens: null, cost: null });
  });
});
