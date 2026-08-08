// Pure row-selection for the STREAMING session-revision page (client-side rebuild).
// Dialect-agnostic so the sqlite and postgres adapters share one implementation of
// the load-bearing rule: every page returns at least one row and always advances the
// cursor, so a large session can never dead-end the client. maxBytes is a soft
// ceiling, NOT an all-or-nothing gate (that is listSessionRevisionsPage's job).

export interface SessionPageRowMeta {
  sequence: number;
  // UTF-8 wire bytes; may be NaN/negative for legacy binary rows the DB can't measure.
  bytes: number;
}

// Given up to `limit + 1` ordered rows, return the sequences to include in this page.
// - Always include the first row (even if it alone exceeds maxBytes — the client holds it).
// - After ≥1 row is selected, stop before the row that would breach maxBytes.
// - Never exceed `limit` rows.
// Unmeasurable bytes (legacy binary: NaN/negative) count as 0 so the row is still
// returned — streaming favors "give the client the row" over precise accounting.
export function selectStreamingSessionRevisions(
  ordered: readonly SessionPageRowMeta[],
  limit: number,
  maxBytes: number,
): number[] {
  const selected: number[] = [];
  let usedBytes = 0;
  for (const row of ordered.slice(0, limit)) {
    const raw = Number(row.bytes);
    const bytes = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
    if (selected.length > 0 && usedBytes + bytes > maxBytes) break;
    selected.push(row.sequence);
    usedBytes += bytes;
  }
  return selected;
}

// ponytail: inline self-check for the two load-bearing branches (single oversized row
// still returned; soft ceiling stops without dropping selected rows).
export function __sessionPageSelfCheck(): void {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`session-page self-check: ${msg}`);
  };
  // Single row far over maxBytes is still selected.
  assert(
    JSON.stringify(selectStreamingSessionRevisions([{ sequence: 1, bytes: 999 }], 10, 1)) === "[1]",
    "oversized single row must be returned",
  );
  // Soft ceiling: row 1 fits, row 2 would breach → stop after row 1.
  assert(
    JSON.stringify(
      selectStreamingSessionRevisions(
        [
          { sequence: 1, bytes: 30 },
          { sequence: 2, bytes: 30 },
        ],
        10,
        40,
      ),
    ) === "[1]",
    "soft ceiling must stop before breaching row without dropping selected",
  );
  // Legacy unmeasurable bytes count as 0 → row still selected.
  assert(
    JSON.stringify(selectStreamingSessionRevisions([{ sequence: 1, bytes: Number.NaN }], 10, 1)) ===
      "[1]",
    "legacy unmeasurable row must be returned",
  );
}
