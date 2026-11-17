import { describe, expect, it } from "vitest";
import { BailianTranscriptionRequestSchema } from "./bailian-media.js";

const input = { file_urls: ["https://cdn.example/audio.mp4?signature=a%2Bb%3D"] };
const parse = (parameters: unknown, model = "fun-asr") =>
  BailianTranscriptionRequestSchema.parse({ model, input, parameters });

describe("recorded-file ASR request contracts", () => {
  it("preserves Fun-ASR inline hotwords and documented options", () => {
    const parameters = {
      vocabulary: { 阿里巴巴: 4, "Helm API": 2 },
      language_hints: ["zh"],
      channel_id: [0],
      diarization_enabled: true,
      speaker_count: 2,
    };
    expect(parse(parameters)).toEqual({ model: "fun-asr", input, parameters });
  });

  it.each(["fun-asr", "paraformer-v2"])("accepts vocabulary_id for %s", (model) => {
    expect(parse({ vocabulary_id: "vocab-fixture" }, model).parameters).toEqual({
      vocabulary_id: "vocab-fixture",
    });
  });

  it("accepts the 2000-entry, 15-character and seven-ASCII-word limits", () => {
    const vocabulary = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`词${i}`, 4]));
    expect(parse({ vocabulary }).parameters).toEqual({ vocabulary });
    expect(() => parse({ vocabulary: { ["中".repeat(15)]: 1, "a b c d e f g": 5 } })).not.toThrow();
  });

  it.each([
    { vocabulary: Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`词${i}`, 4])) },
    { vocabulary: { ["中".repeat(16)]: 4 } },
    { vocabulary: { "a b c d e f g h": 4 } },
    { vocabulary: { "": 4 } },
    { vocabulary: { "   ": 4 } },
    { vocabulary: { 术语: 0 } },
    { vocabulary: { 术语: 6 } },
    { vocabulary: { 术语: 50 } },
    { vocabulary: { 术语: 1.5 } },
    { vocabulary: { 术语: "4" } },
    { vocabulary: [{ text: "术语", weight: 4 }] },
    { vocabulary_id: "" },
    { language_hints: ["zh", "en"] },
    { language_hints: ["not-a-language"] },
    { speaker_count: 1 },
    { speaker_count: 101 },
    { enable_itn: true },
    { enable_punctuation_prediction: true },
    { disfluency_removal_enabled: true },
    { timestamp_alignment_enabled: true },
  ])("rejects invalid or undocumented Fun-ASR parameters (case %#)", (parameters) => {
    expect(() => parse(parameters)).toThrow();
  });

  it("keeps Paraformer-only options separate from Fun-ASR", () => {
    const parameters = {
      vocabulary_id: "vocab-paraformer",
      language_hints: ["zh", "en"],
      disfluency_removal_enabled: true,
      timestamp_alignment_enabled: true,
      diarization_enabled: true,
      speaker_count: 2,
    };
    expect(parse(parameters, "paraformer-v2").parameters).toEqual(parameters);
    expect(() => parse({ vocabulary: { 术语: 4 } }, "paraformer-v2")).toThrow();
    expect(() => parse({ enable_itn: true }, "paraformer-v2")).toThrow();
    expect(() => parse({ language_hints: ["xx"] }, "paraformer-v2")).toThrow();
  });

  it.each(["fun-asr", "paraformer-v2"])("enforces one HTTP(S) URL for %s", (model) => {
    for (const url of ["http://cdn.example/a.wav", input.file_urls[0]]) {
      expect(() =>
        BailianTranscriptionRequestSchema.parse({ model, input: { file_urls: [url] } }),
      ).not.toThrow();
    }
    for (const file_urls of [
      [],
      ["https://cdn.example/a.wav", "https://cdn.example/b.wav"],
      ["file:///tmp/audio.wav"],
      ["data:audio/wav;base64,AAAA"],
      ["ftp://cdn.example/a.wav"],
      ["https://user:pass@cdn.example/a.wav"],
      ["not a URL"],
    ]) {
      expect(() =>
        BailianTranscriptionRequestSchema.parse({ model, input: { file_urls } }),
      ).toThrow();
    }
  });
});
