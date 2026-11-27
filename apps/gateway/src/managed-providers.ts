import { randomUUID } from "node:crypto";
import {
  type ConfigStore,
  createProviderRegistry,
  decryptSecret,
  encryptSecret,
  toRegistryProviders,
} from "@helm/core";
import {
  ManagedProviderInputSchema,
  type ProviderConfig,
  ProviderConfigSchema,
} from "@helm/shared";
import { z } from "zod";

export const LegacyProviderBindingSchema = z.object({
  accountId: z.string(),
  generation: z.string(),
  endpoint: z.string(),
  owner: z.string().nullable(),
});
export type LegacyProviderBinding = z.infer<typeof LegacyProviderBindingSchema>;
const DocumentSchema = z.object({
  providers: z.array(
    z.object({
      input: ManagedProviderInputSchema,
      revision: z.string(),
      legacyBinding: LegacyProviderBindingSchema.optional(),
    }),
  ),
  removed: z.array(z.string()),
  retiredAliases: z.array(z.string()).default([]),
  runtimeRevision: z.string().optional(),
});
type Document = z.infer<typeof DocumentSchema>;
const STORAGE = "provider.managed.v1";

/** Non-secret definitions are encrypted too. A tombstone prevents YAML resurrection. */
export class ManagedProviders {
  private document: Document = { providers: [], removed: [], retiredAliases: [] };
  private persisted: string | null | undefined;
  constructor(
    private store: ConfigStore,
    private encKey: Buffer | undefined,
    readonly baseline: readonly ProviderConfig[],
  ) {}
  async loadIfChanged() {
    const raw = await this.store.get(STORAGE);
    if (raw === this.persisted) return false;
    if (raw === null && this.persisted)
      throw new Error("Managed provider configuration was removed externally");
    if (raw && !this.encKey) throw new Error("Managed providers require the encryption key");
    const next = raw
      ? DocumentSchema.parse(JSON.parse(decryptSecret(raw, this.encKey!)))
      : { providers: [], removed: [], retiredAliases: [] };
    this.validate(next);
    this.document = next;
    this.persisted = raw;
    return true;
  }
  async load() {
    await this.loadIfChanged();
  }
  ownsAlias(alias: string) {
    return (
      this.document.retiredAliases.includes(alias) ||
      this.document.providers.some((p) => p.input.models.some((m) => m.alias === alias)) ||
      this.baseline.some((p) => this.owns(p.name) && p.models.some((m) => m.alias === alias))
    );
  }
  definitions() {
    return this.document.providers;
  }
  owns(id: string) {
    return (
      this.document.providers.some((p) => p.input.id === id) || this.document.removed.includes(id)
    );
  }
  revision(id: string) {
    return this.document.providers.find((p) => p.input.id === id)?.revision ?? "legacy";
  }
  poolId(id: string) {
    return this.baseline.find((p) => p.name === id)?.api_key_pool?.id ?? id;
  }
  private effective(doc: Document): ProviderConfig[] {
    const overrides = new Map(
      doc.providers.map(({ input }) => {
        const old = this.baseline.find((p) => p.name === input.id);
        return [
          input.id,
          ProviderConfigSchema.parse({
            ...old,
            ...input,
            name: input.id,
            alias: input.id,
            api_key_env: undefined,
            oauth: undefined,
            api_key_pool: {
              ...old?.api_key_pool,
              id: this.poolId(input.id),
              credential_type:
                old?.api_key_pool?.credential_type ??
                (old?.api_key_pool
                  ? old.type === "anthropic"
                    ? "anthropic"
                    : "openai"
                  : "compatible"),
              strategy: old?.api_key_pool?.strategy ?? "manual_priority",
            },
          }),
        ] as const;
      }),
    );
    return [
      ...this.baseline
        .filter((p) => !doc.removed.includes(p.name))
        .map((p) => overrides.get(p.name) ?? p),
      ...overrides.values(),
    ].filter((p, i, all) => all.findIndex((q) => q.name === p.name) === i);
  }

