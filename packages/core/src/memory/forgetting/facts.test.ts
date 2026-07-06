import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildReconciledFactBatch,
  factContentHash,
  normalizeFactText,
  normalizeSubjectKey,
} from "./facts.js";

// docs/12 P6 — the two DETERMINISTIC pure helpers behind fact extraction +
// dedup/supersede. subject_key derivation and content_hash are the "fuzzy bit"
// the spec resolves as deterministic-from-tags/subject (open question:
// "deterministic normalization vs LLM-assigned. v1: deterministic"). Both are
// leaf, no-network, no-clock pure functions — exhaustively unit-testable, so a
// reflection that ran twice over the same observations produces the SAME
// subject_key + hash and dedups idempotently (UNIQUE(owner_id, content_hash)).

describe("normalizeSubjectKey (deterministic subject derivation, docs/12 P6)", () => {
  it("lowercases, trims, and collapses internal whitespace to single dashes", () => {
    expect(normalizeSubjectKey("  Project   Helm  ")).toBe("project-helm");
  });

  it("strips characters that are not alphanumeric or dash", () => {
    // Punctuation, quotes, slashes — all removed; surviving alnum joined by dash.
    expect(normalizeSubjectKey("User's favourite: TypeScript!")).toBe("users-favourite-typescript");
  });

  it("collapses runs of separators (whitespace + stripped punctuation) into one dash", () => {
    expect(normalizeSubjectKey("a  --  b")).toBe("a-b");
    expect(normalizeSubjectKey("a / b / c")).toBe("a-b-c");
  });

  it("is idempotent: normalizing an already-normalized key is a no-op", () => {
    const once = normalizeSubjectKey("Deploy Target Region");
    expect(normalizeSubjectKey(once)).toBe(once);
    expect(once).toBe("deploy-target-region");
  });

  it("trims leading/trailing dashes that fall out of edge punctuation", () => {
    expect(normalizeSubjectKey("!!hello!!")).toBe("hello");
    expect(normalizeSubjectKey("-already-dashed-")).toBe("already-dashed");
  });

  it("preserves existing dashes and digits", () => {
    expect(normalizeSubjectKey("gpt-5.4 model")).toBe("gpt-54-model");
  });

  it("caps the key length so a base64 blob can't become a ~2000-char subject", () => {
    // A whitespace-free blob (e.g. a base64 image the deterministic fallback dumped)
    // collapses to one giant "word"; the cap bounds it and leaves no trailing dash.
    const blob = "a".repeat(500) + "b".repeat(500);
    const key = normalizeSubjectKey(blob);
    expect(key.length).toBeLessThanOrEqual(80);
    expect(key.endsWith("-")).toBe(false);
    // Real topics are well under the cap and untouched.
    expect(normalizeSubjectKey("favorite number")).toBe("favorite-number");
  });
});

describe("buildReconciledFactBatch blob guard (no base64/image facts)", () => {
  const base = { ownerId: "acct", scope: {}, cap: 8, fallbackNow: new Date("2026-06-26") };

  it("drops a candidate whose text is a long whitespace-free blob", () => {
    const blob = `data:image/jpeg;base64,${"ABCD".repeat(300)}`; // no spaces, ~1200 chars
    const facts = buildReconciledFactBatch({
      ...base,
      extracted: [{ subjectText: "img", factText: blob }],
    });
    expect(facts).toEqual([]);
  });

  it("keeps a normal sentence fact (has whitespace)", () => {
    const facts = buildReconciledFactBatch({
      ...base,
      extracted: [
        { subjectText: "favorite number", factText: "The user's favorite number is 42." },
      ],
    });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.subjectKey).toBe("favorite-number");
  });
});

describe("normalizeFactText (the hash pre-image, docs/12 P6)", () => {
  it("lowercases, trims, and collapses internal whitespace — but keeps punctuation", () => {
    // Unlike the subject key, the fact-text normalization does NOT strip
    // punctuation: it only canonicalizes case + whitespace so trivially-equal
    // assertions hash identically. The text itself stays human-readable.
    expect(normalizeFactText("  The user   PREFERS  dark-mode. ")).toBe(
      "the user prefers dark-mode.",
    );
  });
});

describe("factContentHash (sha256 idempotent-ingest key, docs/12 P6)", () => {
  it("is the sha256 of the normalized fact text", () => {
    const text = "  User likes   TypeScript ";
    const expected = createHash("sha256").update(normalizeFactText(text)).digest("hex");
    expect(factContentHash(text)).toBe(expected);
  });

  it("hashes case/whitespace-variant fact texts to the SAME hash (dedup pre-image)", () => {
    const a = factContentHash("User likes TypeScript");
    const b = factContentHash("  user   LIKES   typescript  ");
    expect(a).toBe(b);
  });

  it("hashes genuinely different facts to DIFFERENT hashes", () => {
    expect(factContentHash("User likes TypeScript")).not.toBe(factContentHash("User likes Rust"));
  });
});
