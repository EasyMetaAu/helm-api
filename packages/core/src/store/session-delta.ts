import { createHash } from "node:crypto";
import type { SessionEventHead } from "./ports.js";

// Read-side reconstruction moved to @helm/shared (browser-safe, zero node builtins)
// so the admin UI can rebuild transcripts client-side. Re-exported here to keep the
// core barrel and existing callers unchanged.
export {
  restoreSessionRequestJson,
  restoreSessionRevisionJson,
  type SessionRevisionForRestore,
} from "@helm/shared";

export interface SessionRequestDelta {
  eventKey: "messages" | "contents" | "input";
  retainCount: number;
  eventsJson: string;
  envelopeJson: string;
  fidelity: "verbatim" | "semantic";
  previousResponseId: string | null;
  eventCount: number;
  eventHash: string;
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

function hashEvents(events: readonly unknown[], count = events.length): string {
  const hash = createHash("sha256");
  hash.update("[");
  for (let index = 0; index < count; index++) {
    if (index > 0) hash.update(",");
    hash.update(JSON.stringify(events[index]) ?? "null");
  }
  hash.update("]");
  return hash.digest("hex");
}

// Split only the client event carrier; every other request field remains in the
// envelope. This deliberately preserves semantics rather than original whitespace.
export function splitSessionRequestJson(
  requestJson: string,
  previousHead?: Omit<SessionEventHead, "requestId">,
): SessionRequestDelta {
  const request = record(JSON.parse(requestJson));
  const key = eventKey(request);
  const current = array(request[key]);
  const hasPreviousResponse =
    typeof request.previous_response_id === "string" && request.previous_response_id.trim() !== "";
  const previousResponseId = hasPreviousResponse ? (request.previous_response_id as string) : null;
  const retainCount =
    !hasPreviousResponse &&
    previousHead !== undefined &&
    previousHead.eventKey === key &&
    previousHead.eventCount <= current.length &&
    hashEvents(current, previousHead.eventCount) === previousHead.eventHash
      ? previousHead.eventCount
      : 0;
  // Keep the carrier with an empty array so recovery can identify its protocol
  // shape without another column (and without a reserved JSON metadata field).
  const envelope = { ...request, [key]: [] };
  return {
    eventKey: key,
    retainCount,
    eventsJson: JSON.stringify(current.slice(retainCount)),
    envelopeJson: JSON.stringify(envelope),
    fidelity: "semantic",
    previousResponseId,
    eventCount: current.length,
    eventHash: hashEvents(current),
  };
}
