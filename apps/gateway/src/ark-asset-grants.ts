import { randomUUID } from "node:crypto";
import type { ConfigStore, KeyStore } from "@helm/core";
import { ArkAssetIdSchema } from "@helm/shared";
import { z } from "zod";

const Asset = z.strictObject({
  assetId: ArkAssetIdSchema,
  mediaType: z.enum(["image", "video", "audio"]),
});
export type ArkAssetReference = z.infer<typeof Asset>;
export const ArkAssetGrantInput = z.strictObject({
  revision: z.string().uuid().nullable(),
  providerName: z.string().min(1).max(128),
  attestation: z.literal("same-account-project-enrolled"),
  assets: z.array(Asset).max(100),
});
const Document = ArkAssetGrantInput.extend({
  revision: z.string().uuid(),
  accountId: z.string(),
  keyId: z.string(),
  providerScope: z.string().min(1),
  attestedAt: z.string().datetime(),
});
type Document = z.infer<typeof Document>;
export class ArkAssetAccessError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
const unavailable = () => new ArkAssetAccessError(503, "Asset authorization unavailable");
export class ArkAssetGrants {
  constructor(
    private readonly config: ConfigStore,
    private readonly keys: Pick<KeyStore, "getById">,
    private readonly scope: (provider: string) => string | undefined,
  ) {}
  private async load(keyId: string): Promise<{ raw: string | null; doc: Document | null }> {
    try {
      const raw = await this.config.get(`ark-asset-grants:${keyId}`);
      return { raw, doc: raw === null ? null : Document.parse(JSON.parse(raw)) };
    } catch {
      throw unavailable();
    }
  }
  private public(doc: Document | null) {
    if (!doc) return { revision: null, assets: [], active: false };
    const { providerScope, ...safe } = doc;
    return { ...safe, active: this.scope(doc.providerName) === providerScope };
  }
  async read(keyId: string) {
    return this.public((await this.load(keyId)).doc);
  }
  async replace(keyId: string, input: z.infer<typeof ArkAssetGrantInput>) {
    const key = await this.keys.getById(keyId);
    if (!key || key.disabled || key.suspended)
      throw new ArkAssetAccessError(404, "Active key not found");
    const providerScope = this.scope(input.providerName);
    if (!providerScope || !this.config.compareAndSet) throw unavailable();
    const { raw, doc } = await this.load(keyId);
    if ((doc?.revision ?? null) !== input.revision)
      throw new ArkAssetAccessError(409, "Asset grants changed; read again");
    const next: Document = {
      ...input,
      revision: randomUUID(),
      accountId: key.account_id,
      keyId,
      providerScope,
      attestedAt: new Date().toISOString(),
    };
    let saved: boolean;
    try {
      saved = await this.config.compareAndSet(
        `ark-asset-grants:${keyId}`,
        raw,
        JSON.stringify(next),
      );
    } catch {
      throw unavailable();
    }
    if (!saved) throw new ArkAssetAccessError(409, "Asset grants changed; read again");
    return this.public(next);
  }
  async authorize(
    identity: { accountId: string; keyId: string },
    providerName: string,
    providerScope: string | undefined,
    assets: ArkAssetReference[],
  ) {
    const { doc } = await this.load(identity.keyId);
    if (
      !doc ||
      doc.accountId !== identity.accountId ||
      doc.keyId !== identity.keyId ||
      doc.providerName !== providerName ||
      !providerScope ||
      doc.providerScope !== providerScope ||
      assets.some(
        (a) => !doc.assets.some((g) => g.assetId === a.assetId && g.mediaType === a.mediaType),
      )
    )
      throw new ArkAssetAccessError(403, "Asset access denied");
  }
}
