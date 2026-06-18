import { createHash } from "node:crypto";
import type { MemoryFactInput } from "@helm/shared";

// docs/12 P6 — the DETERMINISTIC pure helpers behind fact extraction +
// dedup/supersede. These are leaf functions (no LLM, no network, no clock read),
// exactly like the forgetting score: a reflection that ran twice over the same
// observations must derive the SAME subject_key + content_hash so the
// account-scoped UNIQUE(owner_id, content_hash) dedups idempotently and the
// same-(owner_id, subject_key) supersede targets the same logical fact.
//
// The spec's one fuzzy bit — "`subject_key` derivation … deterministic
// normalization (lowercased tag + entity slug) vs LLM-assigned" — is RESOLVED
// here as deterministic-from-tags/subject for v1 (CLAUDE.md: "subject_key …
// DETERMINISTICALLY"); the LLM-assigned variant stays gated behind
// consolidate.enable_llm_supersede (off, out of scope for P6).

// Normalize a subject string into a stable supersede key (docs/12 P6). Pure,
// deterministic, applied in the EXACT order CLAUDE.md specifies — "lowercase,
// trim, collapse whitespace to '-', strip non-alphanumeric-dash":
//   1. lowercase + trim;
//   2. collapse any run of whitespace to a single dash (the word separator);
//   3. strip every remaining char that is not [a-z0-9-] — so intra-word
//      punctuation is DELETED (joins the neighbours), not turned into a gap;
//   4. collapse dash runs + trim edge dashes left by steps 2–3.
// Order matters: collapsing whitespace BEFORE stripping punctuation means
// "User's favourite: TypeScript!" → "users-favourite-typescript" and
// "gpt-5.4 model" → "gpt-54-model" (the apostrophe / dot vanish, the space is
// the only separator). A re-run reproduces the slug byte-for-byte, so two
// extractions of the same topic land on the same (owner_id, subject_key) and the
// newer one supersedes the older (pure datetime UPDATE, no LLM). Input that
// strips to nothing yields "".
export function normalizeSubjectKey(subject: string): string {
  return (
    subject
      .toLowerCase()
      .trim()
      // Whitespace runs are the word boundary → single dash.
      .replace(/\s+/g, "-")
      // Strip everything that is not alnum-or-dash (intra-word punctuation is
      // deleted, joining the neighbours rather than splitting them).
      .replace(/[^a-z0-9-]+/g, "")
      // Fold any dash runs that survived + trim leading/trailing dashes.
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

// Canonicalize fact text into the hash PRE-IMAGE (docs/12 P6). UNLIKE the subject
// key, this keeps punctuation: it only folds case + collapses internal whitespace
// so trivially-equal assertions ("User likes TS" vs "  user   likes TS ") hash
// identically. The stored fact_text stays human-readable; only the hash input is
// normalized. Deterministic + pure.
export function normalizeFactText(factText: string): string {
  return factText.trim().toLowerCase().replace(/\s+/g, " ");
}

// content_hash = sha256(normalized_fact_text), hex (docs/12 "Schema deltas":
// `content_hash = sha256(normalized_text) — idempotent ingest`; "content_hash
// idempotent dedup" borrowed from Mem0). One pure-function column kills memory
// bloat from repeated facts: the same assertion, however it is cased/spaced,
// produces one row per (owner_id, content_hash).
export function factContentHash(factText: string): string {
  return createHash("sha256").update(normalizeFactText(factText)).digest("hex");
}

// One raw fact candidate from an extractor (structural — assignable from both the
// Reflector's observation-sourced ExtractedFact and the Observer's raw-message
// eager extractor, without importing either, so this leaf stays cycle-free).
export interface FactBatchCandidate {
  subjectText: string;
  factText: string;
  validFrom?: Date; // when the fact became true; falls back to `fallbackNow`
  sourceObservationRange?: [string, string]; // audit trail (absent for raw-sourced facts)
}

// docs/12 P6 — turn raw extractor output into the deterministic, capped, supersede-
// ordered MemoryFactInput batch the store reconciles. Shared by the Reflector
// (observation→fact) and the Observer's salient-fact fast path (raw→fact) so BOTH
// derive subject_key + content_hash identically and apply max_facts_per_subject the
// same way (the supersede/dedup keys never depend on the LLM). Pure + deterministic:
//   - subject_key + content_hash from the pure helpers above;
//   - validFrom defaults to `fallbackNow` (the raw extractor has no observation time);
//   - per subject_key, keep the `cap` NEWEST (validFrom DESC, original-index tiebreak),
//     then re-emit OLDEST-first so the store's `valid_from < new.valid_from` supersede
//     settles to the newest active fact;
//   - subjects are emitted in sorted key order so the batch is reproducible.
export function buildReconciledFactBatch(input: {
  extracted: readonly FactBatchCandidate[];
  ownerId: string;
  scope: { projectId?: string; resourceId?: string; threadId?: string };
  cap: number;
  fallbackNow: Date;
}): MemoryFactInput[] {
  const { extracted, ownerId, scope, cap, fallbackNow } = input;
  const candidates = extracted
    .map((e, index) => ({
      subjectKey: normalizeSubjectKey(e.subjectText),
      factText: e.factText,
      validFrom: e.validFrom ?? fallbackNow,
      sourceObservationRange: e.sourceObservationRange,
      index, // original order — the stable tiebreak when validFrom ties
    }))
    .filter((c) => c.subjectKey.length > 0 && c.factText.trim().length > 0);

  const bySubject = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const group = bySubject.get(c.subjectKey);
    if (group === undefined) bySubject.set(c.subjectKey, [c]);
    else group.push(c);
  }

  const facts: MemoryFactInput[] = [];
  for (const subjectKey of [...bySubject.keys()].sort()) {
    const group = bySubject.get(subjectKey) ?? [];
    const kept = group
      .slice()
      .sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime() || a.index - b.index)
      .slice(0, cap) // the `cap` NEWEST
      .sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime() || a.index - b.index); // re-emit oldest-first
    for (const c of kept) {
      facts.push({
        ownerId,
        subjectKey,
        factText: c.factText,
        contentHash: factContentHash(c.factText),
        validFrom: c.validFrom,
        ...(c.sourceObservationRange !== undefined
          ? { sourceObservationRange: c.sourceObservationRange }
          : {}),
        ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
        ...(scope.resourceId !== undefined ? { resourceId: scope.resourceId } : {}),
        ...(scope.threadId !== undefined ? { threadId: scope.threadId } : {}),
      });
    }
  }
  return facts;
}
