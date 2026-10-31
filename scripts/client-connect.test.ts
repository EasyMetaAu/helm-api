import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { previewConnection, applyConnection, rollbackConnection, saveConnectionPreview } from "./client-connect.js";

const dirs: string[] = [];
async function fixture(text: string, client: "claude" | "codex") {
  const dir = await mkdtemp(join(tmpdir(), "helm-connect-")); dirs.push(dir);
  const file = join(dir, client === "claude" ? "settings.json" : "config.toml");
  await writeFile(file, text);
  const receipt = join(dir, "receipt.json");
  const plan = await previewConnection({ client, file, url: "https://helm.test/v1", model: "work", receipt });
  return { file, receipt, plan };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe("local client connector", () => {
  it("preserves JSON comments and later unrelated changes on rollback", async () => {
    const { file, plan, receipt } = await fixture('{\n // keep\n "theme": "dark"\n}', "claude");
    await applyConnection(plan);
    const connected = await readFile(file, "utf8");
    expect(connected).toContain("// keep");
    expect(connected).toContain("https://helm.test");
    expect(connected).toContain("printenv HELM_API_KEY");
    await writeFile(file, connected.replace('"dark"', '"light"'));
    await rollbackConnection(receipt);
    const restored = await readFile(file, "utf8");
    expect(restored).toContain('"light"');
    expect(restored).not.toContain("ANTHROPIC_BASE_URL");
  });
  it("appends a named Codex profile without changing existing defaults", async () => {
    const initial = 'model = "existing" # preserve\n';
    const { file, plan, receipt } = await fixture(initial, "codex");
    await applyConnection(plan);
    expect(await readFile(file, "utf8")).toContain('[profiles.helm]');
    await writeFile(file, (await readFile(file, "utf8")) + '\n[features]\nweb_search = true\n');
    await rollbackConnection(receipt);
    expect(await readFile(file, "utf8")).toBe(initial + '\n[features]\nweb_search = true\n');
  });
  it("never writes a preview over the config or recovery receipt", async () => {
    const { file, plan, receipt } = await fixture('{}', "claude");
    await expect(saveConnectionPreview(plan, file)).rejects.toThrow(/different/);
    await expect(saveConnectionPreview(plan, receipt)).rejects.toThrow(/different/);
    expect(await readFile(file, "utf8")).toBe('{}');
  });
  it("refuses a stale preview without changing the file", async () => {
    const { file, plan } = await fixture('{}', "claude");
    await writeFile(file, '{"changed":true}');
    await expect(applyConnection(plan)).rejects.toThrow(/changed/);
    expect(await readFile(file, "utf8")).toBe('{"changed":true}');
  });
  it("preserves a user change to an owned field instead of overwriting it", async () => {
    const { file, plan, receipt } = await fixture('{}', "claude");
    await applyConnection(plan);
    await writeFile(file, (await readFile(file, "utf8")).replace('"work"', '"my-new-model"'));
    await expect(rollbackConnection(receipt)).rejects.toThrow(/changed/);
    expect(await readFile(file, "utf8")).toContain("my-new-model");
  });
  it("refuses unmanaged Codex names and invalid TOML", async () => {
    await expect(fixture('[model_providers.helm]\nname = "mine"\n', "codex")).rejects.toThrow(/already/);
    await expect(fixture('[broken', "codex")).rejects.toThrow(/config/);
  });
});
