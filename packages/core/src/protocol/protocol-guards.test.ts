import { describe, expect, it } from "vitest";
import type { IRRequest } from "./ir.js";
import {
  capNToOne,
  guardRequestFor,
  ProtocolWarningSchema,
  pushWarning,
  readWarnings,
  warnUnsupported,
} from "./protocol-guards.js";

function baseIR(overrides: Partial<IRRequest> = {}): IRRequest {
  return {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

describe("protocol-guards: structured warnings", () => {
  it("ProtocolWarning is a strict, parseable shape", () => {
    const w = ProtocolWarningSchema.parse({
      code: "n_capped",
      param: "n",
      target: "anthropic",
      message: "capped",
    });
    expect(w.code).toBe("n_capped");
    // unknown code fails closed
    expect(() =>
      ProtocolWarningSchema.parse({ code: "??", param: "n", target: "anthropic", message: "x" }),
    ).toThrow();
  });

  it("pushWarning records onto provider_raw.warnings without mutating the input", () => {
    const ir = baseIR();
    const next = pushWarning(ir, {
      code: "data_loss",
      param: "logprobs",
      target: "anthropic",
      message: "Anthropic Messages has no logprobs surface; dropped.",
    });
    expect(ir.provider_raw).toBeUndefined(); // input untouched (pure)
    expect(readWarnings(next)).toHaveLength(1);
    expect(readWarnings(next)[0]?.param).toBe("logprobs");
  });

  it("pushWarning appends to existing warnings and preserves other provider_raw keys", () => {
    const ir = baseIR({ provider_raw: { stop_reason: "keep-me", warnings: [] } });
    const a = pushWarning(ir, {
      code: "n_capped",
      param: "n",
      target: "gemini",
      message: "x",
    });
    const b = pushWarning(a, {
      code: "data_loss",
      param: "modalities",
      target: "anthropic",
      message: "y",
    });
    expect(readWarnings(b)).toHaveLength(2);
    expect(b.provider_raw?.stop_reason).toBe("keep-me");
  });
});

describe("protocol-guards: capNToOne (n>1 reject-clean)", () => {
  it("caps n>1 to 1 and records an n_capped warning", () => {
    const ir = baseIR({ n: 4 });
    const { ir: next, capped } = capNToOne(ir, "anthropic");
    expect(capped).toBe(true);
    expect(next.n).toBe(1);
    const warnings = readWarnings(next);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("n_capped");
    expect(warnings[0]?.param).toBe("n");
    expect(warnings[0]?.target).toBe("anthropic");
    expect(warnings[0]?.message).toContain("1");
  });

  it("n===1 and undefined are left untouched with no warning", () => {
    for (const n of [undefined, 1] as const) {
      const ir = baseIR(n === undefined ? {} : { n });
      const { ir: next, capped } = capNToOne(ir, "gemini");
      expect(capped).toBe(false);
      expect(next.n).toBe(n);
      expect(readWarnings(next)).toHaveLength(0);
      // pure: same reference returned when nothing changed
      expect(next).toBe(ir);
    }
  });
});

describe("protocol-guards: warnUnsupported (data-loss guard)", () => {
  it("emits a data_loss warning only when the param is present", () => {
    const present = warnUnsupported(
      baseIR({ logprobs: true }),
      "logprobs",
      "anthropic",
      "no surface",
    );
    expect(readWarnings(present)).toHaveLength(1);
    expect(readWarnings(present)[0]?.code).toBe("data_loss");

    const absent = warnUnsupported(baseIR(), "logprobs", "anthropic", "no surface");
    expect(readWarnings(absent)).toHaveLength(0);
    // unchanged -> same reference
    expect(absent).toBe(absent);
  });

  it("treats an empty modalities array as absent (nothing to lose)", () => {
    const ir = baseIR({ modalities: [] });
    const out = warnUnsupported(ir, "modalities", "anthropic", "text-only");
    expect(readWarnings(out)).toHaveLength(0);
  });

  it("warns on a non-empty modalities array", () => {
    const ir = baseIR({ modalities: ["text", "audio"] });
    const out = warnUnsupported(ir, "modalities", "anthropic", "text-only");
    expect(readWarnings(out)).toHaveLength(1);
    expect(readWarnings(out)[0]?.param).toBe("modalities");
  });
});

describe("protocol-guards: guardRequestFor (per-target dispatch)", () => {
  it("anthropic caps n and warns on logprobs + modalities in one pass", () => {
    const ir = baseIR({ n: 3, logprobs: true, top_logprobs: 5, modalities: ["text", "audio"] });
    const out = guardRequestFor("anthropic", ir);
    expect(out.n).toBe(1);
    const codes = readWarnings(out).map((w) => `${w.code}:${w.param}`);
    expect(codes).toContain("n_capped:n");
    expect(codes).toContain("data_loss:logprobs");
    expect(codes).toContain("data_loss:top_logprobs");
    expect(codes).toContain("data_loss:modalities");
  });

  it("anthropic with only mappable params records nothing", () => {
    const ir = baseIR({ temperature: 0.2, top_p: 0.9 });
    const out = guardRequestFor("anthropic", ir);
    expect(readWarnings(out)).toHaveLength(0);
    expect(out).toBe(ir);
  });

  it("gemini honors n/logprobs/modalities natively -> no-op", () => {
    const ir = baseIR({ n: 4, logprobs: true, modalities: ["text", "image"] });
    const out = guardRequestFor("gemini", ir);
    expect(out).toBe(ir);
    expect(out.n).toBe(4);
    expect(readWarnings(out)).toHaveLength(0);
  });

  it("openai (IR-native) and unknown targets are no-ops", () => {
    const ir = baseIR({ n: 2, logprobs: true });
    expect(guardRequestFor("openai", ir)).toBe(ir);
    expect(guardRequestFor("made-up", ir)).toBe(ir);
  });
});
