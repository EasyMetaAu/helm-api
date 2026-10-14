import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ArkTaskCreateResponseSchema,
  ArkImageGenerationRequestSchema as ImageRequest,
  ArkImageGenerationResponseSchema as ImageResponse,
  ArkThreeDGenerationRequestSchema as ThreeDRequest,
  ArkThreeDRetrieveResponseSchema as ThreeDResponse,
  ArkVideoGenerationRequestSchema as VideoRequest,
  ArkVideoRetrieveResponseSchema as VideoResponse,
} from "./ark-media-schema.js";

const flash = "doubao-seedream-5-0-flash-260915";
const pro = "doubao-seedream-5-0-pro-260628";
const videoModel = "doubao-seedance-2-5-260628";
const threeModel = "doubao-seed3d-2-0-260328";
const url = "https://media.example.com/source.png";
const text = { type: "text", text: "A quiet lake at sunrise" };
const image = (role: string) => ({ type: "image_url", image_url: { url }, role });
const video = {
  type: "video_url",
  video_url: { url: "https://media.example.com/ref.mp4" },
  role: "reference_video",
};
const audio = {
  type: "audio_url",
  audio_url: { url: "https://media.example.com/ref.mp3" },
  role: "reference_audio",
};
const simpleVideo = {
  model: videoModel,
  content: [text],
  duration: 4,
  ratio: "16:9",
  resolution: "480p",
};
const simple3D = {
  model: threeModel,
  content: [{ type: "image_url", image_url: { url } }],
  file_format: "glb",
  subdivision_level: "medium",
};

describe.each([flash, pro])("Seedream %s", (model) => {
  it("accepts generation, editing, ten references and automatic layers without rewriting", () => {
    for (const body of [
      { model, prompt: " A lake ", size: "1.5K", stream: false },
      { model, prompt: "Edit", image: url, size: "2048x1024" },
      {
        model,
        prompt: "Combine",
        image: Array(10).fill(url),
        output_format: "png",
        response_format: "b64_json",
        watermark: false,
      },
      { model, image: url, layer_decomposition: true, size: "auto" },
      { model, prompt: "Edit", image: [url], background: "transparent" },
    ])
      expect(ImageRequest.parse(body)).toEqual(body);
  });
  it.each([
    {},
    { prompt: " " },
    { prompt: null },
    { prompt: "x", size: "4K" },
    { prompt: "x", size: "512x512" },
    { prompt: "x", size: "4000x2000" },
    { prompt: "x", size: "4000x240" },
    { prompt: "x", size: "auto" },
    { prompt: "x", image: [] },
    { prompt: "x", image: Array(11).fill(url) },
    { layer_decomposition: true },
    { layer_decomposition: true, image: [url, url] },
    { layer_decomposition: true, image: url, size: "2048x1024" },
    { prompt: "x", background: "transparent" },
    { prompt: "x", background: "transparent", image: [url, url] },
    { prompt: "x", background: "transparent", image: url, output_format: "jpeg" },
    { prompt: "x", stream: true },
    { prompt: "x", sequential_image_generation: "disabled" },
    { prompt: "x", sequential_image_generation_options: { max_images: 1 } },
    { prompt: "x", tools: [] },
    { prompt: "x", n: 1 },
    { prompt: "x", seed: 1 },
    { prompt: "x", image: { url } },
    { prompt: "x", output_format: "webp" },
  ])("rejects unsupported/invalid fields: %j", (fields) => {
    expect(ImageRequest.safeParse({ model, ...fields }).success).toBe(false);
  });
});

it("limits prompt optimization fast mode to Pro", () => {
  const fields = { prompt: "A lake", optimize_prompt_options: { mode: "fast" } };
  expect(ImageRequest.safeParse({ model: pro, ...fields }).success).toBe(true);
  expect(ImageRequest.safeParse({ model: flash, ...fields }).success).toBe(false);
});

