import { describe, expect, it, vi } from "vitest";
import { createMiniMaxSpeechClient } from "./minimax-speech.js";

const subtitle = {
  text: "Hello",
  text_begin: 0,
  text_end: 5,
  time_begin: 20,
  time_end: 420,
  timestamped_words: [{ word: "Hello", word_begin: 0, word_end: 5, time_begin: 20, time_end: 420 }],
};
const request = { model: "speech-2.8-hd", input: "Hello", voice: "voice", timestamps: "word" };
describe("real speech timestamps", () => {
  it("collects native streaming subtitles for a structured HTTP result without another generation", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        [
          { base_resp: { status_code: 0 }, data: { audio: "0102", status: 1, subtitle } },
          {
            base_resp: { status_code: 0 },
            data: { status: 2 },
            extra_info: { usage_characters: 5, audio_length: 500 },
          },
        ]
          .map((x) => `data: ${JSON.stringify(x)}\n\n`)
          .join(""),
      ),
    );
    const result = await createMiniMaxSpeechClient({
      config: { baseUrl: "https://api.minimax.io" },
      fetch,
    }).ttsSpeech(request);
    expect(result).toMatchObject({
      audio: new Uint8Array([1, 2]),
      timestamps: [
        {
          text: "Hello",
          startMs: 20,
          endMs: 420,
          words: [{ text: "Hello", startMs: 20, endMs: 420 }],
        },
      ],
      usage: { usage_characters: 5, audio_length: 500 },
    });
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toMatchObject({
      stream: true,
      subtitle_enable: true,
      subtitle_type: "word",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not manufacture missing timestamps", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('data: {"base_resp":{"status_code":0},"data":{"audio":"01","status":2}}\n\n'),
      );
    const result = await createMiniMaxSpeechClient({
      config: { baseUrl: "https://api.minimax.io" },
      fetch,
    }).ttsSpeech(request);
    expect(result).not.toHaveProperty("timestamps");
  });
});
