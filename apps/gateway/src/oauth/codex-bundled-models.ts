import { readFileSync } from "node:fs";
import { type CodexModelInfo, CodexModelsResponseSchema } from "@helm/core";

let cached: CodexModelInfo[] | undefined;

export function loadBundledCodexModels(): CodexModelInfo[] {
  if (cached !== undefined) return cached;
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./codex-models.json", import.meta.url), "utf8"),
  );
  cached = CodexModelsResponseSchema.parse(raw).models;
  return cached;
}
