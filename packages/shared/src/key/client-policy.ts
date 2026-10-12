import { z } from "zod";

export const ClientIdSchema = z.enum([
  "codex_app",
  "codex_cli",
  "claude_cli",
  "claude_desktop",
  "grok_cli",
]);
export type ClientId = z.infer<typeof ClientIdSchema>;
export const CLIENT_LABELS: Record<ClientId, string> = {
  codex_app: "Codex App",
  codex_cli: "Codex CLI",
  claude_cli: "Claude CLI",
  claude_desktop: "Claude Desktop",
  grok_cli: "Grok CLI",
};
export const ClientPolicySchema = z
  .object({
    allowed_clients: z
      .array(ClientIdSchema)
      .min(1)
      .max(5)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate clients are not allowed"),
  })
  .strict();
export type ClientPolicy = z.infer<typeof ClientPolicySchema>;

// These are observed product tokens, not authentication proofs. Versions are
// deliberately not pinned; ambiguity and malformed headers fail closed.
const profiles: Record<ClientId, RegExp> = {
  codex_app: /(?:^| )Codex Desktop\/\d+\.\d+[\w.+-]*(?= |$)/,
  codex_cli: /(?:^| )(?:codex-tui|codex_exec|codex_cli_rs)\/\d+\.\d+[\w.+-]*(?= |$)/,
  claude_cli: /(?:^| )claude-cli\/\d+\.\d+[\w.+-]* \(external, (?:sdk-cli|cli)\)(?= |$)/,
  claude_desktop: /(?:^| )Claude\/\d+\.\d+[\w.+-]*(?= |$)/,
  grok_cli: /(?:^| )grok-shell\/\d+\.\d+[\w.+-]*(?= |$)/,
};
export function classifyClient(userAgent: string | null | undefined): ClientId | null {
  if (!userAgent || userAgent.length > 4096) return null;
  for (let i = 0; i < userAgent.length; i++) {
    const code = userAgent.charCodeAt(i);
    if (code < 32 || code === 127) return null;
  }
  const matches = ClientIdSchema.options.filter((id) => profiles[id].test(userAgent));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
export function evaluateClientPolicy(
  policy: unknown,
  userAgent: string | null | undefined,
): {
  allowed: boolean;
  client: ClientId | null;
  reason: string;
} {
  if (policy === null || policy === undefined)
    return { allowed: true, client: null, reason: "disabled" };
  const parsed = ClientPolicySchema.safeParse(policy);
  const client = classifyClient(userAgent);
  if (!parsed.success) return { allowed: false, client, reason: "invalid_policy" };
  const allowed = client !== null && parsed.data.allowed_clients.includes(client);
  return {
    allowed,
    client,
    reason: allowed ? "allowed" : client ? "client_not_selected" : "unknown_client",
  };
}
