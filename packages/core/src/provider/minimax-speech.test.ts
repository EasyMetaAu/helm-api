import { describe, expect, it, vi } from "vitest";
import { createMiniMaxSpeechClient } from "./minimax-speech.js";

const request = {
  model: "speech-2.8-hd",
  input: "Hello",
  voice: "English_Graceful_Lady",
  response_format: "mp3",
};
describe("MiniMax speech HTTP", () => {
  it("maps core fields, decodes hex and preserves both billed units", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        base_resp: { status_code: 0 },
        data: { audio: "0102ff", status: 2 },
        extra_info: { usage_characters: 5, usage_voice_count: 1 },
      }),
    );
    const client = createMiniMaxSpeechClient({
      config: { baseUrl: "https://api.minimax.io/v1", apiKey: "test" },
      fetch,
    });
    const result = await client.ttsSpeech(request);
    expect([...result.audio]).toEqual([1, 2, 255]);
    expect(result.usage).toEqual({ usage_characters: 5, usage_voice_count: 1 });
    expect(result.contentType).toBe("audio/mpeg");
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toMatchObject({
      model: request.model,
      text: "Hello",
      stream: false,
      voice_setting: { voice_id: request.voice, speed: 1 },
      audio_setting: { format: "mp3" },
    });
  });
  it.each([
    { base_resp: { status_code: 1004 }, data: { audio: "ff" } },
    { base_resp: { status_code: 0 }, data: { audio: "xyz" } },
  ])("rejects business errors and invalid hex without retries", async (body) => {
    const fetch = vi.fn().mockResolvedValue(Response.json(body));
    await expect(
      createMiniMaxSpeechClient({
        config: { baseUrl: "https://api.minimax.io/v1", apiKey: "test" },
        fetch,
      }).ttsSpeech(request),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("uses the host-root endpoint and rejects unsupported sample rates before a request", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ base_resp: { status_code: 0 }, data: { audio: "01" } }));
    const client = createMiniMaxSpeechClient({
      config: { baseUrl: "https://api.minimax.io" },
      fetch,
    });
    await client.ttsSpeech(request);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.minimax.io/v1/t2a_v2");
    await expect(client.ttsSpeech({ ...request, sample_rate: 1234 })).rejects.toThrow(
      "unsupported",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("fails incomplete streams and cancels the body when the iterator closes", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"base_resp":{"status_code":0},"data":{"audio":"01","status":1}}\n\n',
              ),
            );
          },
          cancel,
        }),
      ),
    );
    const stream = createMiniMaxSpeechClient({
      config: { baseUrl: "https://api.minimax.io" },
      fetch,
    })
      .streamSpeech(request)
      [Symbol.asyncIterator]();
    await stream.next();
    await stream.next();
    await stream.return?.();
    expect(cancel).toHaveBeenCalledTimes(1);
    const short = createMiniMaxSpeechClient({
      config: { baseUrl: "https://api.minimax.io" },
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(
            'data: {"base_resp":{"status_code":0},"data":{"audio":"01","status":1}}\n\n',
          ),
        ),
    });
    await expect(
      (async () => {
        for await (const _ of short.streamSpeech(request)) {
          /* drain */
        }
      })(),
    ).rejects.toThrow("before completion");
  });
  it("streams before completion and drops a final aggregate", async () => {
    const parts = [
      { base_resp: { status_code: 0 }, data: { audio: "0102", status: 1 } },
      {
        base_resp: { status_code: 0 },
        data: { audio: "0102", status: 2 },
        extra_info: { usage_characters: 5, usage_voice_count: 0 },
      },
    ];
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(parts.map((x) => `data: ${JSON.stringify(x)}\n\n`).join("")));
    const events = [];
    for await (const event of createMiniMaxSpeechClient({
      config: { baseUrl: "https://api.minimax.io/v1" },
      fetch,
    }).streamSpeech(request))
      events.push(event);
    expect(events.map((x) => x.type)).toEqual(["started", "audio", "usage", "completed"]);
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body).stream_options).toEqual({
      exclude_aggregated_audio: true,
    });
  });
});
