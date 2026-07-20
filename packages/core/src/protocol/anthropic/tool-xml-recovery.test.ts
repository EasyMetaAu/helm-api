import { describe, expect, it } from "vitest";
import {
  hasInvokeStart,
  invokeStartIndex,
  invokeStartPrefixSuffixLength,
  recoverTerminalToolCallsFromText,
  recoverToolCallsFromText,
} from "./tool-xml-recovery.js";

const tools = (...names: string[]): ReadonlySet<string> => new Set(names);

describe("hasInvokeStart", () => {
  it("recognizes bare and antml-prefixed invoke starts case-sensitively", () => {
    expect(hasInvokeStart('<invoke name="Bash">')).toBe(true);
    expect(hasInvokeStart('<antml:invoke name="Bash">')).toBe(true);
    expect(hasInvokeStart('<Invoke name="Bash">')).toBe(false);
    expect(hasInvokeStart("ordinary text")).toBe(false);
  });

  it("finds complete starts and retains only a still-possible trailing prefix", () => {
    expect(invokeStartIndex('text <invoke name="Bash">')).toBe(5);
    expect(invokeStartIndex('text <antml:invoke name="Bash">')).toBe(5);
    expect(invokeStartPrefixSuffixLength("if (a < b)")).toBe(0);
    expect(invokeStartPrefixSuffixLength("text <inv")).toBe(4);
  });
});

