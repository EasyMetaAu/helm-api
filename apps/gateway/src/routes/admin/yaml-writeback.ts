import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lane, PoliciesConfig } from "@helm/core";
import type { ClassifierConfig } from "@helm/shared";
import { Document, isMap, parseDocument, type YAMLMap } from "yaml";

// YAML write-back adapter — the "future adapter" foreshadowed in rule-store.ts.
// Admin rule edits (lanes / policies / classifier) persist to config/*.yaml so the
// FILE stays the canonical config (CLAUDE.md principle 2, 配置即代码): a restart
// re-loads exactly what the operator saved, and `docker compose` operators keep a
// single source of truth under ./config.
//
// Three properties the routes rely on:
//   • COMMENT-PRESERVING — the shipped yamls are heavily documented; edits go
//     through the yaml Document API (in-place `setIn` on existing nodes keeps
//     their comments) instead of a destructive parse → dump round-trip.
//   • ATOMIC — write to a same-dir tmp file then rename, so a crash mid-write can
//     never leave a torn file for the next boot's fail-closed loader to reject.
//   • FAIL-CLOSED — any error THROWS to the caller; the RuleStore persists BEFORE
//     rebinding, so a failed write returns 500 with the live config unchanged and
//     file/memory never diverge.
//
// File shapes mirror the loader (packages/core/src/config/loader.ts):
//   lanes.yaml      = FLAT map  (lane name -> lane)  → mounted at config.lanes
//   policies.yaml   = { policies: [...] }            → mounted at config.policies
//   classifier.yaml = { classifier: {...} }          → mounted at config root

export interface YamlRulePersister {
  persistLanes(lanes: Record<string, Lane>): Promise<void>;
  persistPolicies(policies: PoliciesConfig): Promise<void>;
  persistClassifier(cfg: ClassifierConfig): Promise<void>;
}

// Deep-assign a plain object into the document at `path`, key by key, so existing
// nested scalar nodes are UPDATED IN PLACE (their comments survive). Arrays and
// scalars are set wholesale (an array edit replaces the sequence — per-item
// comments inside a replaced list are the documented, accepted loss).
function deepAssign(doc: Document, path: Array<string | number>, value: unknown): void {
  if (isPlainObject(value) && isMap(doc.getIn(path, true))) {
    for (const [k, v] of Object.entries(value)) {
      deepAssign(doc, [...path, k], v);
    }
    // drop keys the new object no longer carries (e.g. a removed optional field)
    const node = doc.getIn(path, true);
    if (isMap(node)) {
      for (const stale of staleKeys(node, value)) doc.deleteIn([...path, stale]);
    }
    return;
  }
  doc.setIn(path, value);
}

function staleKeys(node: YAMLMap, next: Record<string, unknown>): string[] {
  const keep = new Set(Object.keys(next));
  const stale: string[] = [];
  for (const item of node.items) {
    const key = String((item.key as { value?: unknown })?.value ?? item.key);
    if (!keep.has(key)) stale.push(key);
  }
  return stale;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Load the existing document (preserving its comments) or start a fresh one.
function loadDoc(file: string): Document {
  if (existsSync(file)) {
    const doc = parseDocument(readFileSync(file, "utf8"));
    // A torn/invalid file would silently round-trip its errors; refuse instead
    // (fail-closed — the operator must fix the file before admin edits resume).
    if (doc.errors.length > 0) {
      throw new Error(`refusing to edit invalid yaml ${file}: ${doc.errors[0]?.message}`);
    }
    return doc;
  }
  return new Document({});
}

// Atomic write: same-dir tmp + rename. Cleans the tmp on failure (best-effort).
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp never got created (e.g. EACCES on the dir) — nothing to clean
    }
    throw err;
  }
}

export function createYamlRulePersister(configDir: string): YamlRulePersister {
  const persist = (fileName: string, apply: (doc: Document) => void): void => {
    const file = join(configDir, fileName);
    const doc = loadDoc(file);
    apply(doc);
    writeAtomic(file, doc.toString());
  };

  return {
    // lanes.yaml is a flat top-level map: the saved set REPLACES the file's lane
    // set exactly — edited lanes update in place, new lanes append, lanes absent
    // from the save are deleted (the admin delete action must reach the file).
    persistLanes: async (lanes) => {
      persist("lanes.yaml", (doc) => {
        deepAssign(doc, [], lanes);
      });
    },
    persistPolicies: async (policies) => {
      persist("policies.yaml", (doc) => {
        deepAssign(doc, [], { policies: policies.policies });
      });
    },
    persistClassifier: async (cfg) => {
      persist("classifier.yaml", (doc) => {
        deepAssign(doc, ["classifier"], cfg);
      });
    },
  };
}
