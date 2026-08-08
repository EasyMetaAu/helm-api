// Read-side session transcript reconstruction. Pure JSON patching with ZERO node
// builtins, so it runs identically in the gateway and in the admin browser bundle.
// The write-side splitter (splitSessionRequestJson) stays in @helm/core because it
// depends on node:crypto; it reuses restoreSessionRequestJson from here.

const EVENT_KEYS = ["messages", "contents", "input"] as const;

type EventKey = (typeof EVENT_KEYS)[number];

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("session request must be a JSON object");
  return value as Record<string, unknown>;
}

function eventKey(request: Record<string, unknown>): EventKey {
  const key = EVENT_KEYS.find((candidate) => candidate in request);
  if (!key) throw new Error("session request has no messages, contents, or input");
  return key;
}

export function restoreSessionRequestJson(envelopeJson: string, eventsJson: string): string {
  const envelope = record(JSON.parse(envelopeJson));
  return JSON.stringify({ ...envelope, [eventKey(envelope)]: JSON.parse(eventsJson) });
}

export interface SessionRevisionForRestore {
  requestId: string;
  parentRequestId: string | null;
  retainCount: number;
  requestDeltaJson: string;
  requestEnvelopeJson: string;
  responseId?: string | null;
  responseJson?: string | null;
}

function persistedEvents(json: string): unknown[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error("session revision delta must be an array");
  return value;
}

function previousResponseId(envelopeJson: string): string | null {
  const envelope = record(JSON.parse(envelopeJson));
  const value = envelope.previous_response_id;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function responseOutput(responseJson: string | null | undefined): unknown[] {
  if (!responseJson) throw new Error("session response output unavailable");
  const response = record(JSON.parse(responseJson));
  if (!Array.isArray(response.output)) throw new Error("session response output unavailable");
  return response.output;
}

// Reconstruct one revision by walking its explicit parent chain, so a branch never
// accidentally borrows the most-recent sibling's prefix.
export function restoreSessionRevisionJson(
  revisions: readonly SessionRevisionForRestore[],
  requestId: string,
): string {
  const byId = new Map(revisions.map((revision) => [revision.requestId, revision]));
  const revision = byId.get(requestId);
  if (!revision) throw new Error(`unknown session revision: ${requestId}`);
  const chain: SessionRevisionForRestore[] = [];
  const seen = new Set<string>();
  let current: SessionRevisionForRestore | undefined = revision;
  while (current) {
    if (seen.has(current.requestId)) throw new Error("session revision cycle");
    seen.add(current.requestId);
    chain.push(current);
    if (current.parentRequestId === null) break;
    current = byId.get(current.parentRequestId);
    if (!current) throw new Error(`unknown session revision: ${chain.at(-1)?.parentRequestId}`);
  }

  let events: unknown[] = [];
  let parent: SessionRevisionForRestore | null = null;
  for (const item of chain.reverse()) {
    if (!Number.isInteger(item.retainCount) || item.retainCount < 0)
      throw new Error("invalid session retain_count");
    const delta = persistedEvents(item.requestDeltaJson);
    const previousId = previousResponseId(item.requestEnvelopeJson);
    if (previousId !== null) {
      if (item.parentRequestId === null || !parent)
        throw new Error("session continuation parent unavailable");
      if (item.retainCount !== 0) throw new Error("invalid session continuation retain_count");
      if ("responseId" in parent && parent.responseId !== previousId)
        throw new Error("session continuation response mismatch");
      events = [...events, ...responseOutput(parent.responseJson), ...delta];
    } else if (item.parentRequestId === null) {
      events = delta;
    } else {
      if (item.retainCount > events.length) throw new Error("invalid session retain_count");
      events = [...events.slice(0, item.retainCount), ...delta];
    }
    parent = item;
  }
  const restored = record(
    JSON.parse(restoreSessionRequestJson(revision.requestEnvelopeJson, JSON.stringify(events))),
  );
  if (previousResponseId(revision.requestEnvelopeJson) !== null)
    delete restored.previous_response_id;
  return JSON.stringify(restored);
}
