import {
  appendMutationList,
  cloneCarrierWithBody,
  type InternalRequest,
  isNativePassthroughCarrier,
  type NativePassthroughCarrier,
  nativePassthroughBody,
} from "@helm/shared";

const OPENAI_FAST_SERVICE_TIERS = new Set(["priority", "fast"]);
const ANTHROPIC_FAST_BETA = "fast-mode-2026-02-01";

function isOpenAIFastTier(value: unknown): boolean {
  return typeof value === "string" && OPENAI_FAST_SERVICE_TIERS.has(value.toLowerCase());
}

function downgradeBodyFastMode(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  changed: boolean;
  fixes: string[];
} {
  let next = body;
  const fixes: string[] = [];
  if (isOpenAIFastTier(next.service_tier)) {
    next = { ...next, service_tier: "default" };
    fixes.push("client_fast_service_tier_downgraded");
  }
  if (next.speed === "fast") {
    next = { ...next, speed: "standard" };
    fixes.push("client_fast_speed_downgraded");
  }
  return { body: next, changed: next !== body, fixes };
}

function downgradeNativeFastMode(
  native: InternalRequest["native_request"],
): InternalRequest["native_request"] {
  if (native === undefined) return undefined;
  const body = nativePassthroughBody(native);
  const downgraded = downgradeBodyFastMode(body);
  if (!isNativePassthroughCarrier(native)) return downgraded.body;
  const stripped = stripAnthropicFastBeta(native);
  if (!downgraded.changed && !stripped.changed) return native;
  const carrier = cloneCarrierWithBody(native, downgraded.body, {
    preserveRawBody: !downgraded.changed,
  });
  carrier.headers = stripped.headers;
  appendMutationList(carrier.mutations, "body_shims_applied", [
    ...downgraded.fixes,
    ...(stripped.changed ? ["client_fast_beta_header_downgraded"] : []),
  ]);
  appendMutationList(carrier.mutations, "headers_dropped", stripped.dropped);
  appendMutationList(carrier.mutations, "headers_overwritten", stripped.overwritten);
  return carrier;
}

function stripAnthropicFastBeta(carrier: NativePassthroughCarrier): {
  headers: NativePassthroughCarrier["headers"];
  changed: boolean;
  dropped: string[];
  overwritten: string[];
} {
  let headers = carrier.headers;
  const dropped: string[] = [];
  const overwritten: string[] = [];

  for (const [name, value] of Object.entries(carrier.headers)) {
    if (name.toLowerCase() !== "anthropic-beta") continue;
    const tokens = (Array.isArray(value) ? value : [value])
      .flatMap((part) => part.split(","))
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const kept = tokens.filter((part) => part.toLowerCase() !== ANTHROPIC_FAST_BETA);
    if (kept.length === tokens.length) continue;

    headers = headers === carrier.headers ? { ...carrier.headers } : headers;
    if (kept.length === 0) {
      delete headers[name];
      dropped.push(name.toLowerCase());
    } else {
      headers[name] = kept.join(", ");
      overwritten.push(name.toLowerCase());
    }
  }

  return { headers, changed: headers !== carrier.headers, dropped, overwritten };
}

// Enforces the API-key cap for CLIENT-requested Fast mode only. Account-level
// Fast mode is injected later by the per-account provider client and deliberately
// wins over this downgrade.
export function downgradeClientFastModeIfDisallowed(
  req: InternalRequest,
  allowClientFastMode: boolean | undefined,
): InternalRequest {
  if (allowClientFastMode === true) return req;
  let next = req;

  if (isOpenAIFastTier(req.service_tier)) {
    next = { ...next, service_tier: "default" };
  }

  if (req.provider_raw?.speed === "fast") {
    next = {
      ...next,
      provider_raw: {
        ...req.provider_raw,
        speed: "standard",
      },
    };
  }

  const downgradedNative = downgradeNativeFastMode(next.native_request);
  if (downgradedNative !== next.native_request) {
    next =
      downgradedNative === undefined ? { ...next } : { ...next, native_request: downgradedNative };
  }

  return next;
}
