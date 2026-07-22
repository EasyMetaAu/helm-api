import { createHash } from "node:crypto";
import type { DecisionRecord } from "@helm/shared";

export type SessionCaptureSource =
  | "x-thread-id"
  | "metadata.thread_id"
  | "metadata.conversation_id"
  | "x-session-key"
  | "thread-id"
  | "metadata.user_id.session_id"
  | "session-id";

export interface SessionCapture {
  rawId: string;
  source: SessionCaptureSource;
  fingerprint: string;
  sessionRef: string;
}

export interface SessionCaptureScope {
  accountId: string;
  apiKeyId: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? -1;
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function metadataOf(native: unknown): Record<string, unknown> | null {
  if (!native || typeof native !== "object" || Array.isArray(native)) return null;
  const metadata = (native as Record<string, unknown>).metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !hasControlCharacter(value)
  );
}

function metadataUserSessionId(metadata: Record<string, unknown> | null): unknown {
  const userId = metadata?.user_id;
  if (typeof userId !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(userId);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return (parsed as Record<string, unknown>).session_id;
  } catch {
    return undefined;
  }
}

/** Resolves an explicitly supplied client conversation identifier for transcript capture. */
export function resolveSessionCapture(
  headerGet: (name: string) => string | undefined,
  native: unknown,
  scope: SessionCaptureScope,
): SessionCapture | null {
  const metadata = metadataOf(native);
  const candidates: Array<[SessionCaptureSource, unknown]> = [
    ["x-thread-id", headerGet("x-thread-id")],
    ["metadata.thread_id", metadata?.thread_id],
    ["metadata.conversation_id", metadata?.conversation_id],
    ["x-session-key", headerGet("x-session-key")],
    ["thread-id", headerGet("thread-id")],
    ["metadata.user_id.session_id", metadataUserSessionId(metadata)],
    ["session-id", headerGet("session-id")],
  ];
  const candidate = candidates.find(([, value]) => value !== undefined);
  if (!candidate || !validId(candidate[1])) return null;

  const [source, rawId] = candidate;
  return {
    rawId,
    source,
    fingerprint: hash(rawId),
    sessionRef: hash(JSON.stringify([scope.accountId, scope.apiKeyId, source, rawId])),
  };
}

export function stampSessionCapture(
  decision: DecisionRecord,
  session: SessionCapture | null,
): void {
  decision.session = session
    ? { ref: session.sessionRef, label: session.rawId, source: session.source }
    : null;
}