  providers() {
    return this.effective(this.document);
  }
  private validate(doc: Document) {
    createProviderRegistry(toRegistryProviders(this.effective(doc)));
  }
  private async change(fn: (d: Document) => void) {
    if (!this.encKey || !this.store.compareAndSet)
      throw new Error("Encrypted provider storage is unavailable");
    for (let i = 0; i < 10; i++) {
      const raw = await this.store.get(STORAGE);
      const doc: Document = raw
        ? DocumentSchema.parse(JSON.parse(decryptSecret(raw, this.encKey)))
        : { providers: [], removed: [], retiredAliases: [] };
      fn(doc);
      this.validate(doc);
      const encrypted = encryptSecret(JSON.stringify(doc), this.encKey);
      if (await this.store.compareAndSet(STORAGE, raw, encrypted)) {
        this.document = doc;
        this.persisted = encrypted;
        return;
      }
    }
    throw new Error("Providers changed concurrently; retry");
  }
  check(value: unknown) {
    const input = ManagedProviderInputSchema.parse(value);
    if (this.baseline.some((p) => p.name === input.id && p.oauth))
      throw new Error("Subscription identity is reserved");
    const doc = {
      providers: [
        ...this.document.providers.filter((p) => p.input.id !== input.id),
        { input, revision: "preview" },
      ],
      removed: this.document.removed.filter((id) => id !== input.id),
      retiredAliases: this.document.retiredAliases,
    };
    this.validate(doc);
    return this.effective(doc).find((p) => p.name === input.id)!;
  }
  async save(value: unknown) {
    this.check(value);
    const input = ManagedProviderInputSchema.parse(value);
    if (this.baseline.some((p) => p.name === input.id && p.oauth))
      throw new Error("Subscription provider identity is reserved");
    await this.change((doc) => {
      const old =
        doc.providers.find((p) => p.input.id === input.id)?.input.models ??
        this.baseline.find((p) => p.name === input.id)?.models ??
        [];
      doc.retiredAliases = [
        ...new Set([
          ...doc.retiredAliases,
          ...old.filter((m) => !input.models.some((n) => n.alias === m.alias)).map((m) => m.alias),
        ]),
      ];
      const next = {
        input,
        revision: randomUUID(),
        legacyBinding: doc.providers.find((p) => p.input.id === input.id)?.legacyBinding,
      };
      const index = doc.providers.findIndex((p) => p.input.id === input.id);
      if (index < 0) doc.providers.push(next);
      else doc.providers[index] = next;
      doc.removed = doc.removed.filter((id) => id !== input.id);
    });
  }
  legacyBinding(id: string) {
    return this.document.providers.find((p) => p.input.id === id)?.legacyBinding;
  }
  async bindLegacy(id: string, binding: LegacyProviderBinding) {
    await this.change((doc) => {
      const provider = doc.providers.find((p) => p.input.id === id);
      if (!provider) throw new Error("Provider not found");
      provider.legacyBinding = LegacyProviderBindingSchema.parse(binding);
    });
  }
  async touch() {
    await this.change((doc) => {
      doc.runtimeRevision = randomUUID();
    });
  }
  async remove(id: string) {
    if (this.baseline.some((p) => p.name === id && p.oauth))
      throw new Error("Use subscription account management");
    await this.change((doc) => {
      const old =
        doc.providers.find((p) => p.input.id === id)?.input.models ??
        this.baseline.find((p) => p.name === id)?.models ??
        [];
      doc.retiredAliases = [...new Set([...doc.retiredAliases, ...old.map((m) => m.alias)])];
      doc.providers = doc.providers.filter((p) => p.input.id !== id);
      doc.removed = [...new Set([...doc.removed, id])];
    });
  }
  describe() {
    return this.providers()
      .filter((p) => !p.oauth)
      .map((p) => ({
        id: p.name,
        label: this.document.providers.find((v) => v.input.id === p.name)?.input.label ?? p.name,
        type: p.type,
        base_url: p.base_url ?? "",
        models:
          this.document.providers.find((v) => v.input.id === p.name)?.input.models ?? p.models,
        media_account_id: p.media_account_id,
        map_developer_role_to_system: p.map_developer_role_to_system,
        normalize_reasoning_delta_alias: p.normalize_reasoning_delta_alias,
        poolId: p.api_key_pool?.id ?? p.name,
        keyless: !p.api_key_env && !p.api_key_pool,
        managed: this.owns(p.name),
        legacyCredentialAvailable: !!(p.api_key_env && process.env[p.api_key_env]),
      }));
  }
}
