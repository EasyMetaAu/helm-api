import {
  restoreSessionRevisionJson,
  type SessionRevisionForRestore,
} from "@helm/shared";
import {
  toDetail,
  type RawDecisionRecord,
  type RequestDetail,
} from "../../../../admin/src/lib/api/requests";
import { apiFetch } from "./client";
export type {
  RequestDetail,
  AttemptErrorDetail,
  ServingAccountView,
  TokenUsageView,
} from "../../../../admin/src/lib/api/requests";
const BASE = "/portal/api/requests";
const ENCODED_PAYLOAD_MEDIA_TYPE = "application/vnd.helm.payload";
async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`requests api ${res.status}`);
  return res.json() as Promise<T>;
}
export async function getRequest(id: string): Promise<RequestDetail> {
  const body = await asJson<{ decision: RawDecisionRecord }>(
    await apiFetch(`${BASE}/${encodeURIComponent(id)}`),
  );
  return toDetail(body.decision);
}
export interface RequestPayloadView {
  captured: boolean;
  source?: "payload" | "session" | "unavailable";
  reason?:
    | "no_session"
    | "metadata_only"
    | "session_unavailable"
    | "session_incomplete"
    | "session_recovery_limited"
    | "response_unavailable";
  exact?: boolean;
  browser_recoverable?: boolean;
  fidelity?: "exact" | "semantic" | "partial" | string;
  request?: unknown;
  response?: unknown;
  // The EXACT body forwarded upstream — AFTER memory injection + protocol
  // translation. This is what the model actually received (the inbound `request`
  // is what the client sent). Null/absent when no provider served or pre-feature.
  upstream_request?: unknown;
  created_at?: number;
  parts?: {
    request: boolean;
    response: boolean;
    upstream_request: boolean;
  };
}

export type RequestPayloadPartName =
  | "request"
  | "response"
  | "upstream_request";

export interface RequestPayloadPartView {
  detached_media?: boolean;
  captured: boolean;
  source?: "payload" | "session" | "unavailable";
  reason?:
    | "no_session"
    | "metadata_only"
    | "session_unavailable"
    | "session_incomplete"
    | "session_recovery_limited"
    | "response_unavailable";
  exact?: boolean;
  fidelity?: "exact" | "semantic" | "partial" | string;
  part?: RequestPayloadPartName;
  value?: unknown;
  created_at?: number;
}

// GET /portal/api/requests/:requestId/payload -> the captured bodies. Resolves to
// { captured:false } on any error (missing row / capture off) so the detail page
// degrades gracefully and never white-screens.
export async function getRequestPayloadMeta(
  requestId: string,
): Promise<RequestPayloadView> {
  try {
    const res = await apiFetch(
      `${BASE}/${encodeURIComponent(requestId)}/payload?part=meta`,
      {
        headers: { accept: "application/json" },
      },
    );
    if (!res.ok) return { captured: false };
    return (await res.json()) as RequestPayloadView;
  } catch {
    return { captured: false };
  }
}

export async function getRequestPayloadPart(
  requestId: string,
  part: RequestPayloadPartName,
): Promise<RequestPayloadPartView> {
  try {
    const res = await apiFetch(
      `${BASE}/${encodeURIComponent(requestId)}/payload?part=${encodeURIComponent(part)}`,
      {
        headers: { accept: `${ENCODED_PAYLOAD_MEDIA_TYPE}, application/json` },
      },
    );
    if (!res.ok) return { captured: false };
    if (res.headers.get("content-type")?.includes(ENCODED_PAYLOAD_MEDIA_TYPE)) {
      const text = await res.text();
      const value = parseMaybeJson(text);
      const createdAtHeader = res.headers.get("x-helm-payload-created-at");
      const createdAt =
        createdAtHeader === null ? Number.NaN : Number(createdAtHeader);
      return {
        captured: true,
        source: "payload",
        exact: true,
        fidelity: "exact",
        part,
        value,
        detached_media: /helm-blob:sha256:[0-9a-f]{64}/.test(text),
        ...(Number.isFinite(createdAt) ? { created_at: createdAt } : {}),
      };
    }
    return (await res.json()) as RequestPayloadPartView;
  } catch {
    return { captured: false };
  }
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export interface SessionRevisionView extends SessionRevisionForRestore {
  sequence: number;
  createdAt: number;
}

export interface SessionRevisionsPageView {
  captured: boolean;
  reason?:
    | "no_session"
    | "metadata_only"
    | "session_unavailable"
    | "session_recovery_limited";
  sessionRef?: string;
  targetRequestId?: string;
  nextSequence?: number | null;
  revisions?: SessionRevisionView[];
}

export interface SessionTimelineEntry {
  recorded_at: string;
  sequence: number;
  request: unknown;
  response: unknown;
}

export interface RebuiltSessionTranscript {
  request: unknown;
  response?: unknown;
  timeline: SessionTimelineEntry[];
}

// GET /portal/api/requests/:id/session-revisions?after=<seq> -> one raw revision page.
export async function getSessionRevisionsPage(
  requestId: string,
  afterSequence?: number,
): Promise<SessionRevisionsPageView> {
  const suffix =
    afterSequence === undefined
      ? ""
      : `?after=${encodeURIComponent(afterSequence)}`;
  try {
    const res = await apiFetch(
      `${BASE}/${encodeURIComponent(requestId)}/session-revisions${suffix}`,
      {
        headers: { accept: "application/json" },
      },
    );
    if (!res.ok) return { captured: false };
    return (await res.json()) as SessionRevisionsPageView;
  } catch {
    return { captured: false };
  }
}

function parseSessionJson(value: string | null | undefined): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

// Walk the keyset cursor only until the requested revision is present, then rebuild
// its request + response and expose the raw revision pairs in recorded-time order.
// Throws on an unavailable/incomplete session so the caller can surface one error.
export async function rebuildSessionTranscript(
  requestId: string,
): Promise<RebuiltSessionTranscript> {
  const revisions: SessionRevisionView[] = [];
  let after: number | undefined;
  let targetRequestId: string | undefined;
  for (;;) {
    const page = await getSessionRevisionsPage(requestId, after);
    if (!page.captured) throw new Error(page.reason ?? "session unavailable");
    targetRequestId = page.targetRequestId ?? requestId;
    if (page.revisions) revisions.push(...page.revisions);
    if (
      page.revisions?.some((revision) => revision.requestId === targetRequestId)
    )
      break;
    const next = page.nextSequence;
    // Stop at the final page, or if the cursor fails to advance (defensive: a stuck
    // cursor would otherwise loop forever).
    if (next === null || next === undefined || next === after) break;
    after = next;
  }
  const target = revisions.find(
    (revision) => revision.requestId === targetRequestId,
  );
  if (!target) throw new Error(`unknown session revision: ${targetRequestId}`);
  const timeline = revisions
    .filter((revision) => revision.sequence <= target.sequence)
    .sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence)
    .map((revision) => ({
      recorded_at: new Date(revision.createdAt).toISOString(),
      sequence: revision.sequence,
      request: parseSessionJson(revision.requestDeltaJson),
      response: parseSessionJson(revision.responseJson),
    }));
  const request = JSON.parse(
    restoreSessionRevisionJson(revisions, targetRequestId),
  ) as unknown;
  return target.responseJson == null
    ? { request, timeline }
    : { request, response: parseSessionJson(target.responseJson), timeline };
}
