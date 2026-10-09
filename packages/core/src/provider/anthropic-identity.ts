import { z } from "zod";

export const AnthropicAccountUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const ClientIdentitySchema = z.object({ account_uuid: z.unknown().optional() });

/** A local boundary rejection, not an upstream response or provider health fault. */
export class AnthropicIdentityError extends Error {
  override readonly name = "AnthropicIdentityError";
  constructor(
    message = "Claude request account does not match a verified OAuth account; reconnect or select the matching account",
  ) {
    super(message);
  }
}

export class AnthropicOAuthIdentityChangedError extends Error {
  override readonly name = "AnthropicOAuthIdentityChangedError";
  constructor() {
    super("Anthropic OAuth identity changed; reconnect the account");
  }
}

export function anthropicRequestAccountUuid(body: Record<string, unknown>): string | undefined {
  const metadata = body.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
  const userId = (metadata as Record<string, unknown>).user_id;
  if (typeof userId !== "string") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(userId);
  } catch {
    return;
  } // Opaque application user IDs remain valid.
  const identity = ClientIdentitySchema.safeParse(parsed);
  if (
    !identity.success ||
    identity.data.account_uuid === undefined ||
    identity.data.account_uuid === ""
  )
    return;
  const uuid = AnthropicAccountUuidSchema.safeParse(identity.data.account_uuid);
  if (!uuid.success)
    throw new AnthropicIdentityError("Claude request contains an invalid account UUID");
  return uuid.data;
}

export function assertAnthropicAccountIdentity(
  body: Record<string, unknown>,
  metadata: Readonly<Record<string, unknown>>,
): void {
  const asserted = anthropicRequestAccountUuid(body);
  if (!asserted) return;
  const verified = AnthropicAccountUuidSchema.safeParse(metadata.anthropicAccountUuid);
  if (!verified.success || verified.data !== asserted) throw new AnthropicIdentityError();
}
