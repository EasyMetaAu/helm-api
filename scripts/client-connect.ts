import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseToml } from "@iarna/toml";
import { applyEdits, modify, parse as parseJson, type ParseError } from "jsonc-parser";
import { z } from "zod";

const FieldSchema = z.object({ path: z.array(z.string()), before: z.string().nullable(), after: z.string() });
const PlanSchema = z.object({
  version: z.literal(1), client: z.enum(["claude", "codex"]), file: z.string(), receipt: z.string(),
  before_hash: z.string(), fields: z.array(FieldSchema), block: z.string(),
});
type Plan = z.infer<typeof PlanSchema>;
const ReceiptSchema = z.object({ plan: PlanSchema, after_hash: z.string() });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const begin = "# BEGIN HELM MANAGED CONNECTION";
const end = "# END HELM MANAGED CONNECTION";

async function readConfig(file: string): Promise<string> {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error("Client config symlinks are not supported.");
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
function json(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parseJson(text || "{}", errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid client JSON config.");
  return value as Record<string, unknown>;
}
function toml(text: string): ReturnType<typeof parseToml> {
  try { return parseToml(text); } catch { throw new Error("Invalid client TOML config."); }
}
function valueAt(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) current = current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
  return current;
}
function editJson(text: string, fields: Plan["fields"], undo: boolean): string {
  let next = text || "{}\n";
  for (const field of fields) next = applyEdits(next, modify(next, field.path, undo ? (field.before ?? undefined) : field.after, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  return next;
}

export async function previewConnection(input: { client: "claude" | "codex"; file: string; receipt: string; url: string; model: string }): Promise<Plan> {
  const url = new URL(input.url);
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new Error("Use a gateway URL without credentials, query or fragment.");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Remote gateways require HTTPS.");
  if (!["", "/", "/v1", "/v1/"].includes(url.pathname)) throw new Error("Use the gateway origin or its /v1 URL.");
  if (!input.model.trim() || /[\r\n\0]/.test(input.model)) throw new Error("Invalid lane name.");
  const file = resolve(input.file), receipt = resolve(input.receipt);
  if (await canonical(file) === await canonical(receipt)) throw new Error("Config and receipt must be different files.");
  const text = await readConfig(file);
  const plan: Plan = { version: 1, client: input.client, file, receipt, before_hash: hash(text), fields: [], block: "" };
  if (input.client === "claude") {
    const config = json(text);
    if (config.env !== undefined && (!config.env || typeof config.env !== "object" || Array.isArray(config.env))) throw new Error("Invalid client env config.");
    // Do not read or replace credentials. A pre-existing auth source must be resolved
    // by its owner instead of being silently superseded by the new connection.
    if (valueAt(config, ["env", "ANTHROPIC_AUTH_TOKEN"]) !== undefined || valueAt(config, ["env", "ANTHROPIC_API_KEY"]) !== undefined || config.apiKeyHelper !== undefined) throw new Error("An existing Claude authentication setting conflicts with the Helm helper.");
    for (const [path, after] of [[ ["env", "ANTHROPIC_BASE_URL"], url.origin ], [ ["env", "ANTHROPIC_MODEL"], input.model ], [ ["apiKeyHelper"], "printenv HELM_API_KEY" ]] as const) {
      const before = valueAt(config, [...path]);
      if (before !== undefined && typeof before !== "string") throw new Error("Invalid existing client field.");
      plan.fields.push({ path: [...path], before: before ?? null, after });
    }
  } else {
    const config = toml(text);
    if (text.includes(begin) || valueAt(config, ["model_providers", "helm"]) !== undefined || valueAt(config, ["profiles", "helm"]) !== undefined) throw new Error("A Helm profile/provider already exists; roll back the managed connection first.");
    plan.block = `\n${begin}\n[model_providers.helm]\nname = "Helm"\nbase_url = ${JSON.stringify(`${url.origin}/v1`)}\nwire_api = "responses"\nenv_key = "HELM_API_KEY"\n\n[profiles.helm]\nmodel_provider = "helm"\nmodel = ${JSON.stringify(input.model)}\n${end}\n`;
    toml(text + plan.block);
  }
  return plan;
}

async function canonical(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(file);
    return parent === file ? file : resolve(await canonical(parent), basename(file));
  }
}

export async function saveConnectionPreview(plan: Plan, file: string): Promise<void> {
  const paths = await Promise.all([file, plan.file, plan.receipt].map(path => canonical(resolve(path))));
  if (new Set(paths).size !== paths.length) throw new Error("Plan, config and receipt must be different files.");
  await atomicWrite(resolve(file), JSON.stringify(plan, null, 2));
}

async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
async function locked<T>(file: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.helm-lock`;
  const handle = await open(lock, "wx", 0o600);
  try { return await run(); } finally { await handle.close(); await rm(lock); }
}

export async function applyConnection(input: Plan): Promise<void> {
  const plan = PlanSchema.parse(input);
  await locked(plan.file, async () => {
    const current = await readConfig(plan.file);
    const existing = await readConfig(plan.receipt);
    if (existing) {
      const receipt = ReceiptSchema.parse(JSON.parse(existing));
      if (receipt.after_hash === hash(current) && JSON.stringify(receipt.plan) === JSON.stringify(plan)) return;
      throw new Error("An existing connection receipt must be resolved before applying another plan.");
    }
    if (hash(current) !== plan.before_hash) throw new Error("Client config changed after preview; preview again.");
    const next = plan.client === "claude" ? editJson(current, plan.fields, false) : current + plan.block;
    if (plan.client === "claude") json(next); else toml(next);
    // Prepare recovery evidence BEFORE the config write. An interrupted apply can
    // be retried (exact after hash) or inspected without losing previous values.
    await atomicWrite(plan.receipt, JSON.stringify({ plan, after_hash: hash(next) }, null, 2));
    if (hash(await readConfig(plan.file)) !== plan.before_hash) throw new Error("Client config changed before apply; no config was written.");
    await atomicWrite(plan.file, next);
  });
}

export async function rollbackConnection(receiptFile: string): Promise<void> {
  const receipt = ReceiptSchema.parse(JSON.parse(await readFile(receiptFile, "utf8")));
  const { plan } = receipt;
  await locked(plan.file, async () => {
    const current = await readConfig(plan.file);
    if (hash(current) === plan.before_hash) { await rm(receiptFile); return; }
    let next: string;
    if (plan.client === "claude") {
      const config = json(current);
      if (plan.fields.some(field => valueAt(config, field.path) !== field.after)) throw new Error("An owned client field changed; nothing was overwritten.");
      next = editJson(current, plan.fields, true);
    } else {
      toml(current);
      if (!current.includes(plan.block) || current.split(begin).length !== 2) throw new Error("Managed client config changed; nothing was overwritten.");
      next = current.replace(plan.block, "");
      toml(next);
    }
    if (hash(await readConfig(plan.file)) !== hash(current)) throw new Error("Client config changed during rollback.");
    await atomicWrite(plan.file, next);
    await rm(receiptFile);
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    client: { type: "string" }, url: { type: "string" }, model: { type: "string", default: "auto" },
    plan: { type: "string" }, receipt: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log("client:connect preview --client claude|codex --url https://helm.example --plan FILE\nclient:connect apply --plan FILE\nclient:connect rollback --receipt FILE\nSet HELM_API_KEY in your shell before starting the client. No key is stored by this tool."); return; }
  const command = positionals[0] ?? "preview";
  if (command === "rollback") {
    if (!values.receipt) throw new Error("--receipt is required.");
    await rollbackConnection(resolve(values.receipt)); console.log("Connection rolled back."); return;
  }
  if (!values.plan) throw new Error("--plan is required.");
  if (command === "apply") {
    const plan = PlanSchema.parse(JSON.parse(await readFile(values.plan, "utf8")));
    await applyConnection(plan);
    console.log(`Connection applied. Set HELM_API_KEY, then run ${plan.client === "codex" ? "codex --profile helm" : "claude"}. Receipt: ${plan.receipt}`); return;
  }
  if (command !== "preview" || !values.url || !["claude", "codex"].includes(values.client ?? "")) throw new Error("Use preview --client claude|codex --url URL --plan FILE.");
  const client = values.client as "claude" | "codex";
  const configHome = client === "codex" ? (process.env.CODEX_HOME ?? resolve(homedir(), ".codex")) : (process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude"));
  const plan = await previewConnection({ client, file: resolve(configHome, client === "codex" ? "config.toml" : "settings.json"), receipt: values.receipt ?? resolve(homedir(), ".config/helm-client", `${client}.receipt.json`), url: values.url, model: values.model });
  await saveConnectionPreview(plan, values.plan);
  console.log(`Preview for ${plan.file}\n${plan.client === "codex" ? plan.block : plan.fields.map(field => `${field.path.join(".")} → ${field.after}`).join("\n")}\nPlan: ${resolve(values.plan)}\nNo client config changed.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Connection operation failed. Check the config, preview and receipt; no credentials are printed. Run with --help for usage."); process.exitCode = 1; });
}
