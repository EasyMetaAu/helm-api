import { describe, expect, it, vi } from "vitest";
import { createDoubaoAsrClient, normalizeDoubaoTranscription } from "./doubao-asr.js";
import { createDoubaoSpeechClient } from "./doubao-speech.js";

describe("Doubao voice protocols", () => {
  it("maps TTS 2.0 subtitles from seconds and preserves billable text_words", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        [
          { code: 0, data: "AQI=" },
          {
            code: 0,
            data: null,
            sentence: { text: "Hi", words: [{ word: "Hi", startTime: 0.12, endTime: 0.45 }] },
          },
          { code: 20000000, data: null, usage: { text_words: 2 } },
        ]
          .map((x) => `data: ${JSON.stringify(x)}\n\n`)
          .join(""),
      ),
    );
    const result = await createDoubaoSpeechClient({
      config: { baseUrl: "https://openspeech.bytedance.com", apiKey: "test" },
      fetch,
    }).ttsSpeech({ model: "seed-tts-2.0", voice: "voice", input: "Hi", timestamps: "word" });
    expect(result).toMatchObject({
      audio: new Uint8Array([1, 2]),
      timestamps: [{ startMs: 120, endMs: 450, words: [{ text: "Hi", startMs: 120, endMs: 450 }] }],
      usage: { text_words: 2, usage_characters: 2 },
    });
    expect(fetch.mock.calls[0]?.[1].headers["X-Api-Resource-Id"]).toBe("seed-tts-2.0");
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toMatchObject({
      req_params: { audio_params: { enable_subtitle: true } },
    });
  });
  it("submits a caller-persisted ASR id and queries that same id without resubmitting", async () => {
    const id = "5250b68e-18a1-4923-93d1-938c92af83b3";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { headers: { "X-Api-Status-Code": "20000000" } }))
      .mockResolvedValueOnce(
        Response.json(
          {
            audio_info: { duration: 1700 },
            result: {
              text: "Hi",
              utterances: [
                {
                  text: "Hi",
                  start_time: 120,
                  end_time: 450,
                  words: [{ text: "Hi", start_time: 120, end_time: 450 }],
                },
              ],
            },
          },
          { headers: { "X-Api-Status-Code": "20000000" } },
        ),
      );
    const client = createDoubaoAsrClient({
      config: { baseUrl: "https://openspeech.bytedance.com", apiKey: "test" },
      fetch,
    });
    expect(
      await client.transcriptionCreate(
        { model: "bigmodel", audio: { url: "https://example.com/a.wav", format: "wav" } },
        { providerRequestId: id },
      ),
    ).toMatchObject({ id });
    const result = await client.transcriptionRetrieve(id);
    expect(normalizeDoubaoTranscription(result, id)).toMatchObject({
      status: "done",
      transcription: {
        text: "Hi",
        durationMs: 1700,
        segments: [{ startMs: 120, endMs: 450 }],
        usage: { type: "duration", seconds: 1.7 },
      },
      usage: { type: "duration", seconds: 1.7 },
    });
    expect(fetch.mock.calls.map((call) => call[1].headers["X-Api-Request-Id"])).toEqual([id, id]);
    expect(fetch.mock.calls[0]?.[1].headers).toMatchObject({
      "X-Api-Key": "test",
      "X-Api-Resource-Id": "volc.seedasr.auc",
    });
    expect(fetch.mock.calls[0]?.[1].headers).not.toHaveProperty("Authorization");
    expect(fetch.mock.calls[0]?.[1].headers).not.toHaveProperty("X-Api-App-Key");
  });
  it("requires a durable ID before submit and treats duplicate/ambiguous rejection as unknown", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { "X-Api-Status-Code": "45000001" } }));
    const client = createDoubaoAsrClient({
      config: { baseUrl: "https://openspeech.bytedance.com", apiKey: "test" },
      fetch,
    });
    const req = { model: "bigmodel", audio: { url: "https://example.com/a.wav", format: "wav" } };
    await expect(client.transcriptionCreate(req)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      client.transcriptionCreate(req, {
        providerRequestId: "5250b68e-18a1-4923-93d1-938c92af83b3",
      }),
    ).rejects.toMatchObject({ outcome: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it("does not fabricate ASR duration from its last subtitle", () => {
  const result = normalizeDoubaoTranscription(
    {
      id: "id",
      code: 20000000,
      result: {
        text: "Hi",
        utterances: [{ text: "Hi", start_time: 0, end_time: 450 }],
      },
    },
    "id",
  );
  expect(result && "transcription" in result ? result.transcription : undefined).not.toHaveProperty(
    "durationMs",
  );
  expect(result && "transcription" in result ? result.transcription : undefined).not.toHaveProperty(
    "usage",
  );
});

it.each([
  408, 500, 503, 529,
])("keeps a TTS HTTP %s outcome unknown without retry", async (status) => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
  const client = createDoubaoSpeechClient({
    config: { baseUrl: "https://openspeech.bytedance.com", apiKey: "test" },
    fetch,
  });
  await expect(
    client.ttsSpeech({ model: "seed-tts-2.0", voice: "voice", input: "Hi" }),
  ).rejects.toMatchObject({ outcome: "unknown" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("reports no-speech explicitly instead of fabricating a successful transcript", async () => {
  const result = normalizeDoubaoTranscription({ id: "id", code: 20000003 }, "id");
  expect(result).toMatchObject({ status: "failed", error: { code: "no_speech" } });
});

it("keeps real word timestamps when Doubao inserts untimed spaces", async () => {
  const id = "5250b68e-18a1-4923-93d1-938c92af83b3";
  const payload = {
    audio_info: {
      duration: 3560,
    },
    result: {
      additions: {
        duration: "3560",
      },
      text: "A good follow up starts with something you actually remember.",
      utterances: [
        {
          end_time: 3160,
          start_time: 0,
          text: "A good follow up starts with something you actually remember.",
          words: [
            {
              confidence: 0,
              end_time: 200,
              start_time: 0,
              text: "A",
            },
            {
              confidence: 0,
              end_time: -1,
              start_time: -1,
              text: " ",
            },
            {
              confidence: 0,
              end_time: 400,
              start_time: 200,
              text: "good",
            },
            {
              confidence: 0,
              end_time: -1,
              start_time: -1,
              text: " ",
            },
            {
              confidence: 0,
              end_time: 680,
              start_time: 480,
              text: "follow",
            },
            {
              confidence: 0,
              end_time: -1,
              start_time: -1,
              text: " ",
            },
            {
              confidence: 0,
              end_time: 880,
              start_time: 720,
              text: "up",
            },
            {
              confidence: 0,
              end_time: -1,
              start_time: -1,
              text: " ",
            },
            {
              confidence: 0,
              end_time: 1320,
              start_time: 1080,
              text: "starts",
            },
            {
              confidence: 0,
              end_time: -1,
              start_time: -1,
              text: " ",
            },
            {
              confidence: 0,
              end_time: 1640,
              start_time: 1400,
              text: "with",
            },
            {
              confidence: 0,
              end_time: -1,
              start_time: -1,
              text: " ",
            },
            {
              confidence: 0,
              end_time: 2000,
              start_time: 1680,
              text: "something",
            },
            {
              confidence: 0,
              end_time: -1,
              start_time: -1,
              text: " ",
            },
            {
              confidence: 0,
              end_time: 2280,
              start_time: 2040,
              text: "you",
            },
            {
              confidence: 0,
              end_time: -1,
              start_time: -1,
              text: " ",
            },
            {
              confidence: 0,
              end_time: 2680,
              start_time: 2360,
              text: "actually",
            },
            {
              confidence: 0,
              end_time: -1,
              start_time: -1,
              text: " ",
            },
            {
              confidence: 0,
              end_time: 3160,
              start_time: 2840,
              text: "remember",
            },
          ],
        },
      ],
    },
  };
  const fetch = vi.fn().mockResolvedValue(
    Response.json(payload, {
      headers: { "X-Api-Status-Code": "20000000" },
    }),
  );
  const client = createDoubaoAsrClient({
    config: { baseUrl: "https://openspeech.bytedance.com", apiKey: "test" },
    fetch,
  });
  const expected = {
    status: "done",
    usage: {
      type: "duration",
      seconds: 3.56,
    },
    transcription: {
      text: "A good follow up starts with something you actually remember.",
      durationMs: 3560,
      segments: [
        {
          text: "A good follow up starts with something you actually remember.",
          startMs: 0,
          endMs: 3160,
          words: [
            {
              text: "A",
              startMs: 0,
              endMs: 200,
            },
            {
              text: "good",
              startMs: 200,
              endMs: 400,
            },
            {
              text: "follow",
              startMs: 480,
              endMs: 680,
            },
            {
              text: "up",
              startMs: 720,
              endMs: 880,
            },
            {
              text: "starts",
              startMs: 1080,
              endMs: 1320,
            },
            {
              text: "with",
              startMs: 1400,
              endMs: 1640,
            },
            {
              text: "something",
              startMs: 1680,
              endMs: 2000,
            },
            {
              text: "you",
              startMs: 2040,
              endMs: 2280,
            },
            {
              text: "actually",
              startMs: 2360,
              endMs: 2680,
            },
            {
              text: "remember",
              startMs: 2840,
              endMs: 3160,
            },
          ],
        },
      ],
    },
  };
  expect(normalizeDoubaoTranscription({ id, code: 20000000, ...payload }, id)).toMatchObject(
    expected,
  );
  expect(normalizeDoubaoTranscription(await client.transcriptionRetrieve(id), id)).toMatchObject(
    expected,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toMatch(/\/query$/);
});

it.each([
  { text: "word", start_time: -1, end_time: -1 },
  { text: "", start_time: -1, end_time: -1 },
  { text: " ", start_time: -1, end_time: 0 },
  { text: " ", start_time: "-1", end_time: "-1" },
  null,
])("rejects invalid word timing instead of silently dropping it: %j", (word) => {
  expect(
    normalizeDoubaoTranscription(
      {
        id: "id",
        code: 20000000,
        result: {
          text: "word",
          utterances: [{ text: "word", start_time: 0, end_time: 400, words: [word] }],
        },
      },
      "id",
    ),
  ).toBeNull();
});

it("does not drop untimed utterances", () => {
  expect(
    normalizeDoubaoTranscription(
      {
        id: "id",
        code: 20000000,
        result: {
          text: " ",
          utterances: [{ text: " ", start_time: -1, end_time: -1 }],
        },
      },
      "id",
    ),
  ).toBeNull();
});
