import { describe, expect, it } from "vitest";
import type { IRRequest, IRResponse } from "./ir.js";
import type {
  BehaviorTransformer,
  NativeRequest,
  NativeResponse,
  Transformer,
} from "./transformer.js";

// A minimal fake transformer proving the 5-method contract is implementable
// (test #1: interface shape compiles and can be implemented).
const fakeIR: IRRequest = { model: "m", messages: [] };
const fakeRes: IRResponse = { id: "r", model: "m", choices: [] };

class FakeTransformer implements Transformer {
  readonly name = "fake";
  readonly endPoint = "/v1/fake";
  transformRequestOut(_req: NativeRequest): IRRequest {
    return fakeIR;
  }
  transformResponseOut(_res: IRResponse): NativeResponse {
    return { kind: "native-response" };
  }
  transformRequestIn(_ir: IRRequest): NativeRequest {
    return { kind: "native-request" };
  }
  transformResponseIn(_res: NativeResponse): IRResponse {
    return fakeRes;
  }
}

describe("Transformer contract", () => {
  it("a minimal transformer implements all 5 members", async () => {
    const t: Transformer = new FakeTransformer();
    expect(t.name).toBe("fake");
    expect(t.endPoint).toBe("/v1/fake");
    expect(await t.transformRequestOut({})).toBe(fakeIR);
    expect(await t.transformResponseOut(fakeRes)).toEqual({ kind: "native-response" });
    expect(await t.transformRequestIn(fakeIR)).toEqual({ kind: "native-request" });
    expect(await t.transformResponseIn({})).toBe(fakeRes);
  });

  it("methods may be async (return Promise<T>) and callers await uniformly", async () => {
    const asyncT: Transformer = {
      name: "async",
      transformRequestOut: async () => fakeIR,
      transformResponseOut: async () => ({ ok: true }),
      transformRequestIn: async () => ({ ok: true }),
      transformResponseIn: async () => fakeRes,
    };
    expect(await asyncT.transformRequestOut({})).toBe(fakeIR);
    expect(asyncT.endPoint).toBeUndefined();
  });
});

describe("BehaviorTransformer (stackable cross-cutting concerns)", () => {
  // test #6: two behaviors applied in order, IR reflects both, order deterministic.
  const clampMaxTokens: BehaviorTransformer = {
    name: "clamp-max-tokens",
    applyRequest: (ir) => ({ ...ir, max_tokens: Math.min(ir.max_tokens ?? 1024, 256) }),
  };
  const setTemperature: BehaviorTransformer = {
    name: "set-temperature",
    applyRequest: (ir) => ({ ...ir, temperature: 0 }),
  };

  it("applies behaviors in sequence; IR reflects every behavior's edit", () => {
    const base: IRRequest = { model: "m", messages: [], max_tokens: 4096, temperature: 0.9 };
    const behaviors = [clampMaxTokens, setTemperature];
    const out = behaviors.reduce<IRRequest>((ir, b) => b.applyRequest?.(ir) ?? ir, base);
    expect(out.max_tokens).toBe(256);
    expect(out.temperature).toBe(0);
    // base is untouched (behaviors are pure / non-mutating)
    expect(base.max_tokens).toBe(4096);
  });

  it("applyResponse is optional and only present behaviors run", () => {
    const injectReasoning: BehaviorTransformer = {
      name: "inject-reasoning",
      applyResponse: (res) => ({ ...res, id: `${res.id}-tagged` }),
    };
    const out = injectReasoning.applyResponse?.(fakeRes);
    expect(out?.id).toBe("r-tagged");
    expect(injectReasoning.applyRequest).toBeUndefined();
  });
});
