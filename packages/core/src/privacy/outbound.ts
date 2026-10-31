import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { RuntimeConfig } from "@helm/shared";
import { nextSSEFrameBoundary } from "../protocol/streaming.js";

export type OutboundPrivacyMode = RuntimeConfig["outbound_privacy"];
const secrets =
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g;
const opaque = new Set([
  "previous_response_id",
  "cachedContent",
  "encrypted_content",
  "signature",
  "thoughtSignature",
  "redacted_thinking",
  "input_audio",
  "inlineData",
  "fileData",
  "file_id",
  "file_data",
  "image_url",
  "image",
  "audio",
  "video",
]);
const identifiers = new Set([
  "model",
  "name",
  "type",
  "id",
  "call_id",
  "tool_call_id",
  "url",
  "image_url",
  "file_uri",
  "mime_type",
  "role",
]);
const schemas = new Set(["parameters", "input_schema", "response_format", "json_schema"]);

export class OutboundPrivacyError extends Error {
  constructor() {
    super(
      "Outbound privacy cannot safely process this request or stream; nothing further was forwarded.",
    );
  }
}

export function createOutboundPrivacy(mode: OutboundPrivacyMode) {
  // Random, per-request namespace. Neither secrets nor restoration authority can
  // cross concurrent requests, keys, sessions, or tenants. Never persisted.
  const prefix = `{{HELM_${randomBytes(16).toString("hex")}_`;
  const values = new Map<string, string>();
  const tokens = new Map<string, string>();
  const replace = (text: string): string =>
    text.replace(secrets, (value) => {
      if (mode === "block") throw new OutboundPrivacyError();
      let token = tokens.get(value);
      if (!token) {
        if (values.size >= 1024) throw new OutboundPrivacyError();
        token = `${prefix}${values.size}}}`;
        tokens.set(value, token);
        values.set(token, value);
      }
      return token;
    });
  const restoreText = (text: string): string => {
    if (!text.includes(prefix)) return text;
    return text.replace(/\{\{HELM_[a-f0-9]{32}_\d+\}\}/g, (token) => values.get(token) ?? token);
  };
  function maskNode(value: unknown, key = "", schema = false): unknown {
    if (opaque.has(key) && value !== null && value !== undefined && value !== "")
      throw new OutboundPrivacyError();
    if (typeof value === "string") {
      if (!value.match(secrets)) return value;
      if (schema || identifiers.has(key)) throw new OutboundPrivacyError();
      return replace(value);
    }
    if (Array.isArray(value)) return value.map((item) => maskNode(item, key, schema));
    if (!value || typeof value !== "object") return value;
    const type = (value as Record<string, unknown>).type;
    if (
      typeof type === "string" &&
      [
        "redacted_thinking",
        "document",
        "image",
        "image_url",
        "input_image",
        "input_file",
        "input_audio",
        "image_generation",
        "file_search",
      ].includes(type)
    )
      throw new OutboundPrivacyError();
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => {
        if (name.match(secrets)) throw new OutboundPrivacyError();
        return [name, maskNode(child, name, schema || schemas.has(name))];
      }),
    );
  }
  function restoreNode(value: unknown, key = ""): unknown {
    if (opaque.has(key) || identifiers.has(key)) return value;
    if (typeof value === "string") return restoreText(value);
    if (Array.isArray(value)) return value.map((item) => restoreNode(item, key));
    if (!value || typeof value !== "object") return value;
    if (
      ["signature", "thoughtSignature", "encrypted_content"].some((name) =>
        Boolean((value as Record<string, unknown>)[name]),
      )
    )
      return value;
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [name, restoreNode(child, name)]),
    );
  }
  return {
    mask<T>(value: T): T {
      return mode === "off" ? value : (maskNode(value) as T);
    },
    restore<T>(value: T): T {
      return mode === "off" ? value : (restoreNode(value) as T);
    },
    async *restoreStream(source: AsyncIterable<string>): AsyncIterable<string> {
      if (mode !== "mask" || values.size === 0) {
        yield* source;
        return;
      }
      let buffer = "";
      const tails = new Map<string, string>();
      function fragment(text: string, channel: string): string {
        const joined = (tails.get(channel) ?? "") + text;
        tails.delete(channel);
        // A known placeholder can be split at any byte of its ASCII spelling.
        // Hold only its unfinished suffix, independently for each semantic lane.
        let held = 0;
        for (let n = 1; n <= Math.min(joined.length, prefix.length + 8); n++) {
          const suffix = joined.slice(-n);
          if (prefix.startsWith(suffix) || (suffix.startsWith(prefix) && !suffix.endsWith("}}")))
            held = n;
        }
        if (held) {
          if (tails.size >= 256) throw new OutboundPrivacyError();
          tails.set(channel, joined.slice(-held));
        }
        return restoreText(held ? joined.slice(0, -held) : joined);
      }
      function transform(value: unknown, channel: string, path = "", key = ""): unknown {
        if (opaque.has(key) || identifiers.has(key)) return value;
        if (typeof value === "string") {
          const delta =
            key === "content" ||
            key === "text" ||
            key === "partial_json" ||
            key === "arguments" ||
            key === "delta";
          return delta ? fragment(value, `${channel}:${path}`) : restoreText(value);
        }
        if (Array.isArray(value))
          return value.map((child, index) => {
            const id =
              child && typeof child === "object" && "index" in child
                ? String(child.index)
                : String(index);
            return transform(child, channel, `${path}[${id}]`, key);
          });
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(
          Object.entries(value).map(([name, child]) => [
            name,
            transform(child, channel, `${path}.${name}`, name),
          ]),
        );
      }
      function frame(wire: string): string {
        const lines = wire.split(/\r\n|\r|\n/);
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") {
          if (data === "[DONE]" && tails.size) throw new OutboundPrivacyError();
          return wire;
        }
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          throw new OutboundPrivacyError();
        }
        if (!event || typeof event !== "object" || Array.isArray(event))
          throw new OutboundPrivacyError();
        const record = event as Record<string, unknown>;
        const kind = typeof record.type === "string" ? record.type : "chat";
        if (
          JSON.stringify(event).includes('"thinking_delta"') ||
          JSON.stringify(event).includes('"signature_delta"')
        )
          return wire;
        const isDelta = kind === "chat" || kind.endsWith("delta");
        const channel = `${kind}:${record.item_id ?? record.index ?? ""}:${record.output_index ?? ""}:${record.content_index ?? ""}`;
        const result = isDelta ? transform(event, channel) : restoreNode(event);
        if (
          ["message_stop", "response.completed", "response.failed", "response.incomplete"].includes(
            kind,
          ) &&
          tails.size
        )
          throw new OutboundPrivacyError();
        return [
          ...lines.filter((line) => !line.startsWith("data:")),
          `data: ${JSON.stringify(result)}`,
        ].join("\n");
      }
      for await (const chunk of source) {
        buffer += chunk;
        if (buffer.length > 1024 * 1024) throw new OutboundPrivacyError();
        for (;;) {
          const boundary = nextSSEFrameBoundary(buffer);
          if (!boundary) break;
          yield frame(buffer.slice(0, boundary.index)) +
            buffer.slice(boundary.index, boundary.index + boundary.length);
          buffer = buffer.slice(boundary.index + boundary.length);
        }
      }
      if (buffer.trim()) yield frame(buffer);
      if (tails.size) throw new OutboundPrivacyError();
    },
  };
}

export const outboundPrivacyContext = new AsyncLocalStorage<
  ReturnType<typeof createOutboundPrivacy>
>();
