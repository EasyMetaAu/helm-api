import { describe, expect, it, vi } from "vitest";
import { createWhisperXClient } from "./whisperx.js";

const file = new File(["wav"], "a.wav", { type: "audio/wav" });
describe("standalone WhisperX adapter", () => {
  it("uses the verified sync protocol and preserves only actual word timing", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        status: "success",
        file_id: "provider-file",
        result: {
          language: "en",
          audio_duration: 1.5,
          segments: [{ text: "Hi!", start: 0, end: 1.1 }],
          word_segments: [{ word: "Hi", start: 0.1, end: 0.9 }, { word: "!" }],
        },
      }),
    );
    const result = await createWhisperXClient({
      config: { baseUrl: "https://gpu.example.test", apiKey: "test" },
      fetch,
    }).transcribe({ model: "whisperx", languages: ["en"], timestamps: "word" }, file);
    expect(result).toMatchObject({
      text: "Hi!",
      durationMs: 1500,
      words: [{ text: "Hi", startMs: 100, endMs: 900 }],
      segments: [{ text: "Hi!", startMs: 0, endMs: 1100 }],
    });
    const form = fetch.mock.calls[0]?.[1].body as FormData;
    expect(form.get("sync_mode")).toBe("true");
    expect(form.get("skip_cache")).toBe("true");
  });
  it("does not infer success or retry from processing and missing results", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ status: "processing", file_id: "x" }));
    await expect(
      createWhisperXClient({ config: { baseUrl: "https://gpu.example.test" }, fetch }).transcribe(
        { model: "whisperx" },
        file,
      ),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
