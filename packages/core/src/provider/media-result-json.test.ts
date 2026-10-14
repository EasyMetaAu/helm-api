import https from "node:https";
import { expect, it, vi } from "vitest";
import { fetchPublicResultJson, type GeminiMediaFetch } from "./gemini.js";

it("fetches bounded result JSON through a public pinned address without credentials", async () => {
  const fetch = vi.fn<GeminiMediaFetch>(async () =>
    Response.json({ transcripts: [{ text: "hello" }] }),
  );
  const result = await fetchPublicResultJson("https://cdn.example/result.json", {
    fetch,
    lookup: async () => ["8.8.8.8"],
  });
  expect(result).toEqual({ transcripts: [{ text: "hello" }] });
  expect(fetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ pinnedAddress: "8.8.8.8" }));
});
it("rejects local, credential-bearing and redirect-to-private URLs before fetch", async () => {
  for (const url of ["https://127.0.0.1/file", "https://user:secret@cdn.example/file"]) {
    const fetch = vi.fn();
    await expect(fetchPublicResultJson(url, { fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  }
  const fetch = vi.fn(
    async () =>
      new Response(null, { status: 302, headers: { location: "https://127.0.0.1/file" } }),
  );
  await expect(
    fetchPublicResultJson("https://cdn.example/result", { fetch, lookup: async () => ["8.8.8.8"] }),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("bounds DNS and response size", async () => {
  await expect(
    fetchPublicResultJson("https://cdn.example/file", {
      timeoutMs: 20,
      lookup: () => new Promise(() => {}),
    }),
  ).rejects.toThrow();
  await expect(
    fetchPublicResultJson("https://cdn.example/file", {
      maxBytes: 5,
      lookup: async () => ["8.8.8.8"],
      fetch: async () => Response.json({ long: "too large" }),
    }),
  ).rejects.toThrow();
});
it("materializes ASR JSON and retains per-file failures", async () => {
  const { materializeBailianTranscription } = await import("./bailian-media.js");
  const download = vi.fn(async () => ({
    transcripts: [{ text: "你好", sentences: [{ begin_time: 0, end_time: 500, text: "你好" }] }],
  }));
  const result = await materializeBailianTranscription(
    {
      output: {
        task_id: "job-1",
        task_status: "SUCCEEDED",
        results: [
          { subtask_status: "SUCCEEDED", transcription_url: "https://cdn.example/result.json" },
          { subtask_status: "FAILED", code: "InvalidFile" },
        ],
      },
    },
    undefined,
    download,
  );
  expect(result.output.results?.[0]?.transcript).toEqual(
    expect.objectContaining({ transcripts: expect.any(Array) }),
  );
  expect(result.output.results?.[1]?.code).toBe("InvalidFile");
  expect(download).toHaveBeenCalledTimes(1);
});

it("upgrades the observed Bailian OSS result URL to HTTPS without changing its signature", async () => {
  const { materializeBailianTranscription } = await import("./bailian-media.js");
  const url =
    "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/prod/result.json?Signature=a%2Bb%3D&Expires=123";
  const download = vi.fn(async () => ({ transcripts: [{ text: "hello" }] }));
  const result = await materializeBailianTranscription(
    { output: { task_id: "job-1", task_status: "SUCCEEDED", result: { transcription_url: url } } },
    undefined,
    download,
  );
  expect(download).toHaveBeenCalledWith(url.replace("http:", "https:"), { signal: undefined });
  expect(result.output.result?.transcript).toEqual({ transcripts: [{ text: "hello" }] });
});

it.each([
  "http://cdn.example/result.json",
  "http://127.0.0.1/result.json",
  "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com.evil.example/result.json",
  "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:8080/result.json",
])("does not expand HTTP result trust to %s", async (url) => {
  const { materializeBailianTranscription } = await import("./bailian-media.js");
  const download = vi.fn(async () => ({}));
  await expect(
    materializeBailianTranscription(
      {
        output: { task_id: "job-1", task_status: "SUCCEEDED", result: { transcription_url: url } },
      },
      undefined,
      download,
    ),
  ).rejects.toThrow();
  expect(download).not.toHaveBeenCalled();
});

it.each([
  ["8.8.8.8", 4],
  ["2606:4700:4700::1111", 6],
] as const)("uses a single pinned %s address with Node family auto-selection disabled", async (address, family) => {
  const request = vi.spyOn(https, "request").mockImplementation(() => {
    throw new Error("stop before network");
  });
  try {
    await expect(
      fetchPublicResultJson("https://cdn.example/result.json", {
        lookup: async () => [address],
      }),
    ).rejects.toThrow("stop before network");
    const options = request.mock.calls[0]?.[1] as https.RequestOptions;
    expect(options).toMatchObject({ autoSelectFamily: false, family, servername: "cdn.example" });
    const callback = vi.fn();
    options.lookup?.("cdn.example", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, address, family);
  } finally {
    request.mockRestore();
  }
});
