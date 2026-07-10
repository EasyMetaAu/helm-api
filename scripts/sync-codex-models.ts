import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodexModelsResponseSchema } from "../packages/core/src/provider/oauth/codex-model-info.js";

const sourceRoot = resolve(process.env.CODEX_REPO ?? "../../codex");
const source = resolve(sourceRoot, "codex-rs/models-manager/models.json");
const target = resolve("apps/gateway/src/oauth/codex-models.json");

const raw = await readFile(source, "utf8");
const parsed = CodexModelsResponseSchema.parse(JSON.parse(raw) as unknown);
const normalized = `${JSON.stringify({ models: parsed.models }, null, 2)}\n`;
await writeFile(target, normalized, "utf8");

const digest = createHash("sha256").update(normalized).digest("hex");
console.log(`synced ${parsed.models.length} Codex models to ${target} (${digest})`);
