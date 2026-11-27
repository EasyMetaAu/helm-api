import {
  type AudioTranscriptionClient,
  AudioTranscriptionError,
  consumeResponseBytesWithinBudget,
  createBlockedModelMatcher,
  ResponseBodyTooLargeError,
  SpeechAccountingError,
  SpeechParameterError,
  type TranscriptionAccounting,
  transcriptionOperationIdPattern,
  transcriptionOperationStoreId,
} from "@helm/core";
import type { AttemptErrorDetail } from "@helm/shared";
import {
  AudioTranscriptionRequestSchema,
  evaluateClientPolicy,
  type MediaPricing,
  type MediaSpendRecord,
} from "@helm/shared";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";
import type { ConcurrencyGatePort } from "../middleware/concurrency.js";
import { requestSignal } from "../middleware/limits.js";
import {
  type AudioSpeechRouteDeps,
  acquireSpeechLease,
  admitSpeechIdentity,
  checkSpeechBudget,
  SpeechAdmissionError,
} from "./audio-speech.js";
import { errorDetailOf } from "./execute.js";
import type { MessagesIdentity } from "./messages.js";
import type {
  TranscriptionResultSelection,
  TranscriptionResultStore,
} from "./transcription-results.js";
export interface TranscriptionSelection {
  pricing?: MediaPricing;
  client: AudioTranscriptionClient;
  model: string;
  alias: string;
  lane: string;
  customModel: boolean;
  capacity?: { key: string; limit: number };
}
export interface AudioTranscriptionsRouteDeps
  extends Omit<AudioSpeechRouteDeps, "resolve" | "record" | "accounting"> {
  accounting?: Pick<TranscriptionAccounting, "reserve" | "settle" | "get" | "release">;
  results?: TranscriptionResultStore;
  capacityGate?: ConcurrencyGatePort;
  resolve(
    model: string,
    identity: MessagesIdentity,
  ): TranscriptionSelection | null | Promise<TranscriptionSelection | null>;
  record?: (input: {
    identity: MessagesIdentity;
    selection: TranscriptionSelection;
    traceId: string;
    status: "completed" | "error";
    result?: Awaited<ReturnType<AudioTranscriptionClient["transcribe"]>>;
    errorCode?: string;
    costUsd?: number | null;
    errorDetail?: AttemptErrorDetail;
    operationId?: string;
  }) => Promise<void>;
}
function requireTranscriptionAccess(
  selection: TranscriptionResultSelection,
  identity: MessagesIdentity,
): void {
  const blocked = createBlockedModelMatcher(identity.caps?.blockedModels);
  if (
    [selection.requestedModel, selection.alias, selection.model, selection.lane].some((value) =>
      blocked?.matches(value),
    ) ||
    (selection.customModel && identity.caps?.allowCustomModel !== true)
  )
    throw new SpeechAdmissionError(403, "model_not_allowed", "transcription model is not allowed");
  if (identity.caps?.allowedLanes && !identity.caps.allowedLanes.includes(selection.lane))
    throw new SpeechAdmissionError(403, "lane_not_allowed", "transcription lane is not allowed");
}

