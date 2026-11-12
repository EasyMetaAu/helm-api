import { describe, expect, it, vi } from "vitest";
import { createAudioTranscriptionClient } from "./audio-transcription.js";

const file = new File([new Uint8Array([1, 2])], "sample.wav", { type: "audio/wav" });
describe("audio transcription protocols", () => {
  it("uses current OpenAI multipart fields and preserves native duration", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        text: "Hello",
        languages: [{ code: "en" }],
        usage: { type: "duration", seconds: 2 },
      }),
    );
    const result = await createAudioTranscriptionClient("openai", {
      config: { baseUrl: "https://api.openai.com/v1", apiKey: "test" },
      fetch,
    }).transcribe({ model: "gpt-transcribe", languages: ["en"], keywords: ["Luma"] }, file);
    expect(result).toMatchObject({
      text: "Hello",
      languages: [{ code: "en" }],
      usage: { type: "duration", seconds: 2 },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/audio/transcriptions");
    const body = fetch.mock.calls[0]?.[1].body as FormData;
    expect(body.get("file")).toBeInstanceOf(File);
    expect(body.getAll("languages[]")).toEqual(["en"]);
    expect(body.has("language")).toBe(false);
  });
  it("rejects unsupported OpenAI timestamps before network", async () => {
    const fetch = vi.fn();
    await expect(
      createAudioTranscriptionClient("openai", {
        config: { baseUrl: "https://example.test" },
        fetch,
      }).transcribe({ model: "gpt-transcribe", timestamps: "word" }, file),
    ).rejects.toThrow("timestamps");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("maps Deepgram seconds, diarization and native duration without fabricating missing words", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        metadata: { request_id: "req", duration: 2, channels: 1 },
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: "Hello",
                  words: [{ word: "Hello", start: 0.2, end: 0.7, speaker: 1, confidence: 0.9 }],
                },
              ],
            },
          ],
        },
      }),
    );
    const result = await createAudioTranscriptionClient("deepgram", {
      config: { baseUrl: "https://api.deepgram.com/v1", apiKey: "test" },
      fetch,
    }).transcribe({ model: "nova-3", timestamps: "word", diarize: true }, file);
    expect(result).toMatchObject({
      text: "Hello",
      requestId: "req",
      words: [{ text: "Hello", startMs: 200, endMs: 700, speaker: 1 }],
      usage: { type: "duration", seconds: 2, channels: 1 },
    });
    expect(fetch.mock.calls[0]?.[1].headers.Authorization).toBe("Token test");
    expect(String(fetch.mock.calls[0]?.[0])).toContain("diarize_model=v2");
  });
  it("never retries an uncertain paid submission", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("connection closed"));
    await expect(
      createAudioTranscriptionClient("deepgram", {
        config: { baseUrl: "https://example.test" },
        fetch,
      }).transcribe({ model: "nova-3" }, file),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
