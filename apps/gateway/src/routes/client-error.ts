import type { AttemptErrorDetail } from "@helm/shared";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function identifier(value: unknown): string | undefined {
  const candidate = typeof value === "number" ? String(value) : text(value);
  return candidate && /^[\w.:[\]-]{1,160}$/.test(candidate) ? candidate : undefined;
}
function safeMessage(value: string): string {
  return value
    .split(/\r?\n\s*(?:at\s|Traceback\b|File ["'])/, 1)[0]!
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b(?:Bearer|Basic)\s+[\w+/=.-]+/gi, "[redacted]")
    .replace(/\b(?:sk-|helm_live_)[\w-]+/g, "[redacted]")
    .replace(
      /\b(authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gi,
      "$1=[redacted]",
    )
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 1800);
}

/** Project an already credential-scrubbed diagnostic, never its payload, headers or stack. */
export function clientErrorMessage(
  detail: AttemptErrorDetail | null | undefined,
  fallback: string,
  includeMessage = true,
): string {
  if (!detail) return fallback;
  const raw = record(detail.provider_raw);
  const response = record(raw?.response);
  const base = record(raw?.base_resp);
  const error = record(raw?.error) ?? record(response?.error) ?? base ?? raw;
  const message = text(error?.message) ?? text(error?.status_msg) ?? text(response?.message);
  const localReason = detail.message.includes("oauth pool has no schedulable account")
    ? "No provider account is currently available"
    : /attempt exceeded per-attempt timeout \(\d+ms\)/.test(detail.message)
      ? detail.message
      : undefined;
  const reason = includeMessage ? (message ?? localReason) : undefined;
  const code = identifier(error?.code ?? error?.status_code);
  const param = identifier(error?.param);
  const requestId =
    identifier(detail.provider_headers?.["x-request-id"]) ??
    identifier(detail.provider_headers?.["request-id"]) ??
    identifier(detail.provider_headers?.["x-tt-logid"]) ??
    identifier(raw?.request_id ?? raw?.requestId ?? response?.request_id ?? error?.request_id);
  const metadata = [
    detail.upstream_status != null ? `upstream HTTP ${detail.upstream_status}` : null,
    code ? `code=${code}` : null,
    param ? `param=${param}` : null,
    requestId ? `upstream_request_id=${requestId}` : null,
  ].filter(Boolean);
  // Internal/transport Error.message may expose local paths or proxy configuration.
  // Only an actual upstream message is selected; otherwise retain the caller's public summary.
  const summary =
    reason && !fallback.includes(reason)
      ? `${safeMessage(fallback)}: ${safeMessage(reason)}`
      : safeMessage(fallback);
  return metadata.length ? `${summary} [${metadata.join("; ")}]` : summary;
}
