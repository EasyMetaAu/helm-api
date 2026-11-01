import { parseSseStream } from "./sse.js";

export type ConnectionClient = "claude" | "codex" | "sdk";
export interface ConnectionResult {
  auth: boolean;
  inference: boolean;
  model: string;
  status: number | null;
  firstOutputMs: number | null;
  requestId: string | null;
  failure:
    | "authentication"
    | "http"
    | "stream"
    | "network"
    | "timeout"
    | "cancelled"
    | null;
}

// One user-initiated, bounded request through the ordinary authenticated route.
// Do not return upstream bodies/errors: they can contain provider credentials.
export async function testInferenceConnection(input: {
  origin: string;
  key: string;
  client: ConnectionClient;
  model: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  onStage?: (stage: "auth" | "inference") => void;
}): Promise<ConnectionResult> {
  const fetcher = input.fetcher ?? fetch;
  const result: ConnectionResult = {
    auth: false,
    inference: false,
    model: input.model,
    status: null,
    firstOutputMs: null,
    requestId: null,
    failure: null,
  };
  const timeout = AbortSignal.timeout(30_000);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  const headers = {
    Authorization: `Bearer ${input.key}`,
    "content-type": "application/json",
  };
  try {
    input.onStage?.("auth");
    const auth = await fetcher(`${input.origin}/v1/models`, {
      headers,
      signal,
    });
    result.status = auth.status;
    await auth.body?.cancel();
    if (!auth.ok) {
      result.failure =
        auth.status === 401 || auth.status === 403 ? "authentication" : "http";
      return result;
    }
    result.auth = true;
    const body = { model: input.model, stream: true };
    const prompt = "Reply with OK only.";
    const path =
      input.client === "claude"
        ? "/v1/messages"
        : input.client === "codex"
          ? "/v1/responses"
          : "/v1/chat/completions";
    const request =
      input.client === "codex"
        ? { ...body, input: prompt, max_output_tokens: 64 }
        : {
            ...body,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 64,
          };
    input.onStage?.("inference");
    const start = performance.now();
    const response = await fetcher(`${input.origin}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal,
    });
    result.status = response.status;
    // Never link by the caller-controlled correlation id, or by the models probe.
    result.requestId =
      response.headers.get("X-Helm-Request-Id")?.trim() || null;
    result.failure = "stream";
    if (!response.ok) {
      result.failure =
        response.status === 401 || response.status === 403
          ? "authentication"
          : "http";
      if (result.failure === "authentication") result.auth = false;
    }
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      await response.body?.cancel();
      return result;
    }
    const reader = response.body?.getReader();
    if (!reader) return result;
    let wire = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 256 * 1024) return result;
        wire += decoder.decode(chunk.value, { stream: true });
        if (
          result.firstOutputMs === null &&
          parseSseStream(wire).assembled.content.trim()
        ) {
          result.firstOutputMs = Math.round(performance.now() - start);
        }
      }
      wire += decoder.decode();
      const parsed = parseSseStream(wire);
      const events = parsed.events
        .map((event) => event.data)
        .filter(
          (v): v is Record<string, unknown> =>
            v !== null && typeof v === "object" && !Array.isArray(v),
        );
      const failed = events.some(
        (event) =>
          event.error ||
          ["error", "response.failed", "response.incomplete"].includes(
            String(event.type),
          ),
      );
      const terminal =
        input.client === "claude"
          ? events.some((event) => event.type === "message_stop") &&
            parsed.assembled.finishReason === "end_turn"
          : input.client === "codex"
            ? events.some(
                (event) =>
                  event.type === "response.completed" &&
                  (event.response as { status?: unknown } | undefined)
                    ?.status === "completed",
              )
            : parsed.events.some((event) => event.raw === "[DONE]") &&
              parsed.assembled.finishReason === "stop";
      result.inference =
        !failed && terminal && parsed.assembled.content.trim().length > 0;
      if (result.inference) result.failure = null;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch {
    // Keep proven stages; unavailable checks must not claim credentials were rejected.
    result.failure = input.signal?.aborted
      ? "cancelled"
      : timeout.aborted
        ? "timeout"
        : "network";
  }
  return result;
}
