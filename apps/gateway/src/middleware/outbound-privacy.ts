import {
  createOutboundPrivacy,
  OutboundPrivacyError,
  type OutboundPrivacyMode,
  outboundPrivacyContext,
} from "@helm/core";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";

const textPath =
  /^(?:\/(?:v1\/)?(?:chat\/completions|messages(?:\/count_tokens)?|responses(?:\/input_tokens)?)|\/openai\/v1\/responses|\/engines\/[^/]+\/chat\/completions|\/openai\/deployments\/[^/]+\/chat\/completions|\/(?:v1beta\/)?models\/[^/]+:(?:generateContent|streamGenerateContent|countTokens))$/;
const unsupportedPath =
  /^\/(?:v1\/(?:images|audio|videos|tts|3d|realtime|live)|(?:v1\/|openai\/v1\/)?responses|v1beta\/interactions|admin\/api\/(?:oauth\/[^/]+\/test|api-key-pools\/[^/]+\/accounts\/[^/]+\/test|requests\/[^/]+\/replay))(?:\/|$)/;
const inferenceNamespace =
  /^\/(?:v1(?:\/|$)|v1beta(?:\/|$)|models\/|responses(?:\/|$)|messages(?:\/|$)|chat\/|engines\/|openai\/(?:v1\/|deployments\/))/;
const maxBody = 1024 * 1024;

async function boundedBody(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let text = "",
    bytes = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > maxBody) throw new OutboundPrivacyError();
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* decodedBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      yield decoder.decode(chunk.value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function outboundPrivacyMiddleware(mode: OutboundPrivacyMode): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (
      mode === "off" ||
      (!textPath.test(c.req.path) &&
        !unsupportedPath.test(c.req.path) &&
        !(inferenceNamespace.test(c.req.path) && c.req.method !== "GET"))
    )
      return next();
    const reject = () =>
      c.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            code: "outbound_privacy_unsupported",
            message:
              "Outbound privacy supports self-contained text requests up to 1 MiB. Opaque context, media and stateful continuations are not supported.",
          },
        },
        400,
      );
    if (
      !textPath.test(c.req.path) ||
      c.req.method !== "POST" ||
      c.req.header("upgrade") ||
      c.req.header("x-codex-turn-state")
    )
      return reject();
    const privacy = createOutboundPrivacy(mode);
    try {
      const value: unknown = JSON.parse(
        await boundedBody(c.req.raw.body, c.get("request_timeout")?.signal ?? c.req.raw.signal),
      );
      const masked = privacy.mask(value);
      const headers = new Headers(c.req.raw.headers);
      headers.delete("content-length");
      c.req.raw = new Request(c.req.raw, { body: JSON.stringify(masked), headers });
      c.req.bodyCache = {};
    } catch {
      return reject();
    }
    // Includes classification and memory admission. The route masks again after
    // memory injection, using this same request's restoration authority.
    await outboundPrivacyContext.run(privacy, next);
    if (!c.res.body) return;
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    if (headers.get("content-type")?.includes("text/event-stream")) {
      const source = c.res.body.getReader();
      const iterator = privacy.restoreStream(decodedBody(source))[Symbol.asyncIterator]();
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await iterator.next();
            if (chunk.done) controller.close();
            else controller.enqueue(encoder.encode(chunk.value));
          } catch (error) {
            controller.error(error);
            await source.cancel().catch(() => {});
            await iterator.return?.();
          }
        },
        async cancel(reason) {
          await source.cancel(reason).catch(() => {});
          await iterator.return?.();
        },
      });
      c.res = new Response(body, { status: c.res.status, headers });
    } else if (headers.get("content-type")?.includes("application/json")) {
      try {
        const value: unknown = JSON.parse(
          await boundedBody(c.res.body, c.get("request_timeout")?.signal ?? c.req.raw.signal),
        );
        c.res = new Response(JSON.stringify(privacy.restore(value)), {
          status: c.res.status,
          headers,
        });
      } catch {
        c.res = reject();
      }
    }
  };
}