it.each([
  "http://example.com/a",
  "data:image/png;base64,AAAA",
  "asset://id",
  "file:///tmp/a",
  "https://user:pass@example.com/a",
  "https://@example.com/a",
  "https://example.com/a#fragment",
  "https://localhost/a",
  "https://127.0.0.1/a",
  "https://2130706433/a",
  "https://[::1]/a",
  "https://10.0.0.1/a",
  "https://host.local/a",
  "https://example.com:8443/a",
  " https://example.com/a",
  "https://example.com/a\n",
])("rejects unsupported URL input consistently: %s", (source) => {
  expect(ImageRequest.safeParse({ model: flash, prompt: "x", image: source }).success).toBe(false);
  expect(
    VideoRequest.safeParse({
      ...simpleVideo,
      ratio: "adaptive",
      content: [{ ...image("first_frame"), image_url: { url: source } }],
    }).success,
  ).toBe(false);
  expect(
    ThreeDRequest.safeParse({
      ...simple3D,
      content: [{ type: "image_url", image_url: { url: source } }],
    }).success,
  ).toBe(false);
});

it("rejects all non-approved model IDs", () => {
  for (const model of [
    "auto",
    "ep-private",
    "doubao-seedance-2-0-260128",
    "grok-imagine-video",
    "seedance-video",
  ]) {
    expect(ImageRequest.safeParse({ model, prompt: "x" }).success).toBe(false);
    expect(VideoRequest.safeParse({ ...simpleVideo, model }).success).toBe(false);
    expect(ThreeDRequest.safeParse({ ...simple3D, model }).success).toBe(false);
  }
});

describe("Seedance 2.5", () => {
  it("accepts text, first frame, first/last frames and ordered multimodal references", () => {
    for (const body of [
      simpleVideo,
      { ...simpleVideo, ratio: "adaptive", content: [image("first_frame")] },
      {
        ...simpleVideo,
        ratio: "adaptive",
        content: [text, image("first_frame"), image("last_frame")],
      },
      {
        ...simpleVideo,
        duration: 11,
        omni_reference_task_type: "reference",
        content: [text, image("reference_image"), video, image("reference_image"), audio],
        generate_audio: true,
        output_format: "mp4",
      },
      { ...simpleVideo, duration: -1, content: [audio], omni_reference_task_type: "reference" },
    ])
      expect(VideoRequest.parse(body)).toEqual(body);
  });
  it("accepts exact count boundaries and rejects one over each", () => {
    const content = [
      ...Array(30).fill(image("reference_image")),
      ...Array(10).fill(video),
      ...Array(10).fill(audio),
    ];
    expect(
      VideoRequest.safeParse({
        ...simpleVideo,
        content: [text, ...content],
        omni_reference_task_type: "reference",
      }).success,
    ).toBe(true);
    for (const extra of [image("reference_image"), video, audio]) {
      expect(
        VideoRequest.safeParse({
          ...simpleVideo,
          content: [...content, extra],
          omni_reference_task_type: "reference",
        }).success,
      ).toBe(false);
    }
  });
  it.each([
    [31, 0, 0],
    [0, 11, 0],
    [0, 0, 11],
  ])("enforces independent material counts %s/%s/%s", (images, videos, audios) => {
    const content = [
      ...Array(images).fill(image("reference_image")),
      ...Array(videos).fill(video),
      ...Array(audios).fill(audio),
    ];
    expect(
      VideoRequest.safeParse({ model: videoModel, content, omni_reference_task_type: "reference" })
        .success,
    ).toBe(false);
  });
  it.each([
    { content: [] },
    { content: [text, text] },
    { duration: 3 },
    { duration: 31 },
    { duration: 4.5 },
    { ratio: "3:2" },
    { resolution: "4k" },
    { seed: 1 },
    { camera_fixed: false },
    { callback_url: url },
    { draft: false },
    { frames: 120 },
    { output_format: "mov" },
    { content: [image("last_frame")], ratio: "adaptive" },
    { content: [image("first_frame")] },
    { content: [image("first_frame"), image("first_frame")], ratio: "adaptive" },
    {
      content: [image("first_frame"), audio],
      ratio: "adaptive",
      omni_reference_task_type: "reference",
    },
    { content: [image("reference_image")] },
    { content: [video], omni_reference_task_type: "auto" },
    { content: [video], omni_reference_task_type: "edit" },
    { content: [video], omni_reference_task_type: "extend" },
    { omni_reference_task_type: "reference" },
    {
      content: [{ ...image("reference_image"), extra: true }],
      omni_reference_task_type: "reference",
    },
    { content: [{ ...video, role: "reference_image" }], omni_reference_task_type: "reference" },
    { content: [{ type: "text", text: "Lake --dur 3" }] },
  ])("rejects invalid combinations/options %j", (fields) => {
    expect(VideoRequest.safeParse({ ...simpleVideo, ...fields }).success).toBe(false);
  });
  it.each([4, 30, -1])("accepts duration boundary %s", (duration) => {
    expect(VideoRequest.safeParse({ ...simpleVideo, duration }).success).toBe(true);
  });
});

