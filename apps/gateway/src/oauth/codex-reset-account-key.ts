import { codexAccountIdFromToken, parseOpenAICodexIdentity } from "@helm/core";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function codexResetCreditSharedKey(input: {
  providerId: string;
  account: string;
  accessToken: string | null;
  metadata: Readonly<Record<string, unknown>>;
}): string {
  const tokenIdentity =
    input.accessToken === null ? {} : parseOpenAICodexIdentity(input.accessToken);
  const accountId =
    nonEmptyString(input.metadata.accountId) ??
    nonEmptyString(tokenIdentity.accountId) ??
    (input.accessToken === null
      ? null
      : nonEmptyString(codexAccountIdFromToken(input.accessToken)));
  if (accountId !== null) return `codex:${accountId}`;

  const chatgptUserId =
    nonEmptyString(input.metadata.chatgptUserId) ?? nonEmptyString(tokenIdentity.chatgptUserId);
  if (chatgptUserId !== null) return `codex-user:${chatgptUserId}`;

  const email =
    nonEmptyString(input.metadata.email)?.trim().toLowerCase() ??
    nonEmptyString(tokenIdentity.email)?.trim().toLowerCase();
  return email ? `codex-email:${email}` : `${input.providerId} ${input.account}`;
}
