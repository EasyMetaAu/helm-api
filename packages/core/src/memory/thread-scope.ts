// Physical Memory thread identifiers. The client-visible thread id is not a
// sufficient storage key: two API keys in one account use different effective
// projects by default, while keys explicitly assigned to the same project are
// expected to share Memory. Keep that contract in one framework-free helper so
// observe, inject, MCP, workers, migrations, and tests cannot drift.

const PROJECT_SCOPED_PREFIX = "v2:";
const QUARANTINED_PREFIX = `${PROJECT_SCOPED_PREFIX}q:`;
// Malformed historical jobs have no trustworthy tenant. Migrations rewrite
// their scope to this synthetic owner plus a per-job q:r thread; open rows are
// failed, while completed audit rows remain parseable by Admin JSON queries.
export const MALFORMED_JOB_QUARANTINE_ACCOUNT_ID = "helm:quarantine:malformed-memory-job";

function utf8Hex(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function utf8FromHex(value: string): string | null {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < value.length; i += 2) {
    bytes[i / 2] = Number.parseInt(value.slice(i, i + 2), 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// Legacy (pre-v2) physical id. Exported only for migration/compatibility tests;
// new request-path code must use projectScopedThreadId.
export function ownerScopedThreadId(accountId: string, threadId: string): string {
  return `${encodeURIComponent(accountId)}:${encodeURIComponent(threadId)}`;
}

// v2 format:
//   project present: v2:p:<utf8-project-hex>:<legacy-owner-thread-id>
//   project absent:  v2:n:<legacy-owner-thread-id>
//
// Hex keeps every delimiter unambiguous in both SQLite and Postgres migrations.
// The explicit `n` sentinel prevents a null project from colliding with any real
// project string. The legacy suffix retains the account boundary and lets an
// upgrade rewrite an existing row without recovering the original client id.
export function projectScopedThreadId(
  accountId: string,
  projectId: string | null,
  threadId: string,
): string {
  const legacyId = ownerScopedThreadId(accountId, threadId);
  return projectId === null
    ? `${PROJECT_SCOPED_PREFIX}n:${legacyId}`
    : `${PROJECT_SCOPED_PREFIX}p:${utf8Hex(projectId)}:${legacyId}`;
}

// Migration-only quarantine namespaces. Historical parent rows and standalone
// facts/reflections are deliberately separated: a long-tier `thread_id` could
// have meant either a parent FK or a raw opaque client id before scope v2, and
// treating one as the other would make contaminated content reachable again.
// Both the account and payload are UTF-8 hex so the encoding is deterministic,
// delimiter-safe, reversible for operator views, and isolated across owners.
export function quarantinedParentThreadId(accountId: string, legacyParentId: string): string {
  return `${QUARANTINED_PREFIX}p:${utf8Hex(accountId)}:${utf8Hex(legacyParentId)}`;
}

export function quarantinedRawThreadId(accountId: string, rawThreadId: string): string {
  return `${QUARANTINED_PREFIX}r:${utf8Hex(accountId)}:${utf8Hex(rawThreadId)}`;
}

export function quarantinedMalformedJobThreadId(jobId: string): string {
  return quarantinedRawThreadId(MALFORMED_JOB_QUARANTINE_ACCOUNT_ID, `job:${jobId}`);
}

function clientIdFromOwnerScopedId(legacyId: string, accountId: string): string | null {
  const ownerPrefix = `${encodeURIComponent(accountId)}:`;
  if (!legacyId.startsWith(ownerPrefix)) return null;
  try {
    return decodeURIComponent(legacyId.slice(ownerPrefix.length));
  } catch {
    return null;
  }
}

// Decode a trusted Store field for a management response. Never call this on
// client input: client thread ids are opaque and may legitimately resemble a
// Helm physical id. Non-physical/direct store ids remain untouched when the
// optional account prefix does not prove the legacy owner-scoped shape.
export function clientThreadIdFromStorageId(threadId: string, accountId?: string): string {
  const quarantineMatch = /^v2:q:([pr]):([0-9a-f]*):([0-9a-f]*)$/i.exec(threadId);
  if (quarantineMatch !== null) {
    const [, kind, ownerHex, payloadHex] = quarantineMatch;
    const storedOwner = utf8FromHex(ownerHex ?? "");
    const payload = utf8FromHex(payloadHex ?? "");
    if (storedOwner === null || payload === null) return threadId;
    if (accountId !== undefined && accountId !== storedOwner) return threadId;
    if (kind === "r") return payload;
    return clientIdFromOwnerScopedId(payload, storedOwner) ?? payload;
  }

  let legacyId = threadId;
  let physicalId = false;
  const projectMatch = /^v2:p:[0-9a-f]*:(.+)$/.exec(threadId);
  if (projectMatch?.[1] !== undefined) {
    legacyId = projectMatch[1];
    physicalId = true;
  } else {
    const nullMatch = /^v2:n:(.+)$/.exec(threadId);
    if (nullMatch?.[1] !== undefined) {
      legacyId = nullMatch[1];
      physicalId = true;
    }
  }
  if (accountId !== undefined) {
    return clientIdFromOwnerScopedId(legacyId, accountId) ?? threadId;
  } else if (!physicalId) {
    return threadId;
  }
  const separator = legacyId.indexOf(":");
  if (separator < 0) return threadId;
  try {
    return decodeURIComponent(legacyId.slice(separator + 1));
  } catch {
    return threadId;
  }
}