describe("Seed3D", () => {
  it.each([
    "low",
    "medium",
    "high",
  ])("accepts one image and subdivision %s", (subdivision_level) => {
    expect(ThreeDRequest.parse({ ...simple3D, subdivision_level })).toEqual({
      ...simple3D,
      subdivision_level,
    });
  });
  it.each([
    { content: [] },
    { content: [text] },
    { content: [simple3D.content[0], simple3D.content[0]] },
    { content: [text, simple3D.content[0]] },
    { file_format: "obj" },
    { subdivision_level: "ultra" },
    { prompt: "x" },
    { content: [image("first_frame")] },
    { watermark: true },
  ])("rejects unsupported 3D forms %j", (fields) => {
    expect(ThreeDRequest.safeParse({ ...simple3D, ...fields }).success).toBe(false);
  });
});

describe("responses", () => {
  const layer = {
    url,
    size: "1273x265",
    output_format: "png",
    z_index: 1,
    bounding_box: { absolute: [383, 120, 1655, 384], normalized: [187, 59, 808, 188] },
    name: "Title",
    description: "Yellow title",
  };
  it.each([flash, pro])("preserves image/layer/usage metadata for %s", (model) => {
    const body = {
      model,
      created: 1784696685,
      data: [{ url, size: "2048x2048", output_format: "jpeg", z_index: 0 }, layer],
      usage: { input_images: 1, generated_images: 2, output_tokens: 23107, total_tokens: 23107 },
    };
    expect(ImageResponse.parse(body)).toEqual(body);
    expect(
      ImageResponse.safeParse({
        model,
        created: 1,
        data: [{ b64_json: "AAAA", size: "1024x1024", output_format: "png" }],
      }).success,
    ).toBe(true);
  });
  it("rejects incomplete and contradictory layer success bodies", () => {
    for (const data of [
      [],
      [{}],
      [{ ...layer, bounding_box: { absolute: [5, 5, 1, 1], normalized: [0, 0, 1001, 1000] } }],
      [layer, layer],
      [{ ...layer, name: undefined }],
    ]) {
      expect(ImageResponse.safeParse({ model: flash, created: 1, data }).success).toBe(false);
    }
  });
  it("preserves documented video usage metadata without opening the request tool surface", () => {
    const body = {
      id: "v",
      model: videoModel,
      status: "succeeded",
      content: { video_url: url },
      priority: 0,
      tools: [],
      usage: { completion_tokens: 100, total_tokens: 100, tool_usage: { web_search: 0 } },
      error: null,
    };
    expect(VideoResponse.parse(body)).toEqual(body);
    expect(VideoRequest.safeParse({ ...simpleVideo, tools: [] }).success).toBe(false);
  });
  it("requires nonblank create IDs", () => {
    expect(ArkTaskCreateResponseSchema.parse({ id: "cgt-fixture" })).toEqual({ id: "cgt-fixture" });
    for (const id of ["", " ", null])
      expect(ArkTaskCreateResponseSchema.safeParse({ id }).success).toBe(false);
  });
  it.each([
    "queued",
    "running",
    "cancelled",
    "failed",
    "succeeded",
  ])("validates upstream state %s for both task kinds", (status) => {
    const common = {
      id: "cgt-fixture",
      status,
      created_at: 1,
      updated_at: 2,
      ...(status === "failed"
        ? { error: { code: "SetLimitExceeded", message: "Limit reached" } }
        : {}),
    };
    expect(
      VideoResponse.safeParse({
        ...common,
        model: videoModel,
        ...(status === "succeeded" ? { content: { video_url: url } } : {}),
      }).success,
    ).toBe(true);
    expect(
      ThreeDResponse.safeParse({
        ...common,
        model: threeModel,
        ...(status === "succeeded"
          ? { content: { file_url: url }, fileformat: "glb", subdivisionlevel: "medium" }
          : {}),
      }).success,
    ).toBe(true);
  });
  it("accepts Seed3D common task metadata observed in live running responses", () => {
    const response = {
      id: "cgt-fixture",
      model: threeModel,
      status: "running",
      created_at: 1791966252,
      updated_at: 1791966252,
      service_tier: "default",
      execution_expires_after: 172800,
      draft: false,
      priority: 0,
    };
    expect(ThreeDResponse.safeParse(response).success).toBe(true);
    expect(ThreeDResponse.safeParse({ ...response, priority: -1 }).success).toBe(false);
    expect(ThreeDResponse.safeParse({ ...response, unexpected_field: true }).success).toBe(false);
  });
  it("accepts null success errors and video expiry but rejects undocumented 3D expiry", () => {
    expect(
      VideoResponse.safeParse({
        id: "v",
        model: videoModel,
        status: "succeeded",
        error: null,
        content: { video_url: url },
      }).success,
    ).toBe(true);
    expect(
      ThreeDResponse.safeParse({
        id: "d",
        model: threeModel,
        status: "succeeded",
        error: null,
        content: { file_url: url },
      }).success,
    ).toBe(true);
    expect(VideoResponse.safeParse({ id: "v", model: videoModel, status: "expired" }).success).toBe(
      true,
    );
    expect(
      ThreeDResponse.safeParse({ id: "d", model: threeModel, status: "expired" }).success,
    ).toBe(false);
  });
  it("fails closed on unknown states, wrong kinds, missing artifacts and error/success conflicts", () => {
    for (const body of [
      { status: "unknown" },
      { status: "succeeded" },
      { status: "failed" },
      { status: "succeeded", content: { file_url: url } },
      { status: "succeeded", content: { video_url: url }, error: { code: "Bad", message: "No" } },
    ])
      expect(
        VideoResponse.safeParse({ id: "cgt-fixture", model: videoModel, ...body }).success,
      ).toBe(false);
    expect(
      ThreeDResponse.safeParse({
        id: "cgt-fixture",
        model: threeModel,
        status: "succeeded",
        content: { video_url: url },
      }).success,
    ).toBe(false);
  });
});

it("validates the four public request examples directly from the contract document", () => {
  const doc = readFileSync(
    new URL("../../../../docs/ark-media-contract.md", import.meta.url),
    "utf8",
  );
  const examples = [...doc.matchAll(/```json request\n([\s\S]*?)\n```/g)].map((match) =>
    JSON.parse(match[1] ?? ""),
  );
  expect(examples).toHaveLength(4);
  for (const [index, schema] of [
    ImageRequest,
    ImageRequest,
    VideoRequest,
    ThreeDRequest,
  ].entries()) {
    expect(schema.safeParse(examples[index]).success).toBe(true);
  }
});
