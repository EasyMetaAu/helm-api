import { createHash, randomBytes } from "node:crypto";
import {
  appendMutationList,
  cloneCarrierWithBody,
  isNativePassthroughCarrier,
  type NativePassthroughInput,
  nativePassthroughBody,
} from "@helm/shared";
import { z } from "zod";
import type { ConfigStore } from "../store/ports.js";
import { AnthropicAccountUuidSchema } from "./anthropic-identity.js";
import { CLAUDE_CODE_CLIENT_VERSION } from "./oauth/claude-client-version.generated.js";

const VersionSchema = z.string().regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/);
const DeviceIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
const AccountProfileSchema = z.object({
  deviceId: DeviceIdSchema,
  clientVersion: VersionSchema,
});
export type AnthropicAccountProfile = z.infer<typeof AccountProfileSchema>;
export const AnthropicIdentityContextSchema = z.object({
  owner: z.tuple([z.string().min(1), z.string().min(1)]),
  requestId: z.string().min(1),
  sessionId: z.string().nullable(),
  clientVersion: z.string().nullable().optional(),
});
export type AnthropicIdentityContext = z.infer<typeof AnthropicIdentityContextSchema>;
export type AnthropicAccountProfileResolver = (
  accountUuid: string,
  offeredVersion: string | null,
) => Promise<AnthropicAccountProfile>;

function latestVersion(versions: readonly (string | null | undefined)[]): string {
  let latest: string = CLAUDE_CODE_CLIENT_VERSION;
  for (const candidate of versions) {
    const valid = VersionSchema.safeParse(candidate);
    if (!valid.success) continue;
    const parts = valid.data.split(".").map(Number);
    const current = latest.split(".").map(Number);
    const different = parts.findIndex((part, i) => part !== current[i]);
    if (different >= 0 && (parts[different] ?? 0) > (current[different] ?? 0)) latest = valid.data;
  }
  return latest;
}

/** Public logical IDs, not credentials. Key by verified identity so renames,
 * reconnects and encryption-key rotation do not change the account's device. */
