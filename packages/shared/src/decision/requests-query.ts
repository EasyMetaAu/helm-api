import { z } from "zod";
import { AttemptStatusSchema, DecidedBySchema } from "./schema.js";

// Query model for the admin request-debug list (GET /admin/api/requests). The
// Debug UI drives pagination + the error/role filters through this surface, and a
// read endpoint must NEVER 5xx on a malformed querystring (a stale bookmark, a
// hand-typed param): every field is `.catch(...)` so a garbage value degrades to a
// safe default instead of throwing. Single source of truth via z.infer.
//
// Filtering is split by where the data lives: `status` rides the denormalized
// telemetry.final_status column; `decided_by`/`lane` are extracted from generated
// columns; `model` is a contains search over requested model, served model alias,
// and lane/channel text; `start`/`end` bound created_at as a
// half-open window [start, end) — mirroring TelemetryStore.queryWindow so adjacent
// windows never overlap.

export const REQUESTS_PAGE_SIZE_DEFAULT = 50;
export const REQUESTS_PAGE_SIZE_MAX = 200;

// Coerce a querystring scalar to a positive int, falling back to `fallback` for
// anything non-numeric / ≤0 / fractional. `.catch` guarantees no throw.
const positiveInt = (fallback: number) => z.coerce.number().int().positive().catch(fallback);

// Optional free-text filter: trims, and treats an empty string as "not set"
// (undefined) so `?lane=` is the same as omitting it.
const optionalText = z.string().trim().min(1).optional().catch(undefined);

// Optional epoch-ms bound. Non-numeric / negative → undefined (unbounded).
const optionalEpochMs = z.coerce.number().int().nonnegative().optional().catch(undefined);

export const RequestsQuerySchema = z.object({
  page: positiveInt(1),
  // Clamp to [1, MAX] AFTER coercion so an absurd ?pageSize=100000 can't ask the
  // store for an unbounded scan; junk → the default.
  pageSize: z.coerce
    .number()
    .int()
    .positive()
    .transform((n) => Math.min(n, REQUESTS_PAGE_SIZE_MAX))
    .catch(REQUESTS_PAGE_SIZE_DEFAULT),
  status: AttemptStatusSchema.optional().catch(undefined),
  decided_by: DecidedBySchema.optional().catch(undefined),
  lane: optionalText,
  // Contains search, not exact matching. Store adapters match requested_model,
  // final.model_alias, and the selected lane/channel so operators can type a
  // partial public model or route name from the requests table.
  model: optionalText,
  // Exact api_key_id scope (the key detail page's request list). Unlike `lane`/
  // `model` (substring), the store matches this with equality — it is an internal
  // id, not free text. Same fail-open trim-empty→unset handling.
  key_id: optionalText,
  // Opaque tenant-scoped session reference. Raw client Session IDs never enter
  // query strings, access logs, or browser history.
  session_ref: optionalText,
  start: optionalEpochMs,
  end: optionalEpochMs,
});

export type RequestsQuery = z.infer<typeof RequestsQuerySchema>;
