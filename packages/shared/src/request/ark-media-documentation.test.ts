import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { ArkPublicTaskResultSchema } from "./ark-media-public-schema.js";
import {
  ArkImageGenerationRequestSchema,
  ArkThreeDGenerationRequestSchema,
  ArkVideoGenerationRequestSchema,
} from "./ark-media-schema.js";

it("validates every JSON example in the public Ark guide against the declared contracts", () => {
  const doc = readFileSync(resolve("docs/ark-media.md"), "utf8");
  const examples = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)];
  expect(examples).toHaveLength(6);
  const models: Record<string, string> = {
    "seedream-flash": "doubao-seedream-5-0-flash-260915",
    "seedream-pro": "doubao-seedream-5-0-pro-260628",
    "seedance-video": "doubao-seedance-2-5-260628",
    seed3d: "doubao-seed3d-2-0-260328",
  };
  for (const example of examples) {
    const body = JSON.parse(example[1] ?? "") as Record<string, unknown>;
    if (typeof body.model !== "string") {
      expect(ArkPublicTaskResultSchema.safeParse(body).success).toBe(true);
      continue;
    }
    const model = models[body.model];
    const schema = body.model.startsWith("seedream")
      ? ArkImageGenerationRequestSchema
      : body.model === "seedance-video"
        ? ArkVideoGenerationRequestSchema
        : ArkThreeDGenerationRequestSchema;
    const parsed = schema.safeParse({ ...body, model });
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
  }
});
