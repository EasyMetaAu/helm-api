import { createHash, randomUUID } from "node:crypto";
import {
  type ApiKeyAccountInput,
  ApiKeyAccountInputSchema,
  type ApiKeyAccountPatch,
  ApiKeyAccountPatchSchema,
  type ApiKeyAccountView,
  ApiKeyAccountViewSchema,
  type Protocol,
} from "@helm/shared";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../store/crypto/token-cipher.js";
import type { ConfigStore } from "../store/ports.js";
import { guardPreOutputFailure, preOutputClassifierFor } from "./failover-guard.js";
import { createOAuthPoolClient, type OAuthPoolMember } from "./oauth/pool.js";
import { type ProviderClient, UpstreamError } from "./openai.js";

const DAY = 86_400_000;
const AccountSchema = ApiKeyAccountViewSchema.omit({ mask: true }).extend({
  key: z.string(),
  generation: z.string(),
  fingerprint: z.string(),
  probeId: z.string().nullable(),
});
const DocumentSchema = z.object({
  accounts: z.array(AccountSchema),
  strategy: z.enum(["round_robin", "manual_priority"]).optional(),
});
type Account = z.infer<typeof AccountSchema>;
type Document = z.infer<typeof DocumentSchema>;
export interface ApiKeyAttempt {
  id: string;
  generation: string;
  key: string;
  probeId: string | null;
}

/** Calendar boundary in the operator's IANA zone, including DST/year rollover. */
export function nextMonthlyRetry(now: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = (at: number) =>
    Object.fromEntries(formatter.formatToParts(at).map((p) => [p.type, p.value]));
  const current = parts(now);
  const target = Date.UTC(Number(current.year), Number(current.month), 1);
  let utc = target;
  for (let i = 0; i < 4; i++) {
    const p = parts(utc);
    const wall = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
    utc += target - wall;
  }
  return utc;
}

