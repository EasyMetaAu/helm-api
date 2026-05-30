import {
  CapabilitiesOverrideSchema,
  type CatalogEntry,
  type GeneratedCatalog,
  PricingOverrideSchema,
} from "@helm/shared";
import type { z } from "zod";

// Runtime catalog assembly: generated (supply-chain input) + manual overrides.
// Merge rule: manual entries WIN — per-field override of capabilities/pricing,
// and overrides may introduce brand-new modelKeys (manual can add, not just
// patch). NOTE: this module is framework-/network-free (principle 1 + "never
// fetch at runtime"); generated data is read from a checked-in file by the
// caller and passed in here.

export class CatalogError extends Error {
  readonly issues: z.core.$ZodIssue[];
  constructor(message: string, issues: z.core.$ZodIssue[] = []) {
    super(message);
    this.name = "CatalogError";
    this.issues = issues;
  }
}

export interface LoadCatalogDeps {
  generated: GeneratedCatalog;
  capabilitiesOverride: unknown; // raw config/capabilities.yaml content
  pricingOverride: unknown; // raw config/pricing.yaml content
}

// Validate an override blob fail-closed; error carries path + message only,
// never the offending value (principle 7 / docs/02).
function parseOverride<T>(schema: z.ZodType<T>, raw: unknown, file: string): T {
  if (raw === undefined || raw === null) {
    return schema.parse({});
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new CatalogError(`Invalid override in ${file}`, result.error.issues);
  }
  return result.data;
}

export function loadCatalog(deps: LoadCatalogDeps): Map<string, CatalogEntry> {
  const capsOverride = parseOverride(
    CapabilitiesOverrideSchema,
    deps.capabilitiesOverride,
    "capabilities.yaml",
  );
  const priceOverride = parseOverride(PricingOverrideSchema, deps.pricingOverride, "pricing.yaml");

  const result = new Map<string, CatalogEntry>();

  // 1. Seed from generated entries.
  for (const entry of deps.generated.models) {
    result.set(entry.modelKey, {
      modelKey: entry.modelKey,
      capabilities: { ...entry.capabilities },
      pricing: { ...entry.pricing },
      source: "generated",
    });
  }

  // 2. Apply capability overrides (per-field win; may introduce new keys).
  const overriddenKeys = new Set<string>();
  for (const [modelKey, caps] of Object.entries(capsOverride)) {
    const existing = result.get(modelKey);
    if (existing) {
      existing.capabilities = { ...existing.capabilities, ...caps };
    } else {
      result.set(modelKey, {
        modelKey,
        capabilities: {
          supportsTools: false,
          supportsJsonMode: false,
          supportsVision: false,
          supportsStreaming: false,
          maxContextTokens: 0,
          maxOutputTokens: null,
          ...caps,
        },
        pricing: { inputPerMTokUsd: null, outputPerMTokUsd: null },
        source: "override",
      });
    }
    overriddenKeys.add(modelKey);
  }

  // 3. Apply pricing overrides (per-field win; may introduce new keys).
  for (const [modelKey, price] of Object.entries(priceOverride)) {
    const existing = result.get(modelKey);
    if (existing) {
      existing.pricing = { ...existing.pricing, ...price };
    } else {
      result.set(modelKey, {
        modelKey,
        capabilities: {
          supportsTools: false,
          supportsJsonMode: false,
          supportsVision: false,
          supportsStreaming: false,
          maxContextTokens: 0,
          maxOutputTokens: null,
        },
        pricing: {
          inputPerMTokUsd: null,
          outputPerMTokUsd: null,
          ...price,
        },
        source: "override",
      });
    }
    overriddenKeys.add(modelKey);
  }

  // 4. Mark any generated entry touched by an override as "override" so the
  //    debug UI can explain provenance.
  for (const modelKey of overriddenKeys) {
    const entry = result.get(modelKey);
    if (entry) entry.source = "override";
  }

  return result;
}
