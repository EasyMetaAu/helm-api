import { makeAnthropicError, makeGeminiError, makeOpenAIError } from "@helm/core";
import { evaluateClientPolicy, makeHelmError } from "@helm/shared";
import type { Context } from "hono";
import type { AppEnv } from "../app.js";

export function clientPolicyError(c: Context<AppEnv>, policy: unknown, keyId: string) {
  const result = evaluateClientPolicy(policy, c.req.header("user-agent"));
  if (result.allowed) return null;
  const traceId = c.get("trace_id") ?? "unknown";
  c.get("logger")?.log("warn", "client_policy_denied", {
    key_id: keyId,
    trace_id: traceId,
    client: result.client,
    reason: result.reason,
  });
  return makeHelmError({
    error_class: "client_not_allowed",
    message: "This API key does not allow this client.",
    trace_id: traceId,
  });
}

export function clientPolicyRejection(
  c: Context<AppEnv>,
  identity: { keyId: string; caps?: { clientPolicy?: unknown } },
  protocol: "openai" | "anthropic" | "gemini" = "openai",
): Response | null {
  const error = clientPolicyError(c, identity.caps?.clientPolicy, identity.keyId);
  if (!error) return null;
  const mapped =
    protocol === "anthropic"
      ? makeAnthropicError(error)
      : protocol === "gemini"
        ? makeGeminiError(error)
        : makeOpenAIError(error);
  return c.json(mapped.body, 403);
}
