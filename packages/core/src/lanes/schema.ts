import {
  type Lane,
  type LaneConstraints,
  LaneConstraintsSchema,
  LaneSchema,
  type LanesConfig,
  LanesConfigSchema,
  parseLanesConfig,
} from "@helm/shared";
import type { z } from "zod";

// The lane Zod schema is the single source of truth in @helm/shared (so
// HelmConfigSchema validates config against the SAME shape the router consumes;
// schema-first, no duplicate definitions — CLAUDE.md code style). This module
// re-exports it for core's routing code and keeps the checked-in DEFAULT_LANES
// constant, which is a CORE concern (first-boot baseline / fallback), not a
// config shape. See docs/04-routing-and-lanes.md, packages/shared lanes-schema.
export {
  type Lane,
  type LaneConstraints,
  LaneConstraintsSchema,
  LaneSchema,
  type LanesConfig,
  LanesConfigSchema,
  parseLanesConfig,
};

// Checked-in default lanes (docs/04) for first boot and as a test baseline.
// Models use placeholder aliases; the real aliases come from providers.yaml.
export const DEFAULT_LANES = {
  economy: {
    purpose: "Cheap and fast for simple tasks",
    primary: "cheap_model",
    fallback: ["balanced"],
    constraints: {},
  },
  balanced: {
    purpose: "Default quality/cost tradeoff",
    primary: "default_good_model",
    fallback: ["premium", "economy"],
    constraints: {},
  },
  premium: {
    purpose: "Strong reasoning and high quality",
    primary: "best_reasoning_model",
    fallback: ["balanced"],
    constraints: {},
  },
} satisfies Record<string, z.input<typeof LaneSchema>>;