function record(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function errorCode(error: unknown): string {
  if (!(error instanceof UpstreamError)) return "";
  const raw = record(error.providerRaw);
  const inner = record(raw.error);
  const response = record(record(raw.response).error);
  for (const value of [inner.code, response.code, raw.code, inner.type, response.type]) {
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}
const BILLING = new Set([
  "credit_balance_exhausted",
  "insufficient_quota",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "usage_limit_exceeded",
]);
function failureKind(error: unknown): "billing" | "rate" | "invalid" | "model" | null {
  const code = errorCode(error);
  if (BILLING.has(code)) return "billing";
  if (code === "invalid_api_key" || code === "account_deactivated") return "invalid";
  if (code === "model_not_found" || code === "model_not_allowed") return "model";
  if (error instanceof UpstreamError && error.upstreamStatus === 429) return "rate";
  return null;
}
class AccountUnavailable extends UpstreamError {
  constructor() {
    super("upstream_error", "API key account is unavailable before send", {
      code: "api_key_account_unavailable",
    });
  }
}

/** One encrypted config row, updated with CAS in both SQL adapters. No plaintext persisted. */
export class ApiKeyAccounts {
  private readonly storageKey: string;
  private snapshot: Document | null = null;
  readonly now: () => number;
  constructor(
    private readonly deps: {
      store: ConfigStore;
      encKey: Buffer;
      poolId: string;
      timezone: string;
      now?: () => number;
      probeLeaseMs?: number;
    },
  ) {
    this.storageKey = `provider.api_keys.${deps.poolId}`;
    this.now = deps.now ?? Date.now;
  }
  async refresh(): Promise<void> {
    const raw = await this.deps.store.get(this.storageKey);
    this.snapshot =
      raw === null ? null : DocumentSchema.parse(JSON.parse(decryptSecret(raw, this.deps.encKey)));
  }
  strategy(
    fallback: "round_robin" | "manual_priority" = "round_robin",
  ): "round_robin" | "manual_priority" {
    return this.snapshot?.strategy ?? fallback;
  }
  async setStrategy(strategy: "round_robin" | "manual_priority"): Promise<void> {
    await this.mutate((doc) => {
      doc.strategy = strategy;
    });
  }
  configured(): boolean {
    return this.snapshot !== null;
  }
  entries(): readonly Account[] {
    return this.snapshot?.accounts ?? [];
  }
  eligible(id: string): boolean {
    const a = this.entries().find((a) => a.id === id);
    return (
      a !== undefined &&
      a.enabled &&
      a.state !== "invalid" &&
      (a.nextRetryAt ?? 0) <= this.now() &&
      (a.probeUntil ?? 0) <= this.now()
    );
  }
  private async mutate<T>(change: (doc: Document) => T): Promise<T> {
    if (!this.deps.store.compareAndSet)
      throw new Error("API key pools require atomic config persistence");
    for (let i = 0; i < 20; i++) {
      const raw = await this.deps.store.get(this.storageKey);
      const doc =
        raw === null
          ? { accounts: [] }
          : DocumentSchema.parse(JSON.parse(decryptSecret(raw, this.deps.encKey)));
      const result = change(doc);
      const next = encryptSecret(JSON.stringify(doc), this.deps.encKey);
      if (await this.deps.store.compareAndSet(this.storageKey, raw, next)) {
        this.snapshot = doc;
        return result;
      }
    }
    throw new Error("API key pool changed concurrently; retry the operation");
  }
  async list(): Promise<ApiKeyAccountView[]> {
    await this.refresh();
    return this.entries().map((a) =>
      ApiKeyAccountViewSchema.parse({ ...a, mask: `••••${a.key.slice(-4)}` }),
    );
  }
  async add(inputs: ApiKeyAccountInput[]): Promise<void> {
    const validated = z.array(ApiKeyAccountInputSchema).min(1).max(50).parse(inputs);
    await this.mutate((doc) => {
      for (const input of validated) {
        const fingerprint = createHash("sha256").update(input.key).digest("hex");
        if (doc.accounts.some((a) => a.fingerprint === fingerprint))
          throw new Error("API key is already in this pool");
        doc.accounts.push({
          id: randomUUID(),
          name: input.name,
          key: input.key,
          fingerprint,
          generation: randomUUID(),
          enabled: true,
          priority: 50,
          models: null,
          state: "ready",
          reason: null,
          nextRetryAt: null,
          probeUntil: null,
          probeId: null,
          deniedModels: [],
        });
      }
    });
  }
  async update(id: string, input: ApiKeyAccountPatch): Promise<void> {
    const patch = ApiKeyAccountPatchSchema.parse(input);
    await this.mutate((doc) => {
      const a = doc.accounts.find((a) => a.id === id);
      if (!a) throw new Error("API key account not found");
      if (patch.key !== undefined) {
        const fingerprint = createHash("sha256").update(patch.key).digest("hex");
        if (doc.accounts.some((other) => other.id !== id && other.fingerprint === fingerprint))
          throw new Error("API key is already in this pool");
        Object.assign(a, {
          fingerprint,
          generation: randomUUID(),
          state: "ready",
          reason: null,
          nextRetryAt: null,
          probeId: null,
          probeUntil: null,
          deniedModels: [],
        });
      }
      Object.assign(a, patch);
    });
  }
  async remove(id: string): Promise<void> {
    await this.mutate((doc) => {
      doc.accounts = doc.accounts.filter((a) => a.id !== id);
    });
  }
  async retry(id: string): Promise<void> {
    await this.mutate((doc) => {
      const a = doc.accounts.find((a) => a.id === id);
      if (!a) throw new Error("API key account not found");
      if (a.state === "invalid") throw new Error("Replace the invalid API key before retrying");
      a.nextRetryAt = this.now();
      a.deniedModels = [];
      // Do not clear a live probe or manual pause. A real request must prove recovery.
    });
  }
  async acquire(id: string, model?: string): Promise<ApiKeyAttempt | null> {
    await this.refresh();
    if (!this.eligible(id)) return null;
    const a = this.entries().find((a) => a.id === id)!;
    const allowsModel = (account: Account) =>
      model === undefined ||
      ((account.models === null || account.models.includes(model)) &&
        !account.deniedModels.includes(model));
    if (!allowsModel(a)) return null;
    if (a.state === "ready") return { id, generation: a.generation, key: a.key, probeId: null };
    return this.mutate((doc) => {
      const current = doc.accounts.find((a) => a.id === id);
      if (
        !current ||
        !current.enabled ||
        !allowsModel(current) ||
        current.state === "invalid" ||
        (current.nextRetryAt ?? 0) > this.now() ||
        (current.probeUntil ?? 0) > this.now()
      )
        return null;
      current.probeId = randomUUID();
      current.probeUntil = this.now() + (this.deps.probeLeaseMs ?? 600_000);
      return { id, generation: current.generation, key: current.key, probeId: current.probeId };
    });
  }
  async settle(attempt: ApiKeyAttempt, error: unknown | null, model?: string): Promise<void> {
    const kind = failureKind(error);
    if (attempt.probeId === null && kind === null) return;
    await this.mutate((doc) => {
      const a = doc.accounts.find((a) => a.id === attempt.id);
      if (!a || a.generation !== attempt.generation) return;
      if (attempt.probeId !== null && a.probeId !== attempt.probeId) return;
      if (a.state === "invalid" && kind !== "invalid") return;
      const exhaustedProbe = attempt.probeId !== null && a.state === "quota_exhausted";
      if (kind === "billing") {
        a.state = "quota_exhausted";
        a.nextRetryAt = attempt.probeId
          ? this.now() + DAY
          : nextMonthlyRetry(this.now(), this.deps.timezone);
      } else if (kind === "invalid") {
        a.state = "invalid";
        a.nextRetryAt = null;
      } else if (kind === "rate") {
        // A billing pause cannot be shortened by a concurrent rate-limit response.
        if (a.state !== "quota_exhausted") {
          a.state = "cooldown";
          const headers = error instanceof UpstreamError ? error.upstreamHeaders : null;
          const raw = Object.entries(headers ?? {}).find(
            ([key]) => key.toLowerCase() === "retry-after",
          )?.[1];
          const seconds = raw === undefined ? NaN : Number(raw);
          const until = Number.isFinite(seconds)
            ? this.now() + Math.max(0, seconds) * 1000
            : Date.parse(raw ?? "");
          a.nextRetryAt = Math.max(
            a.nextRetryAt ?? 0,
            Number.isFinite(until) ? until : this.now() + 60_000,
          );
        }
      } else if (kind === "model" && model) {
        if (!a.deniedModels.includes(model)) a.deniedModels.push(model);
      } else if (attempt.probeId) {
        if (error === null) {
          a.state = "ready";
          a.reason = null;
          a.nextRetryAt = null;
        } else a.nextRetryAt = this.now() + 60_000;
      }
      if (exhaustedProbe && error !== null && kind !== "invalid") {
        a.state = "quota_exhausted";
        a.nextRetryAt = Math.max(a.nextRetryAt ?? 0, this.now() + DAY);
      }
      if (kind) a.reason = errorCode(error) || kind;
      if (attempt.probeId === null && (kind === "billing" || kind === "invalid")) {
        a.probeId = null;
        a.probeUntil = null;
      }
      if (attempt.probeId) {
        a.probeId = null;
        a.probeUntil = null;
      }
    });
  }
}

/** Credentials and durable lifecycle wrap clients; the existing pool owns protocol/affinity/failover. */
export function createApiKeyPoolClient(deps: {
  accounts: ApiKeyAccounts;
  models: readonly string[];
  protocol: Protocol;
  createClient: (key: string) => ProviderClient;
  legacyClient?: ProviderClient;
  strategy?: "round_robin" | "manual_priority";
  onSelect?: (id: string) => void;
}): ProviderClient {
  let signature = "";
  let pool: ProviderClient;
  const template = deps.createClient("unavailable-api-key-pool");
  const streamMethods = new Set(["chatCompletionStream", "nativePassthroughStream"]);
  function wrap(id: string, generation: string, base: ProviderClient): ProviderClient {
    return new Proxy(base, {
      get(target, property, receiver) {
        const method: unknown = Reflect.get(target, property, receiver);
        if (typeof method !== "function" || property === "closeResponsesWebSocketSession")
          return method;
        const stream = streamMethods.has(String(property));
        const modelOf = (args: unknown[]) => {
          const body = record(args[0]);
          const model = body.model ?? record(body.body).model;
          return typeof model === "string" ? model : undefined;
        };
        if (stream)
          return async function* (...args: unknown[]) {
            const attempt = await deps.accounts.acquire(id, modelOf(args));
            if (!attempt || attempt.generation !== generation) throw new AccountUnavailable();
            let settled = false;
            try {
              const raw = Reflect.apply(method, target, args) as AsyncIterable<string>;
              const classifier = preOutputClassifierFor(
                property === "chatCompletionStream" ? "openai_chat" : deps.protocol,
              );
              for await (const chunk of classifier ? guardPreOutputFailure(raw, classifier) : raw) {
                if (!settled) {
                  await deps.accounts.settle(attempt, null);
                  settled = true;
                }
                yield chunk;
              }
              if (!settled) {
                await deps.accounts.settle(attempt, null);
                settled = true;
              }
            } catch (error) {
              await deps.accounts.settle(attempt, error, modelOf(args));
              settled = true;
              throw error;
            } finally {
              if (!settled) await deps.accounts.settle(attempt, new Error("request cancelled"));
            }
          };
        return async (...args: unknown[]) => {
          const attempt = await deps.accounts.acquire(id, modelOf(args));
          if (!attempt || attempt.generation !== generation) throw new AccountUnavailable();
          try {
            const result: unknown = await Reflect.apply(method, target, args);
            await deps.accounts.settle(attempt, null);
            return result;
          } catch (error) {
            await deps.accounts.settle(attempt, error, modelOf(args));
            throw error;
          }
        };
      },
    });
  }
  async function current(): Promise<ProviderClient> {
    await deps.accounts.refresh();
    if (!deps.accounts.configured() && deps.legacyClient) return deps.legacyClient;
    const accounts = deps.accounts.entries();
    const nextSignature = accounts.map((a) => `${a.id}:${a.generation}`).join("|");
    if (!pool || signature !== nextSignature) {
      const members: OAuthPoolMember[] = accounts.map((a) => ({
        account: `${a.id}@${a.generation}`,
        get priority() {
          return deps.accounts.strategy(deps.strategy) === "manual_priority"
            ? (deps.accounts.entries().find((row) => row.id === a.id)?.priority ?? 50)
            : 50;
        },
        get schedulable() {
          return deps.accounts.eligible(a.id);
        },
        get models() {
          const row = deps.accounts.entries().find((row) => row.id === a.id);
          return deps.models.filter(
            (m) =>
              (row?.models === null || row?.models.includes(m)) && !row?.deniedModels.includes(m),
          );
        },
        client: wrap(a.id, a.generation, deps.createClient(a.key)),
      }));
      pool = createOAuthPoolClient({
        members,
        now: deps.accounts.now,
        rotateIndependentRequests: true,
        upstreamCredentialFailureStatuses: [],
        shouldRetryAccountError: (error) =>
          error instanceof AccountUnavailable || failureKind(error) !== null,
        onSelect: (id) => deps.onSelect?.(id),
      });
      signature = nextSignature;
    }
    return pool;
  }
  return new Proxy(template, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== "function") return method;
      const invoke = async (args: unknown[]) => {
        const active = await current();
        const fn: unknown = Reflect.get(active, property);
        if (typeof fn !== "function")
          throw new UpstreamError(
            "upstream_error",
            `API key pool does not support ${String(property)}`,
          );
        return Reflect.apply(fn, active, args) as unknown;
      };
      if (streamMethods.has(String(property)))
        return async function* (...args: unknown[]) {
          const iterable = (await invoke(args)) as AsyncIterable<string>;
          yield* iterable;
        };
      return (...args: unknown[]) => invoke(args);
    },
  });
}
