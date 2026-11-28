import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { ConfigStore, DecisionRecord } from "@helm/core";
import {
  hashKey,
  ResponseWorkCapacityError,
  rehydrateImages,
  runtimeResponseWorkAdmission,
} from "@helm/core";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import { requestSignal } from "../../middleware/limits.js";
import { getSessionRequest } from "../admin/requests.js";
import type { PortalApiDeps } from "./index.js";
import { portalReplayKey } from "./replay-context.js";

export interface PortalReplayWiring {
  configStore: ConfigStore;
  afterResponse: () => Promise<void>;
}

const ReceiptSchema = z.object({
  started_at_ms: z.number().int().nonnegative(),
  http_status: z.union([z.literal(200), z.literal(202), z.literal(409), z.literal(503)]),
  body: z.object({
    status: z.enum(["in_progress", "recorded", "recording_pending", "rejected", "outcome_unknown"]),
    source_request_id: z.string(),
    request_id: z.string().nullable(),
    upstream_status: z.number().int().nullable(),
    code: z.string().optional(),
  }),
});
type Receipt = z.infer<typeof ReceiptSchema>;
const IdempotencyKeySchema = z.string().uuid();
const RECEIPT_TTL_MS = 7 * 86400_000;
const REPLAY_INTERVAL_MS = 10_000;
const REPLAY_MAX_MS = 10 * 60_000;

