import { AudioTranscriptionResultSchema } from "@helm/shared";
import { z } from "zod";
import { MediaHttpError, parseMediaInput } from "./media-http.js";
import {
  type OpenAIClientDeps,
  type ProviderCallOptions,
  readUpstreamJsonWithinBudget,
} from "./openai.js";
export const DoubaoAsrRequestSchema = z.strictObject({
  model: z.literal("bigmodel"),
  audio: z.strictObject({
    url: z.url().refine((url) => url.startsWith("https://")),
    format: z.enum(["raw", "wav", "mp3", "ogg", "m4a", "aac", "flac", "mp4"]),
    language: z.string().min(2).max(20).optional(),
  }),
  request: z
    .strictObject({
      enable_punc: z.boolean().optional(),
      enable_itn: z.boolean().optional(),
    })
    .optional(),
});
const Timed = z.object({
  text: z.string(),
  start_time: z.number().nonnegative(),
  end_time: z.number().nonnegative(),
});
const AudioInfo = z.object({ duration: z.number().finite().nonnegative() });
const Result = z.object({
  text: z.string(),
  utterances: z.array(Timed.extend({ words: z.array(Timed).optional() })).optional(),
});
export const validateDoubaoTranscription = (body: Record<string, unknown>, model: string) =>
  DoubaoAsrRequestSchema.parse({ ...body, model });
export function normalizeDoubaoTranscription(raw: Record<string, unknown>, id: string) {
  if (raw.id !== id) return null;
  if (raw.code === 20000001 || raw.code === 20000002)
    return { status: raw.code === 20000001 ? "in_progress" : "queued" };
  if (raw.code === 20000003)
    return { status: "failed", error: { code: "no_speech", message: "no human speech detected" } };
  if (raw.code !== 20000000) return null;
  const result = Result.safeParse(raw.result);
  const audioInfo = AudioInfo.optional().safeParse(raw.audio_info);
  if (!result.success || !audioInfo.success) return null;
  const durationMs = audioInfo.data?.duration;
  const usage =
    durationMs === undefined
      ? undefined
      : { type: "duration" as const, seconds: durationMs / 1000 };
  return {
    status: "done",
    ...(usage ? { usage } : {}),
    transcription: AudioTranscriptionResultSchema.parse({
      text: result.data.text,
      ...(durationMs === undefined ? {} : { durationMs, usage }),
      ...(result.data.utterances
        ? {
            segments: result.data.utterances.map((segment) => ({
              text: segment.text,
              startMs: segment.start_time,
              endMs: segment.end_time,
              words: segment.words?.map((word) => ({
                text: word.text,
                startMs: word.start_time,
                endMs: word.end_time,
              })),
            })),
          }
        : {}),
      requestId: id,
    }),
  };
}
export function createDoubaoAsrClient(deps: OpenAIClientDeps) {
  async function call(
    path: "submit" | "query",
    id: string,
    body: Record<string, unknown>,
    opts?: ProviderCallOptions,
  ) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(deps.config.timeoutMs ?? 60000),
      ...(opts?.signal ? [opts.signal] : []),
    ]);
    if (signal.aborted)
      throw new MediaHttpError("not_sent", "upstream_error", "request canceled before dispatch");
    let response: Response;
    try {
      response = await (deps.fetch ?? globalThis.fetch)(
        `${deps.config.baseUrl.replace(/\/$/, "")}/api/v3/auc/bigmodel/${path}`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": deps.config.apiKey ?? "",
            "X-Api-Resource-Id": "volc.seedasr.auc",
            "X-Api-Request-Id": id,
            ...(path === "submit" ? { "X-Api-Sequence": "-1" } : {}),
          },
          body: JSON.stringify(body),
          signal,
        },
      );
    } catch {
      throw new MediaHttpError("unknown", "upstream_error", "ASR outcome unknown");
    }
    const code = Number(response.headers.get("X-Api-Status-Code"));
    if (!response.ok || ![20000000, 20000001, 20000002, 20000003].includes(code)) {
      await response.body?.cancel();
      const rejected = [45000002, 45000131, 45000132, 45000151].includes(code);
      throw new MediaHttpError(
        rejected ? "rejected" : "unknown",
        "upstream_error",
        "ASR upstream status requires reconciliation",
        null,
        response.status,
      );
    }
    if (path === "submit") {
      await response.body?.cancel();
      if (code !== 20000000)
        throw new MediaHttpError("unknown", "upstream_error", "ASR submission not confirmed");
      return { id, code };
    }
    if (code !== 20000000) {
      await response.body?.cancel();
      return { id, code };
    }
    const raw = await readUpstreamJsonWithinBudget(response, deps.responseWorkAdmission);
    const parsed = z.object({ result: Result, audio_info: AudioInfo.optional() }).parse(raw);
    return {
      id,
      code,
      result: parsed.result,
      ...(parsed.audio_info ? { audio_info: parsed.audio_info } : {}),
    };
  }
  return {
    async transcriptionCreate(
      raw: Record<string, unknown>,
      opts?: ProviderCallOptions,
    ): Promise<Record<string, unknown>> {
      const req = parseMediaInput(() => DoubaoAsrRequestSchema.parse(raw));
      const id = parseMediaInput(() => z.uuid().parse(opts?.providerRequestId));
      return call(
        "submit",
        id,
        {
          audio: req.audio,
          request: { ...req.request, model_name: req.model, show_utterances: true },
        },
        opts,
      );
    },
    async transcriptionRetrieve(
      id: string,
      opts?: ProviderCallOptions,
    ): Promise<Record<string, unknown>> {
      return call(
        "query",
        parseMediaInput(() => z.uuid().parse(id)),
        {},
        opts,
      );
    },
  };
}
