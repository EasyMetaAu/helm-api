import { createHash } from "node:crypto";
import { type ConfigStore, makeProxyFetch, type ProxyConfig } from "@helm/core";
import { type AccountTimezoneView, IanaTimezoneSchema } from "@helm/shared";
import { z } from "zod";
import { getAccountSettings, loadAccountSettings } from "./account-settings.js";

type Detection = Omit<AccountTimezoneView, "override">;
const services = [
  {
    url: "https://ipwho.is/",
    source: "ipwho.is" as const,
    schema: z
      .object({ success: z.literal(true), timezone: z.object({ id: IanaTimezoneSchema }) })
      .transform((value) => value.timezone.id),
  },
  {
    url: "https://api.ipapi.is/",
    source: "ipapi.is" as const,
    schema: z
      .object({ location: z.object({ timezone: IanaTimezoneSchema }), error: z.never().optional() })
      .transform((value) => value.location.timezone),
  },
];

// No account ids, auth headers, prompts or explicit IP parameters are sent. Each
// service geolocates the connection it sees, through the SAME pinned proxy. Do
// not persist the IP or proxy credentials in diagnostics/cache keys.
export function createEgressTimezoneResolver(
  deps: { makeFetch?: (proxy?: ProxyConfig) => typeof globalThis.fetch; now?: () => number } = {},
) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; result: Promise<Detection> }>();
  return (proxy?: ProxyConfig): Promise<Detection> => {
    const key = createHash("sha256")
      .update(JSON.stringify(proxy ?? null))
      .digest("hex");
    const prior = cache.get(key);
    if (prior && prior.expiresAt > now()) return prior.result;
    const entry = {
      expiresAt: now() + 15 * 60_000,
      result: Promise.resolve<Detection>({ effective: null, source: "unknown", checkedAt: null }),
    };
    entry.result = (async (): Promise<Detection> => {
      const doFetch = (deps.makeFetch ?? ((p) => (p ? makeProxyFetch(p) : globalThis.fetch)))(
        proxy,
      );
      for (const service of services) {
        try {
          const response = await doFetch(service.url, {
            method: "GET",
            headers: { accept: "application/json" },
            credentials: "omit",
            redirect: "error",
            signal: AbortSignal.timeout(2_000),
          });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            continue;
          }
          // Bound response memory even when an external endpoint is faulty.
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let text = "";
          let size = 0;
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > 32_768) throw new Error("oversized geolocation response");
              text += decoder.decode(part.value, { stream: true });
            }
            text += decoder.decode();
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          const parsed = service.schema.safeParse(JSON.parse(text));
          if (parsed.success)
            return { effective: parsed.data, source: service.source, checkedAt: now() };
        } catch {
          /* Bounded failover; never log provider response or proxy secrets. */
        }
      }
      entry.expiresAt = now() + 60_000;
      return { effective: null, source: "unknown", checkedAt: now() };
    })().catch(() => {
      entry.expiresAt = now() + 60_000;
      return { effective: null, source: "unknown", checkedAt: now() };
    });
    if (cache.size >= 256) cache.delete(cache.keys().next().value ?? "");
    cache.set(key, entry);
    return entry.result;
  };
}

const detectEgressTimezone = createEgressTimezoneResolver();

export async function getAccountTimezone(
  config: ConfigStore,
  encKey: Buffer,
  providerId: string,
  account: string,
  pinnedProxy?: ProxyConfig,
  detect = detectEgressTimezone,
): Promise<AccountTimezoneView> {
  const settings = getAccountSettings(
    await loadAccountSettings(config, encKey),
    providerId,
    account,
  );
  const override = IanaTimezoneSchema.safeParse(settings.timezone);
  if (override.success)
    return { override: override.data, effective: override.data, source: "manual", checkedAt: null };
  return { override: null, ...(await detect(pinnedProxy)) };
}