function replayPath(record: DecisionRecord): string | null {
  switch (record.protocol) {
    case "openai_chat":
      return "/v1/chat/completions";
    case "anthropic_messages":
      return "/v1/messages";
    case "openai_responses":
      return record.policy.reason === "responses_compact" ||
        record.lane.selected_lane === "responses_compact"
        ? "/v1/responses/compact"
        : "/v1/responses";
    case "gemini":
      return `/v1beta/models/${encodeURIComponent(record.requested_model)}:${record.stream_outcome ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    default:
      return null;
  }
}

// Recover only the original client body, never the forwarded provider body. A
// forged/historical detached-image sentinel cannot turn replay into a blob reader.
async function loadBody(deps: PortalApiDeps, requestId: string, keyId: string) {
  const admission = deps.responseWorkAdmission ?? runtimeResponseWorkAdmission();
  const maxBytes = Math.min(8 * 1024 * 1024, Math.floor(admission.capacityBytes / 16));
  let json: string;
  let release: () => void;
  const meta = await deps.telemetry.getPayloadMeta?.(requestId);
  if (meta?.parts.request) {
    const acquired = admission.acquire(maxBytes);
    if (!acquired.ok) throw new ResponseWorkCapacityError(admission.capacityBytes);
    release = acquired.lease.release;
    try {
      const encoded = await deps.telemetry.getPayloadPartEncoded?.(requestId, "request", maxBytes);
      if (!encoded) {
        release();
        return null;
      }
      const bytes =
        encoded.codec === "gzip"
          ? gunzipSync(encoded.bytes, { maxOutputLength: maxBytes })
          : encoded.bytes;
      if (bytes.byteLength > maxBytes) {
        release();
        return null;
      }
      json = Buffer.from(bytes).toString("utf8");
    } catch (error) {
      release();
      throw error;
    }
  } else {
    const recovered = await getSessionRequest(
      {
        telemetry: deps.telemetry,
        responseWorkAdmission: {
          get capacityBytes() {
            return admission.capacityBytes;
          },
          get reservedBytes() {
            return admission.reservedBytes;
          },
          acquire(bytes) {
            const result = admission.acquire(bytes);
            if (!result.ok) throw new ResponseWorkCapacityError(admission.capacityBytes);
            return result;
          },
        },
        authorizeSession: async (_id, ref) =>
          (await deps.telemetry.getSessionByRef?.(ref))?.apiKeyId === keyId,
      },
      requestId,
    );
    if (recovered.status !== "recovered") return null;
    json = recovered.requestJson;
    release = recovered.release;
  }
  try {
    if (Buffer.byteLength(json) > maxBytes) {
      release();
      return null;
    }
    const references = new Map<string, number>();
    rehydrateImages(json, (sha) => {
      references.set(sha, (references.get(sha) ?? 0) + 1);
      return null;
    });
    const images = new Map<string, Uint8Array>();
    let expandedBytes = Buffer.byteLength(json);
    for (const [sha, occurrences] of references) {
      if (!(await deps.telemetry.hasPayloadBlobReference?.(requestId, sha))) {
        release();
        return null;
      }
      const blob = await deps.telemetry.getPayloadBlob?.(
        sha,
        Math.max(0, Math.floor((((maxBytes - expandedBytes) / occurrences) * 3) / 4)),
      );
      if (!blob) {
        release();
        return null;
      }
      expandedBytes += Math.ceil(blob.bytes.byteLength / 3) * 4 * occurrences;
      if (expandedBytes > maxBytes) {
        release();
        return null;
      }
      images.set(sha, blob.bytes);
    }
    json = rehydrateImages(json, (sha) => images.get(sha) ?? null);
    // Also bound repeated references to one image, not just distinct blobs.
    if (Buffer.byteLength(json) > maxBytes) {
      release();
      return null;
    }
    const body: unknown = JSON.parse(json);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      release();
      return null;
    }
    return { json, release };
  } catch (error) {
    release();
    throw error;
  }
}

export function registerPortalReplayRoute(app: Hono<AppEnv>, deps: PortalApiDeps): void {
  app.post("/portal/api/requests/:traceId/replay", async (c) => {
    const keyId = c.get("identity").keyId;
    const sourceId = c.req.param("traceId");
    const token = IdempotencyKeySchema.safeParse(c.req.header("idempotency-key"));
    if (!token.success)
      return c.json(
        { error: "a UUID Idempotency-Key is required", code: "idempotency_key_required" },
        400,
      );
    const wiring = deps.replay;
    const config = wiring?.configStore;
    if (
      !wiring ||
      !config?.compareAndSet ||
      !config.setIfMissingOrNumericLte ||
      !config.deleteIfValue ||
      !config.pruneExpired
    )
      return c.json({ error: "replay unavailable", code: "replay_unavailable" }, 503);

    // getById is deliberately uncached. Detect rotation/revocation even if the
    // outer portal authentication just accepted a cached credential.
    const authorization = c.req.header("authorization");
    const plaintext = authorization
      ? /^Bearer\s+(.+)$/.exec(authorization)?.[1]
      : c.req.header("x-api-key");
    const fresh = await deps.keyStore.getById?.(keyId);
    if (
      !fresh ||
      fresh.disabled ||
      fresh.suspended ||
      !plaintext ||
      fresh.hash !== hashKey(plaintext)
    )
      return c.json({ error: "missing or invalid API key", code: "auth_error" }, 401);

    const receiptKey = `portal.replay.receipt.${createHash("sha256")
      .update(JSON.stringify([keyId, token.data]))
      .digest("hex")}`;
    const readReceipt = async () => {
      const value = await config.get(receiptKey);
      if (value === null) return null;
      const receipt = ReceiptSchema.parse(JSON.parse(value));
      if (
        (deps.now ?? Date.now)() >= receipt.started_at_ms + RECEIPT_TTL_MS &&
        (await config.deleteIfValue!(receiptKey, value))
      )
        return null;
      return receipt;
    };
    const sendReceipt = (receipt: Receipt) => {
      if (
        receipt.body.status === "in_progress" &&
        (deps.now ?? Date.now)() - receipt.started_at_ms >= REPLAY_MAX_MS
      )
        return c.json(
          { ...receipt.body, status: "outcome_unknown", code: "replay_outcome_unknown" },
          503,
        );
      return c.json(receipt.body, receipt.http_status);
    };
    await config.pruneExpired((deps.now ?? Date.now)());
    const previous = await readReceipt();
    if (previous) {
      if (previous.body.source_request_id !== sourceId)
        return c.json(
          {
            error: "Idempotency-Key already used for another request",
            code: "idempotency_conflict",
          },
          409,
        );
      return sendReceipt(previous);
    }
    const record = await deps.telemetry.getByRequestId(sourceId);
    const path = record && replayPath(record);
    if (!record || record.request_content_mode === "none" || !path)
      return c.json(
        { error: "original request cannot be replayed", code: "replay_payload_unavailable" },
        409,
      );
    const now = (deps.now ?? Date.now)();
    if (
      !(await config.setIfMissingOrNumericLte(
        `portal.replay.rate.${keyId}`,
        String(now + REPLAY_INTERVAL_MS),
        now,
        now + REPLAY_INTERVAL_MS,
      ))
    ) {
      // A simultaneous retry may lose the throttle race while the first caller
      // is claiming its receipt. Re-read before reporting a fresh rate rejection.
      const concurrent = await readReceipt();
      if (concurrent?.body.source_request_id === sourceId) return sendReceipt(concurrent);
      c.header("retry-after", "10");
      return c.json({ error: "replay rate limit exceeded", code: "replay_rate_limited" }, 429);
    }
    const started: Receipt = {
      started_at_ms: now,
      http_status: 202,
      body: {
        status: "in_progress",
        source_request_id: sourceId,
        request_id: null,
        upstream_status: null,
      },
    };
    const initial = JSON.stringify(started);
    if (!(await config.compareAndSet(receiptKey, null, initial, now + RECEIPT_TTL_MS))) {
      const winner = await readReceipt();
      if (!winner || winner.body.source_request_id !== sourceId)
        return c.json({ error: "replay conflict", code: "idempotency_conflict" }, 409);
      return sendReceipt(winner);
    }
    const finish = async (receipt: Omit<Receipt, "started_at_ms">) => {
      if (
        !(await config.compareAndSet!(
          receiptKey,
          initial,
          JSON.stringify({ ...receipt, started_at_ms: now }),
          now + RECEIPT_TTL_MS,
        ))
      )
        throw new Error("replay receipt changed unexpectedly");
      return c.json(receipt.body, receipt.http_status);
    };
    let loaded: Awaited<ReturnType<typeof loadBody>> = null;
    let dispatched = false;
    let requestId: string | null = null;
    let upstreamStatus: number | null = null;
    try {
      loaded = await loadBody(deps, sourceId, keyId);
      if (!loaded)
        return await finish({
          http_status: 409,
          body: { ...started.body, status: "rejected", code: "replay_payload_unavailable" },
        });
      const headers = new Headers({
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(loaded.json)),
      });
      // Authentication and client policy are evaluated again on the normal route.
      // Nothing from captured upstream headers or any other key is forwarded.
      for (const name of [
        "authorization",
        "x-api-key",
        "user-agent",
        "anthropic-version",
        "anthropic-beta",
      ]) {
        const value = c.req.header(name);
        if (value) headers.set(name, value);
      }
      const request = new Request(new URL(path, c.req.url), {
        method: "POST",
        headers,
        body: loaded.json,
        signal: AbortSignal.any([requestSignal(c), AbortSignal.timeout(REPLAY_MAX_MS)]),
      });
      dispatched = true;
      await portalReplayKey.run(keyId, async () => {
        const response = await app.fetch(request);
        requestId = response.headers.get("x-helm-request-id");
        upstreamStatus = response.status;
        const reader = response.body?.getReader();
        if (reader) {
          try {
            while (!(await reader.read()).done) {
              /* drain; normal pipeline captures and settles */
            }
          } catch (error) {
            await reader.cancel().catch(() => {});
            throw error;
          } finally {
            reader.releaseLock();
          }
        }
        await wiring.afterResponse();
      });
      const owner = requestId ? await deps.telemetry.getApiKeyId(requestId) : null;
      if (owner && owner !== keyId) throw new Error("replay attribution mismatch");
      const rejected = (upstreamStatus ?? 500) >= 400;
      return await finish({
        http_status: owner === keyId ? 200 : rejected ? 409 : 202,
        body: {
          ...started.body,
          status: owner === keyId ? "recorded" : rejected ? "rejected" : "recording_pending",
          request_id: requestId,
          upstream_status: upstreamStatus,
          ...(rejected && owner !== keyId ? { code: "client_request_rejected" } : {}),
        },
      });
    } catch (error) {
      if (!dispatched && error instanceof ResponseWorkCapacityError) {
        // No client request was dispatched. Delete only our exact reservation,
        // leaving any concurrent successor intact. Retry may reuse this token.
        await config.deleteIfValue(receiptKey, initial);
        await config.deleteIfValue(`portal.replay.rate.${keyId}`, String(now + REPLAY_INTERVAL_MS));
        c.header("retry-after", "1");
        return c.json({ error: "response capacity unavailable", code: "response_capacity" }, 503);
      }
      return await finish({
        http_status: dispatched ? 503 : 409,
        body: {
          ...started.body,
          status: dispatched ? "outcome_unknown" : "rejected",
          request_id: requestId,
          upstream_status: upstreamStatus,
          code: dispatched ? "replay_outcome_unknown" : "replay_payload_unavailable",
        },
      });
    } finally {
      loaded?.release();
    }
  });
}
