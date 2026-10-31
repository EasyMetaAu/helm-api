import { describe, expect, it } from "vitest";
import { createOutboundPrivacy } from "./outbound.js";

const secret = `sk-${"x".repeat(30)}`;
describe("request-scoped reversible outbound privacy", () => {
  it("masks repeated secrets without mutating the caller and restores tool arguments", () => {
    const privacy = createOutboundPrivacy("mask");
    const body = { messages: [{ role: "user", content: `${secret} ${secret}` }] };
    const masked = privacy.mask(body);
    expect(body.messages[0]?.content).toContain(secret);
    expect(JSON.stringify(masked)).not.toContain(secret);
    const token = masked.messages[0]?.content.split(" ")[0];
    expect(masked.messages[0]?.content).toBe(`${token} ${token}`);
    expect(privacy.restore({ arguments: JSON.stringify({ key: token }) })).toEqual({
      arguments: JSON.stringify({ key: secret }),
    });
  });
  it("never resolves another request's placeholders", () => {
    const one = createOutboundPrivacy("mask"),
      two = createOutboundPrivacy("mask");
    const token = one.mask({ input: secret }).input;
    expect(two.restore({ text: token })).toEqual({ text: token });
    expect(two.mask({ input: secret }).input).not.toBe(token);
  });
  it.each([
    "previous_response_id",
    "cachedContent",
    "encrypted_content",
    "signature",
  ])("fails closed for unsupported opaque state: %s", (key) => {
    expect(() => createOutboundPrivacy("mask").mask({ [key]: "opaque", input: secret })).toThrow(
      /privacy/,
    );
  });
  it.each([
    { type: "redacted_thinking", data: "opaque" },
    { type: "document", source: { type: "base64", data: "opaque" } },
    { type: "input_file", file_id: "file_1" },
    { type: "image_url", image_url: "https://example.test/image" },
  ])("refuses opaque and media content variants before sending", (part) => {
    expect(() => createOutboundPrivacy("mask").mask({ messages: [{ content: [part] }] })).toThrow(
      /privacy/,
    );
  });
  it("does not modify identifiers or tool schemas and supports an explicit block mode", () => {
    expect(() => createOutboundPrivacy("mask").mask({ model: secret })).toThrow(/privacy/);
    expect(() =>
      createOutboundPrivacy("mask").mask({ tools: [{ parameters: { enum: [secret] } }] }),
    ).toThrow(/privacy/);
    expect(() => createOutboundPrivacy("block").mask({ input: secret })).toThrow(/privacy/);
  });
  it("restores a placeholder split across semantic deltas and arbitrary network chunks", async () => {
    const privacy = createOutboundPrivacy("mask");
    const token = privacy.mask({ input: secret }).input;
    const wire =
      token
        .split("")
        .map(
          (delta) =>
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta } }] })}\r\n\r\n`,
        )
        .join("") + "data: [DONE]\n\n";
    async function* chunks() {
      for (let i = 0; i < wire.length; i += 7) yield wire.slice(i, i + 7);
    }
    let output = "";
    for await (const chunk of privacy.restoreStream(chunks())) output += chunk;
    const text = output
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content)
      .join("");
    expect(text).toBe(secret);
    expect(output).toContain("[DONE]");
  });
  it("does not mix fragments between tool calls", async () => {
    const privacy = createOutboundPrivacy("mask");
    const token = privacy.mask({ input: secret }).input;
    async function* chunks() {
      yield `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "a", delta: token.slice(0, 12) })}\n\n`;
      yield `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "b", delta: "safe" })}\n\n`;
      yield `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "a", delta: token.slice(12) })}\n\n`;
    }
    let output = "";
    for await (const chunk of privacy.restoreStream(chunks())) output += chunk;
    expect(output).toContain(secret);
    expect(output).toContain('"delta":"safe"');
  });
  it("restores completed Responses snapshots with a null previous_response_id", () => {
    const privacy = createOutboundPrivacy("mask");
    const token = privacy.mask({ input: secret }).input;
    expect(
      privacy.restore({
        previous_response_id: null,
        output: [{ content: [{ type: "output_text", text: token }] }],
      }),
    ).toMatchObject({ output: [{ content: [{ text: secret }] }] });
  });
  it("keeps signed reasoning bytes unchanged", () => {
    const privacy = createOutboundPrivacy("mask");
    const token = privacy.mask({ input: secret }).input;
    const thinking = { type: "thinking", thinking: token, signature: "signed" };
    expect(privacy.restore(thinking)).toEqual(thinking);
  });
  it("masks native raw bytes as well as normalized and memory-injected content", () => {
    const privacy = createOutboundPrivacy("mask");
    const body = { input: secret, unknown: { locale: "漢字 😀" } };
    const request = {
      messages: [{ content: secret }],
      native: { body, raw_body: JSON.stringify(body) },
    };
    const masked = privacy.mask(request);
    expect(JSON.stringify(masked)).not.toContain(secret);
    expect(JSON.parse(masked.native.raw_body)).toEqual(masked.native.body);
    expect(masked.native.body.unknown).toEqual(body.unknown);
  });
  it("leaves default-off requests and wire bytes unchanged", async () => {
    const privacy = createOutboundPrivacy("off");
    const body = { input: secret };
    expect(privacy.mask(body)).toBe(body);
    async function* chunks() {
      yield "not even SSE";
    }
    const out = [];
    for await (const chunk of privacy.restoreStream(chunks())) out.push(chunk);
    expect(out).toEqual(["not even SSE"]);
  });
});