export function createAnthropicAccountProfileResolver(
  config: ConfigStore | undefined,
  initialDeviceId?: string,
): AnthropicAccountProfileResolver {
  return async (accountUuid, offeredVersion) => {
    const uuid = AnthropicAccountUuidSchema.parse(accountUuid);
    if (!config?.compareAndSet)
      throw new Error("Anthropic account profile requires atomic storage");
    const key = `oauth.anthropic_client_profile.v1.${uuid}`;
    for (let attempt = 0; attempt < 8; attempt++) {
      const previous = await config.get(key);
      const stored = previous === null ? null : AccountProfileSchema.parse(JSON.parse(previous));
      const clientVersion = latestVersion([stored?.clientVersion, offeredVersion]);
      if (stored?.clientVersion === clientVersion) return stored;
      let deviceId = stored?.deviceId;
      if (deviceId === undefined && initialDeviceId !== undefined) {
        const seed = DeviceIdSchema.parse(initialDeviceId);
        // A renamed/replaced account can reuse a legacy label. Claim its old
        // device for one verified UUID so another account cannot inherit it.
        const ownerKey = `oauth.anthropic_legacy_device_owner.v1.${seed}`;
        const claimed = await config.compareAndSet(ownerKey, null, uuid);
        if (claimed || (await config.get(ownerKey)) === uuid) deviceId = seed;
      }
      const next = { deviceId: deviceId ?? randomBytes(32).toString("hex"), clientVersion };
      if (await config.compareAndSet(key, previous, JSON.stringify(next))) return next;
    }
    throw new Error("Anthropic account profile changed repeatedly; retry the request");
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function identity(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = record(body.metadata)?.user_id;
  if (typeof value !== "string") return;
  try {
    return record(JSON.parse(value));
  } catch {
    return;
  }
}

function header(input: NativePassthroughInput, name: string): string | undefined {
  if (!isNativePassthroughCarrier(input)) return;
  const entry = Object.entries(input.headers).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === "string" ? entry[1] : undefined;
}

function systemTexts(body: Record<string, unknown>): string[] {
  const system = body.system;
  if (typeof system === "string") return [system];
  return Array.isArray(system)
    ? system.flatMap((block) => {
        const text = record(block)?.text;
        return typeof text === "string" ? [text] : [];
      })
    : [];
}

const BILLING_VERSION = /\bcc_version=(\d+\.\d+\.\d+)(\.[0-9a-f]{3})?(?=;|\s|$)/;
const BILLING_ENTRYPOINT = /\bcc_entrypoint=[a-z][a-z0-9_-]{0,31}(?=;|\s|$)/;
const CLI_UA_VERSION = /\bclaude-cli\/(\d+\.\d+\.\d+)(?=\s|$)/;
const SESSION_HEADERS = ["x-claude-code-session-id", "session_id", "session-id", "x-session-id"];

export function offeredAnthropicClientVersion(
  input: NativePassthroughInput,
  source?: Record<string, unknown>,
  contextVersion?: string | null,
): string {
  const body = nativePassthroughBody(input);
  const billing = source && record(source.metadata)?.client_billing_header;
  return latestVersion([
    contextVersion,
    header(input, "user-agent")?.match(CLI_UA_VERSION)?.[1],
    ...systemTexts(body)
      .filter((text) => text.startsWith("x-anthropic-billing-header:"))
      .map((text) => text.match(BILLING_VERSION)?.[1]),
    typeof billing === "string" ? billing.match(BILLING_VERSION)?.[1] : null,
  ]);
}

export function updateAnthropicUserAgent(value: string, version: string): string {
  if (!CLI_UA_VERSION.test(value)) return value;
  return value
    .replace(CLI_UA_VERSION, `claude-cli/${version}`)
    .replace(/\(external,\s*[a-z][a-z0-9_-]{0,31}(?=[,)])/, "(external, cli");
}

/** Deterministic sessions avoid a per-conversation database. A device is an
 * account namespace; it is never an authentication or authorization proof. */
export function applyAnthropicAccountProfile(
  input: NativePassthroughInput,
  profile: AnthropicAccountProfile,
  accountUuid: string,
  fallbackRequestId: string,
  source?: Record<string, unknown>,
  context?: AnthropicIdentityContext,
): { input: NativePassthroughInput; sessionId: string } {
  const body = nativePassthroughBody(input);
  const original = source ?? body;
  const client = identity(original);
  const meta = record(original.metadata);
  const candidates = [
    client?.session_id,
    ...SESSION_HEADERS.map((name) => header(input, name)),
    meta?.session_id,
    original.session_id,
    original.conversation_id,
    context?.sessionId,
  ];
  const session = candidates.find((value) => typeof value === "string" && value.trim().length > 0);
  const requestId = context?.requestId ?? fallbackRequestId;
  const sessionKey = session ?? requestId;
  const scopedId = (kind: string, id: unknown): string => {
    const namespace = JSON.stringify([accountUuid, context?.owner ?? [], kind, id]);
    const bytes = createHash("sha256")
      .update(profile.deviceId)
      .update(namespace)
      .digest()
      .subarray(0, 16);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const sessionId = scopedId("session", sessionKey);
  const rewriteBilling = (text: string): string =>
    text.startsWith("x-anthropic-billing-header:")
      ? text
          .replace(
            BILLING_VERSION,
            (_match, _version: string, suffix: string | undefined) =>
              `cc_version=${profile.clientVersion}${suffix ?? ""}`,
          )
          .replace(BILLING_ENTRYPOINT, "cc_entrypoint=cli")
      : text;
  const next: Record<string, unknown> = {
    ...body,
    metadata: {
      ...record(body.metadata),
      user_id: JSON.stringify({
        ...identity(body),
        account_uuid: accountUuid,
        device_id: profile.deviceId,
        session_id: sessionId,
      }),
    },
  };
  if (typeof body.system === "string") next.system = rewriteBilling(body.system);
  else if (Array.isArray(body.system))
    next.system = body.system.map((block) => {
      const entry = record(block);
      return entry && typeof entry.text === "string"
        ? { ...entry, text: rewriteBilling(entry.text) }
        : block;
    });
  if (!isNativePassthroughCarrier(input)) return { input: next, sessionId };
  // The request's audit ledger is intentionally shared; body/header identity is
  // copied so concurrent account attempts never overwrite the caller's values.
  appendMutationList(input.mutations, "body_shims_applied", [
    "anthropic_account_identity",
    "anthropic_client_version",
    "anthropic_client_entrypoint",
  ]);
  const headers = { ...input.headers };
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (SESSION_HEADERS.includes(lower)) {
      headers[key] = sessionId;
    } else if (
      typeof value === "string" &&
      (lower === "x-claude-code-agent-id" || lower === "x-claude-code-parent-agent-id")
    ) {
      // Parent references use the same mapping as the agent they refer to.
      headers[key] = scopedId("agent", [sessionKey, value]);
    } else if (typeof value === "string" && lower === "x-claude-code-prompt-id") {
      headers[key] = scopedId("prompt", [sessionKey, value]);
    } else if (
      typeof value === "string" &&
      (lower === "x-client-request-id" || lower === "x-request-id")
    ) {
      headers[key] = scopedId("request", [requestId, value]);
    } else if (lower === "user-agent" && typeof value === "string") {
      headers[key] = updateAnthropicUserAgent(value, profile.clientVersion);
    }
    if (headers[key] !== value) appendMutationList(input.mutations, "headers_overwritten", [lower]);
  }
  return { input: { ...cloneCarrierWithBody(input, next), headers }, sessionId };
}