export function registerAudioTranscriptionsRoute(
  app: Hono<AppEnv>,
  deps: AudioTranscriptionsRouteDeps,
): void {
  app.get("/v1/audio/transcriptions/operations/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const identity = await deps.auth.resolve(
      /^Bearer\s+(.+)$/.exec(c.req.header("Authorization") ?? "")?.[1] ?? null,
    );
    if (!identity) return c.json({ error: { code: "invalid_api_key" } }, 401);
    if (!evaluateClientPolicy(identity.caps?.clientPolicy, c.req.header("user-agent")).allowed)
      return c.json({ error: { code: "client_not_allowed" } }, 403);
    const id = c.req.param("id");
    if (!transcriptionOperationIdPattern.test(id))
      return c.json({ error: { code: "invalid_request" } }, 400);
    if (!deps.results) return c.json({ error: { code: "result_storage_unavailable" } }, 503);
    if (deps.rateLimiter) {
      const limit = await deps.rateLimiter.check({
        keyId: identity.keyId,
        estimatedTokens: 0,
        now: Date.now(),
        override: identity.caps?.rateLimit,
      });
      if (!limit.allowed) return c.json({ error: { code: "rate_limit_exceeded" } }, 429);
    }
    try {
      const data = await deps.results.get(id, identity);
      if (!data) return c.json({ error: { code: "result_not_found" } }, 404);
      requireTranscriptionAccess(data.selection, identity);
      return c.json({ operationId: id, result: data.result }, 200);
    } catch (error) {
      if (error instanceof SpeechAdmissionError)
        return c.json({ error: { code: error.code } }, error.status);
      return c.json({ error: { code: "result_storage_unavailable" } }, 503);
    }
  });
  app.post("/v1/audio/transcriptions", async (c) => {
    let lease: Awaited<ReturnType<typeof acquireSpeechLease>> | undefined;
    let capacity: { signal?: AbortSignal; release: () => void | Promise<void> } | undefined;
    // Admission uses only auth/budget/rate/concurrency; resolution is specific to this media kind.
    const admission = deps;
    let spend: MediaSpendRecord | undefined;
    let callerOperationId: string | undefined;
    try {
      const identity = await admitSpeechIdentity(
        admission,
        /^Bearer\s+(.+)$/.exec(c.req.header("Authorization") ?? "")?.[1] ?? null,
        c.req.header("user-agent") ?? null,
        !!deps.accounting,
        { deferBudget: true },
      );
      const accounting = deps.accounting;
      callerOperationId = c.req.header("X-Helm-Transcription-Operation");
      if (callerOperationId !== undefined) {
        if (!transcriptionOperationIdPattern.test(callerOperationId))
          throw new SpeechAdmissionError(
            400,
            "invalid_request",
            "invalid transcription operation ID",
          );
        if (!accounting) throw new SpeechAccountingError("media_accounting_unavailable");
        if (!deps.results)
          throw new SpeechAdmissionError(
            503,
            "result_storage_unavailable",
            "durable transcription storage is unavailable",
          );
        const existing = await accounting.get(
          transcriptionOperationStoreId(callerOperationId, identity.keyId),
          identity.keyId,
        );
        if (existing) {
          spend = existing;
          throw new SpeechAdmissionError(
            409,
            "operation_exists",
            "transcription operation already exists",
          );
        }
      }
      const contentType = c.req.header("content-type") ?? "";
      if (!contentType.startsWith("multipart/form-data;"))
        throw new SpeechAdmissionError(400, "invalid_request", "multipart/form-data is required");
      // Recoverable requests keep running after transport loss. They still
      // hold the original concurrency lease and honor both server deadlines.
      const deadline = AbortSignal.timeout(120000);
      const cancellation =
        callerOperationId && deps.results
          ? c.get("request_timeout")?.deadlineSignal
          : requestSignal(c);
      lease = await acquireSpeechLease(
        admission,
        identity,
        cancellation ? AbortSignal.any([cancellation, deadline]) : deadline,
      );
      const bytes = await consumeResponseBytesWithinBudget(
        new Response(c.req.raw.body, { headers: c.req.raw.headers }),
        26 * 1024 * 1024,
      );
      let form: FormData;
      try {
        form = await new Response(bytes as Uint8Array<ArrayBuffer>, {
          headers: { "Content-Type": contentType },
        }).formData();
      } catch {
        throw new SpeechAdmissionError(400, "invalid_request", "invalid multipart body");
      }
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0 || file.size > 25 * 1024 * 1024)
        throw new SpeechAdmissionError(400, "invalid_request", "file must contain 1 to 25 MiB");
      const raw: Record<string, unknown> = {};
      for (const [key, value] of form) {
        if (key === "file") continue;
        if (key === "languages[]" || key === "keywords[]") raw[key.slice(0, -2)] = form.getAll(key);
        else if (key in raw)
          throw new SpeechAdmissionError(400, "invalid_request", "duplicate field");
        else
          raw[key] =
            key === "diarize"
              ? value === "true"
                ? true
                : value === "false"
                  ? false
                  : value
              : value;
      }
      const parsed = AudioTranscriptionRequestSchema.safeParse(raw);
      if (!parsed.success)
        throw new SpeechAdmissionError(400, "invalid_request", "invalid transcription parameters");
      const req = parsed.data;
      const blocked = createBlockedModelMatcher(identity.caps?.blockedModels);
      if (blocked?.matches(req.model))
        throw new SpeechAdmissionError(403, "model_not_allowed", "transcription model is blocked");
      const selection = await deps.resolve(req.model, identity);
      if (!selection)
        throw new SpeechAdmissionError(
          503,
          "provider_unavailable",
          "transcription lane is unavailable",
        );
      const resultSelection = {
        requestedModel: req.model,
        alias: selection.alias,
        model: selection.model,
        lane: selection.lane,
        customModel: selection.customModel,
      };
      requireTranscriptionAccess(resultSelection, identity);
      if (selection.capacity) {
        const acquired = await deps.capacityGate?.acquire({
          keyId: selection.capacity.key,
          limit: selection.capacity.limit,
          signal: lease.signal,
        });
        if (!acquired || (!acquired.ok && acquired.reason === "unavailable"))
          throw new SpeechAdmissionError(
            503,
            "transcription_capacity_unavailable",
            "transcription capacity is unavailable",
          );
        if (!acquired.ok) {
          if (acquired.reason === "aborted")
            throw new SpeechAdmissionError(
              499 as ContentfulStatusCode,
              "request_canceled",
              "transcription request canceled",
            );
          c.header("Retry-After", String(acquired.retryAfterSeconds));
          throw new SpeechAdmissionError(
            429,
            "transcription_capacity_exhausted",
            "transcription capacity is exhausted",
          );
        }
        capacity = acquired;
      }
      const providerSignal = capacity?.signal
        ? AbortSignal.any([lease.signal, capacity.signal])
        : lease.signal;

      // Weekly budget checks reserve a request. Do that only after the
      // gateway capacity check. Requests admitted here still count if the shared
      // worker later refuses them, matching weekly failed-attempt accounting.
      await checkSpeechBudget(admission, identity);
      const traceId = c.get("trace_id") ?? crypto.randomUUID();
      if (accounting) {
        const id = callerOperationId
          ? transcriptionOperationStoreId(callerOperationId, identity.keyId)
          : crypto.randomUUID();
        const rejectReplay = async () => {
          if (!callerOperationId) return;
          const existing = await accounting.get(id, identity.keyId);
          if (existing) {
            spend = existing;
            throw new SpeechAdmissionError(
              409,
              "operation_exists",
              "transcription operation already exists",
            );
          }
        };
        await rejectReplay();
        try {
          spend = await accounting.reserve({
            id,
            keyId: identity.keyId,
            alias: selection.alias,
            model: selection.model,
            pricing: selection.pricing,
            caps: identity.caps?.budget,
            file,
            request: req,
          });
        } catch (error) {
          // The unique ledger ID prevents a second reservation and rolls back
          // its debit, even if both requests passed the initial read.
          await rejectReplay();
          throw error;
        }
      }
      let result: Awaited<ReturnType<AudioTranscriptionClient["transcribe"]>> | undefined;
      let errorDetail: AttemptErrorDetail | undefined;
      let errorCode: string | undefined;
      let releaseUncertain = false;
      try {
        result = await selection.client.transcribe({ ...req, model: selection.model }, file, {
          signal: providerSignal,
        });
        if (callerOperationId && deps.results) {
          try {
            await deps.results.save(callerOperationId, identity, resultSelection, result);
          } catch {
            // The provider already ran. Preserve its usage in the ledger, but
            // never treat a failed durable write as a safe second submission.
            throw new AudioTranscriptionError("outcome_unknown");
          }
        }
        // Finalize below before returning accounting metadata.
      } catch (error) {
        errorDetail = errorDetailOf(error);
        if (
          error instanceof AudioTranscriptionError &&
          error.code === "transcription_capacity_exhausted"
        ) {
          if (spend) {
            try {
              if (!accounting?.release) throw new Error("reservation release unavailable");
              await accounting.release(spend);
              spend = undefined;
            } catch {
              // A lost commit reply can mean a subsequent caller already
              // reserved the same ID. Never settle that newer reservation.
              releaseUncertain = true;
              errorCode = "outcome_unknown";
              throw new AudioTranscriptionError("outcome_unknown");
            }
          }
          c.header("Retry-After", String(error.retryAfter ?? 5));
        }
        errorCode =
          error instanceof SpeechParameterError
            ? "not_sent"
            : error instanceof AudioTranscriptionError
              ? error.code
              : "outcome_unknown";
        throw error;
      } finally {
        try {
          if (spend && deps.accounting && !releaseUncertain)
            spend =
              (await deps.accounting.settle(
                spend,
                selection.pricing,
                result,
                errorCode === "not_sent" ||
                  errorCode === "provider_unavailable" ||
                  errorCode === "upstream_rejected",
              )) ?? spend;
          if (identity.caps?.budget && deps.settleBudget)
            await deps.settleBudget(
              identity.keyId,
              spend ? { ...identity.caps.budget, spendUsd: null } : identity.caps.budget,
              {
                requests: 1,
                tokens: result?.usage?.type === "tokens" ? result.usage.total_tokens : 0,
                costUsd: null,
              },
              Date.now(),
            );
          await deps.record?.({
            identity,
            selection,
            traceId,
            status: result ? "completed" : "error",
            result,
            errorCode,
            errorDetail,
            costUsd: spend?.costUsd,
            operationId: spend ? (callerOperationId ?? spend.id) : undefined,
          });
        } catch {
          c.get("logger")?.log("error", "media.transcription_accounting_failed", {
            trace_id: traceId,
          });
        }
      }
      return c.json(
        {
          ...result,
          ...(spend
            ? {
                accounting: {
                  operationId: callerOperationId ?? spend.id,
                  state: spend.state,
                  costUsd: spend.costUsd,
                  reservedUsd: spend.reservedUsd,
                  costBasis: "list_price",
                },
              }
            : {}),
        },
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      if (error instanceof SpeechAccountingError)
        return c.json(
          { error: { code: error.code } },
          error.code === "budget_exceeded"
            ? 429
            : error.code === "media_pricing_unavailable"
              ? 422
              : 503,
        );
      const status =
        error instanceof SpeechAdmissionError
          ? error.status
          : error instanceof SpeechParameterError
            ? 422
            : error instanceof ResponseBodyTooLargeError
              ? 413
              : error instanceof AudioTranscriptionError &&
                  error.status >= 400 &&
                  (error.status < 500 || error.code === "provider_unavailable")
                ? error.status
                : 502;
      const code =
        error instanceof SpeechAdmissionError
          ? error.code
          : error instanceof SpeechParameterError
            ? "unsupported_parameter"
            : error instanceof ResponseBodyTooLargeError
              ? "request_too_large"
              : error instanceof AudioTranscriptionError
                ? error.code
                : spend
                  ? "outcome_unknown"
                  : "upstream_error";
      return c.json(
        {
          error: {
            code,
            ...(spend ? { operation_id: callerOperationId ?? spend.id } : {}),
            message: code,
            type: status < 500 ? "invalid_request_error" : "upstream_error",
          },
        },
        status as ContentfulStatusCode,
      );
    } finally {
      try {
        await capacity?.release();
      } finally {
        await lease?.release();
      }
    }
  });
}
