import { Buffer } from "node:buffer";
import { describe, test } from "vitest";

// Default-skipped because each enabled run performs two potentially paid writes.
// Run intentionally with:
// HELM_API_KEY=... HELM_LIVE_MEDIA_CONFIRM=I_ACCEPT_EXACTLY_2_MEDIA_CREATES \
//   CI=true pnpm exec vitest run apps/gateway/src/live-grok-imagine.test.ts --maxWorkers=1
const CONFIRMATION = "I_ACCEPT_EXACTLY_2_MEDIA_CREATES";
const liveEnabled = process.env.HELM_LIVE_MEDIA_CONFIRM === CONFIRMATION;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function requiredApiKey(): string {
  const key = process.env.HELM_API_KEY?.trim();
  if (!key) throw new Error("missing_HELM_API_KEY");
  return key;
}

function baseUrl(): URL {
  const url = new URL(process.env.HELM_BASE_URL ?? "http://127.0.0.1:8080");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("HELM_BASE_URL_must_be_loopback");
  }
  return url;
}

function positiveInteger(name: string, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

async function helmJson(path: string, init: RequestInit): Promise<JsonObject> {
  let response: Response;
  try {
    response = await fetch(new URL(path, baseUrl()), {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error("helm_network_or_timeout");
  }

  let body: JsonObject | null = null;
  try {
    body = object(await response.json());
  } catch {
    // Keep provider bodies, prompts, receipts, and signed URLs out of test output.
  }
  if (!response.ok) {
    const error = object(body?.error);
    const code = typeof error?.code === "string" ? error.code : "unknown_error";
    throw new Error(`helm_http_${response.status}_${code}`);
  }
  if (body === null) throw new Error("helm_response_not_json_object");
  return body;
}

async function readableUrl(url: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch {
    return false;
  }
  if (!response.ok || response.body === null) return false;
  const reader = response.body.getReader();
  try {
    const first = await reader.read();
    return !first.done && (first.value?.byteLength ?? 0) > 0;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function imageResultIsReadable(body: JsonObject): Promise<boolean> {
  if (!Array.isArray(body.data)) return false;
  for (const value of body.data) {
    const item = object(value);
    const inline = typeof item?.b64_json === "string" ? item.b64_json.trim() : "";
    if (inline && Buffer.from(inline, "base64").byteLength > 0) return true;
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    if (url && (await readableUrl(url))) return true;
  }
  return false;
}

const authHeaders = () => ({
  Authorization: `Bearer ${requiredApiKey()}`,
  "Content-Type": "application/json",
});

describe.skipIf(!liveEnabled)("live Grok Imagine through local Helm", () => {
  test("generates one readable image with exactly one create", async () => {
    const body = await helmJson("/v1/images/generations", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "grok-imagine-image",
        prompt:
          process.env.HELM_LIVE_IMAGE_PROMPT ??
          "A small blue paper boat on calm water, clean composition, no text",
      }),
    });

    if (!(await imageResultIsReadable(body))) throw new Error("image_result_not_readable");
    console.info("live image: ok (one create, readable result)");
  });

  test(
    "generates one prompt-only video and polls its original receipt to done",
    async () => {
      const start = await helmJson("/v1/videos/generations", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "grok-imagine-video",
          prompt:
            process.env.HELM_LIVE_VIDEO_PROMPT ??
            "A small blue paper boat glides slowly across calm water, no text",
        }),
      });
      const requestId = typeof start.request_id === "string" ? start.request_id.trim() : "";
      if (!requestId) throw new Error("video_receipt_missing");
      console.info("live video: accepted (one create, receipt present)");

      const intervalMs = positiveInteger("HELM_VIDEO_POLL_INTERVAL_MS", 10_000, 60_000);
      const deadlineMs =
        Date.now() + positiveInteger("HELM_VIDEO_POLL_TIMEOUT_MS", 15 * 60_000, 30 * 60_000);
      let polls = 0;
      let consecutiveErrors = 0;

      while (Date.now() < deadlineMs) {
        polls += 1;
        try {
          const body = await helmJson(`/v1/videos/${encodeURIComponent(requestId)}`, {
            method: "GET",
            headers: authHeaders(),
          });
          consecutiveErrors = 0;
          const status = typeof body.status === "string" ? body.status : "unknown";
          if (status === "done") {
            const video = object(body.video);
            const url = typeof video?.url === "string" ? video.url.trim() : "";
            if (!url || !(await readableUrl(url))) throw new Error("video_result_not_readable");
            console.info(`live video: ok (${polls} read-only polls, readable result)`);
            return;
          }
          if (status === "failed" || status === "expired") {
            throw new Error(`video_terminal_${status}`);
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("video_terminal_")) throw error;
          if (error instanceof Error && error.message === "video_result_not_readable") throw error;
          consecutiveErrors += 1;
          if (consecutiveErrors >= 3) throw new Error("video_poll_failed_three_times");
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      throw new Error("video_poll_timeout");
    },
    20 * 60_000,
  );
});
