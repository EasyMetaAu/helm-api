import type { IncomingMessage } from "node:http";
import { providerErrorScrubber, safeUpstreamHeaders, UpstreamError } from "@helm/core";
import { unexpectedResponseBody } from "./codex-responses-websocket.js";

/** The upgrade failure is an HTTP response, including its bounded diagnostic body. */
export async function websocketUpstreamError(
  response: IncomingMessage,
  authorization?: string,
): Promise<UpstreamError> {
  const scrub = providerErrorScrubber({ baseUrl: "" }, authorization);
  let raw: unknown;
  try {
    const body = await unexpectedResponseBody(response, 65536, 5000);
    try {
      raw = JSON.parse(body);
    } catch {
      raw = body;
    }
  } catch (cause) {
    raw = {
      error: {
        code: "error_body_unavailable",
        message: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  return new UpstreamError(
    "upstream_error",
    "upstream rejected WebSocket handshake",
    scrub(raw),
    response.statusCode ?? 502,
    scrub(safeUpstreamHeaders(headers)) as Record<string, string>,
  );
}