describe("recoverToolCallsFromText", () => {
  it("recovers one closed, declared invoke", () => {
    expect(
      recoverToolCallsFromText(
        '<invoke name="Bash"><parameter name="command">git status</parameter></invoke>',
        tools("Bash"),
      ),
    ).toEqual([
      {
        type: "tool_use",
        call: { name: "Bash", input: { command: "git status" } },
      },
    ]);
  });

  it("coerces JSON-looking values and preserves other raw strings", () => {
    const text =
      '<invoke name="Tool">' +
      '<parameter name="enabled"> true </parameter>' +
      '<parameter name="count">-12.5</parameter>' +
      '<parameter name="missing">null</parameter>' +
      '<parameter name="items">[1,"two"]</parameter>' +
      '<parameter name="config">{"nested":true}</parameter>' +
      '<parameter name="quoted">"Paris"</parameter>' +
      '<parameter name="word"> Paris </parameter>' +
      '<parameter name="invalid"> 12oops </parameter>' +
      "</invoke>";

    const segments = recoverToolCallsFromText(text, tools("Tool"));
    expect(segments).toEqual([
      {
        type: "tool_use",
        call: {
          name: "Tool",
          input: {
            enabled: true,
            count: -12.5,
            missing: null,
            items: [1, "two"],
            config: { nested: true },
            quoted: "Paris",
            word: " Paris ",
            invalid: " 12oops ",
          },
        },
      },
    ]);
  });

  it("keeps non-finite and unsafe JSON numbers as strings", () => {
    const text =
      '<invoke name="Tool">' +
      '<parameter name="infinite">1e309</parameter>' +
      '<parameter name="unsafe">9007199254740993</parameter>' +
      '<parameter name="safe">9007199254740991</parameter>' +
      "</invoke>";

    expect(recoverToolCallsFromText(text, tools("Tool"))).toEqual([
      {
        type: "tool_use",
        call: {
          name: "Tool",
          input: {
            infinite: "1e309",
            unsafe: "9007199254740993",
            safe: 9007199254740991,
          },
        },
      },
    ]);
  });

  it("preserves surrounding text in order", () => {
    expect(
      recoverToolCallsFromText(
        'before <invoke name="Bash"><parameter name="command">pwd</parameter></invoke> after',
        tools("Bash"),
      ),
    ).toEqual([
      { type: "text", text: "before " },
      { type: "tool_use", call: { name: "Bash", input: { command: "pwd" } } },
      { type: "text", text: " after" },
    ]);
  });

  it("recovers multiple invokes without merging their lazy bodies", () => {
    const text =
      '<invoke name="Read"><parameter name="path">a</parameter></invoke>' +
      '<invoke name="Read"><parameter name="path">b</parameter></invoke>';

    expect(recoverToolCallsFromText(text, tools("Read"))).toEqual([
      { type: "tool_use", call: { name: "Read", input: { path: "a" } } },
      { type: "tool_use", call: { name: "Read", input: { path: "b" } } },
    ]);
  });

  it("returns null when the only invoke is not whitelisted", () => {
    const text = '<invoke name="Bash"><parameter name="command">pwd</parameter></invoke>';
    expect(recoverToolCallsFromText(text, tools("Read"))).toBeNull();
  });

  it("keeps a non-whitelisted invoke verbatim between recovered invokes", () => {
    const skipped = '<invoke name="Write"><parameter name="path">x</parameter></invoke>';
    const text =
      '<invoke name="Read"><parameter name="path">a</parameter></invoke>' +
      skipped +
      '<invoke name="Read"><parameter name="path">b</parameter></invoke>';

    expect(recoverToolCallsFromText(text, tools("Read"))).toEqual([
      { type: "tool_use", call: { name: "Read", input: { path: "a" } } },
      { type: "text", text: skipped },
      { type: "tool_use", call: { name: "Read", input: { path: "b" } } },
    ]);
  });

  it("returns null for an unclosed invoke", () => {
    expect(
      recoverToolCallsFromText(
        '<invoke name="Bash"><parameter name="command">pwd</parameter>',
        tools("Bash"),
      ),
    ).toBeNull();
  });

  it("returns null for ordinary text and for an empty declared-tool set", () => {
    expect(recoverToolCallsFromText("ordinary text", tools("Bash"))).toBeNull();
    expect(recoverToolCallsFromText('<invoke name="Bash"></invoke>', new Set<string>())).toBeNull();
  });

  it("recovers the antml-prefixed variant", () => {
    const ns = "antml:";
    const text =
      `<${ns}invoke name="Bash">` +
      `<${ns}parameter name="command">pwd</${ns}parameter>` +
      `</${ns}invoke>`;

    expect(recoverToolCallsFromText(text, tools("Bash"))).toEqual([
      { type: "tool_use", call: { name: "Bash", input: { command: "pwd" } } },
    ]);
  });

  it("matches declared tool names case-sensitively", () => {
    const text = '<invoke name="bash"><parameter name="command">pwd</parameter></invoke>';
    expect(recoverToolCallsFromText(text, tools("Bash"))).toBeNull();
  });

  it("uses the last duplicate parameter and cannot pollute Object.prototype", () => {
    const text =
      '<invoke name="Tool">' +
      '<parameter name="value">1</parameter>' +
      '<parameter name="value">2</parameter>' +
      '<parameter name="__proto__">{"polluted":true}</parameter>' +
      "</invoke>";

    const segments = recoverToolCallsFromText(text, tools("Tool"));
    expect(segments).not.toBeNull();
    const call = segments?.find((segment) => segment.type === "tool_use");
    expect(call?.type).toBe("tool_use");
    if (call?.type !== "tool_use") throw new Error("expected recovered tool_use");

    expect(call.call.input.value).toBe(2);
    expect(Object.hasOwn(call.call.input, "__proto__")).toBe(true);
    expect(call.call.input.__proto__).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(call.call.input)).toBeNull();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("recoverTerminalToolCallsFromText", () => {
  const invoke = '<invoke name="Bash"><parameter name="command">git status</parameter></invoke>';

  it("recovers a declared complete terminal invoke after leading prose and preserves whitespace", () => {
    expect(recoverTerminalToolCallsFromText(`analysis\n${invoke}\n`, tools("Bash"))).toEqual([
      { type: "text", text: "analysis\n" },
      { type: "tool_use", call: { name: "Bash", input: { command: "git status" } } },
      { type: "text", text: "\n" },
    ]);
  });

  it.each([
    ["an open code fence", `\`\`\`xml\n${invoke}`],
    ["surrounding trailing text", `${invoke} done`],
    ["an unclosed invoke tail", `${invoke}<invoke name="Bash">`],
    ["an unknown invoke tail", `${invoke}<invoke name="Read"></invoke>`],
    ["a nameless invoke prefix", `<invoke>${invoke}`],
    ["a stray closing invoke prefix", `</invoke>${invoke}`],
    ["an incomplete function_calls wrapper", `<function_calls>${invoke}`],
    ["prose between multiple invokes", `${invoke}\nexample only\n${invoke}`],
  ])("rejects $0", (_label, text) => {
    expect(recoverTerminalToolCallsFromText(text, tools("Bash"))).toBeNull();
  });
});
