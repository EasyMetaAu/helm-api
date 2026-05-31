import { describe, expect, it } from "vitest";
import type { IRRequest, IRResponse } from "./ir.js";
import { mountEndpoints, TransformerRegistry } from "./registry.js";
import type { Transformer } from "./transformer.js";

const ir: IRRequest = { model: "m", messages: [] };
const res: IRResponse = { id: "r", model: "m", choices: [] };

function makeTransformer(name: string, endPoint?: string): Transformer {
  return {
    name,
    ...(endPoint ? { endPoint } : {}),
    transformRequestOut: () => ir,
    transformResponseOut: () => ({}),
    transformRequestIn: () => ({}),
    transformResponseIn: () => res,
  };
}

describe("TransformerRegistry", () => {
  // test #2: register + get round-trips the same instance; unknown -> undefined.
  it("register(t) then get(t.name) returns the same instance", () => {
    const reg = new TransformerRegistry();
    const t = makeTransformer("openai", "/v1/chat/completions");
    reg.register(t);
    expect(reg.get("openai")).toBe(t);
    expect(reg.get("unknown")).toBeUndefined();
  });

  // test #3: duplicate name fails closed (throws), never silently overwrites.
  it("registering the same name twice throws (fail-closed)", () => {
    const reg = new TransformerRegistry();
    const first = makeTransformer("anthropic", "/v1/messages");
    reg.register(first);
    expect(() => reg.register(makeTransformer("anthropic", "/v1/other"))).toThrow();
    // original is preserved, not shadowed
    expect(reg.get("anthropic")).toBe(first);
  });

  // test #4: endPoint enumeration + mountEndpoints locates the right name.
  it("endpoints() includes transformers that declare an endPoint", () => {
    const reg = new TransformerRegistry();
    const anthropic = makeTransformer("anthropic", "/v1/messages");
    reg.register(anthropic);
    const eps = reg.endpoints();
    expect(eps).toHaveLength(1);
    expect(eps[0]).toEqual({ endPoint: "/v1/messages", transformer: anthropic });

    const mounted = mountEndpoints(reg);
    const hit = mounted.find((m) => m.endPoint === "/v1/messages");
    expect(hit?.name).toBe("anthropic");
  });

  // test #5: a pure outbound transformer (no endPoint) is absent from endpoints()
  // but still retrievable by name (used for outbound translation only).
  it("pure outbound transformer has no endPoint but is still get()-able", () => {
    const reg = new TransformerRegistry();
    const outbound = makeTransformer("vertex"); // no endPoint
    reg.register(outbound);
    expect(reg.endpoints()).toHaveLength(0);
    expect(mountEndpoints(reg)).toHaveLength(0);
    expect(reg.get("vertex")).toBe(outbound);
  });

  it("mountEndpoints returns one abstract {endPoint, name} per inbound transformer", () => {
    const reg = new TransformerRegistry();
    reg.register(makeTransformer("openai", "/v1/chat/completions"));
    reg.register(makeTransformer("anthropic", "/v1/messages"));
    reg.register(makeTransformer("vertex")); // outbound only
    const mounted = mountEndpoints(reg);
    expect(mounted).toHaveLength(2);
    expect(mounted.map((m) => m.endPoint).sort()).toEqual(["/v1/chat/completions", "/v1/messages"]);
  });
});
