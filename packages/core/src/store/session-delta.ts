export interface SessionRequestDelta {
  eventKey: "messages" | "contents" | "input";
  retainCount: number;
  eventsJson: string;
  envelopeJson: string;
  fidelity: "verbatim" | "semantic";
}

const EVENT_KEYS = ["messages", "contents", "input"] as const;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("session request must be a JSON object");
  return value as Record<string, unknown>;
}

function eventKey(request: Record<string, unknown>): SessionRequestDelta["eventKey"] {
  const key = EVENT_KEYS.find((candidate) => candidate in request);
  if (!key) throw new Error("session request has no messages, contents, or input");
  return key;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function prefixLength(previous: unknown[], current: unknown[]): number {
  let n = 0;
  while (
    n < previous.length &&
    n < current.length &&
    JSON.stringify(previous[n]) === JSON.stringify(current[n])
  )
    n++;
  return n;
}

// Split only the client event carrier; every other request field remains in the
// envelope. This deliberately preserves semantics rather than original whitespace.
export function splitSessionRequestJson(
  requestJson: string,
  previousEventsJson?: string,
): SessionRequestDelta {
  const request = record(JSON.parse(requestJson));
  const key = eventKey(request);
  const current = array(request[key]);
  const hasPreviousResponse =
    typeof request.previous_response_id === "string" && request.previous_response_id.trim() !== "";
  const previous = previousEventsJson === undefined ? [] : array(JSON.parse(previousEventsJson));
  const retainCount = hasPreviousResponse ? 0 : prefixLength(previous, current);
  // Keep the carrier with an empty array so recovery can identify its protocol
  // shape without another column (and without a reserved JSON metadata field).
  const envelope = { ...request, [key]: [] };
  return {
    eventKey: key,
    retainCount,
    eventsJson: JSON.stringify(current.slice(retainCount)),
    envelopeJson: JSON.stringify(envelope),
    fidelity: "semantic",
  };
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
