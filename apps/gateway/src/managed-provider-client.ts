import { createHash } from "node:crypto";
import { type ApiKeyAccounts, type ProviderClient, UpstreamError } from "@helm/core";
import type { ProviderParameters } from "@helm/shared";
import type { LegacyProviderBinding } from "./managed-providers.js";
export type ManagedAccount = ReturnType<ApiKeyAccounts["entries"]>[number];

/** Apply defaults before serialization; explicit request/lane values win. */
function defaults(
  body: unknown,
  parameters: ProviderParameters | undefined,
  native: boolean,
): unknown {
  if (!parameters || !body || typeof body !== "object") return body;
  const request = body as Record<string, unknown>;
  if (native && request.body && typeof request.body === "object") {
    const wire = request.body as Record<string, unknown>;
    let values: Record<string, unknown> = { ...parameters };
    if (request.protocol === "openai_responses") {
      const { max_tokens, reasoning_effort, ...rest } = parameters;
      values = {
        ...rest,
        ...(max_tokens ? { max_output_tokens: max_tokens } : {}),
        ...(reasoning_effort ? { reasoning: { effort: reasoning_effort } } : {}),
      };
    } else if (request.protocol === "anthropic_messages") {
      const { reasoning_effort, ...rest } = parameters;
      values = {
        ...rest,
        ...(reasoning_effort ? { output_config: { effort: reasoning_effort } } : {}),
      };
    } else if (request.protocol === "gemini") {
      const { temperature, top_p, max_tokens } = parameters;
      return {
        ...request,
        raw_body: undefined,
        body: {
          ...wire,
          generationConfig: {
            ...(temperature !== undefined ? { temperature } : {}),
            ...(top_p !== undefined ? { topP: top_p } : {}),
            ...(max_tokens ? { maxOutputTokens: max_tokens } : {}),
            ...((wire.generationConfig as object) ?? {}),
          },
        },
      };
    }
    return { ...request, raw_body: undefined, body: { ...values, ...wire } };
  }
  return { ...parameters, ...request };
}
export function accountClient(
  base: ProviderClient,
  account: ManagedAccount,
  assert: () => Promise<void>,
): ProviderClient {
  const streams = new Set(["chatCompletionStream", "nativePassthroughStream", "streamSpeech"]);
  const decorate = (target: object): object =>
    new Proxy(target, {
      get(obj, property, receiver) {
        const value: unknown = Reflect.get(obj, property, receiver);
        if (property === "shortAsr" && value && typeof value === "object") return decorate(value);
        if (typeof value !== "function") return value;
        const argsFor = (args: unknown[]) => {
          if (
            [
              "chatCompletion",
              "chatCompletionStream",
              "nativePassthrough",
              "nativePassthroughStream",
            ].includes(String(property))
          )
            return [
              defaults(args[0], account.parameters, String(property).startsWith("native")),
              ...args.slice(1),
            ];
          return args;
        };
        if (streams.has(String(property)))
          return async function* (...args: unknown[]) {
            await assert();
            yield* Reflect.apply(value, obj, argsFor(args)) as AsyncIterable<unknown>;
          };
        return async (...args: unknown[]) => {
          await assert();
          return Reflect.apply(value, obj, argsFor(args)) as unknown;
        };
      },
    });
  return decorate(base) as ProviderClient;
}

/** Media writes are not replayed. A sealed task can only reopen its original binding. */
export class ManagedAccountClients {
  private sequence = 0;
  private used = new Map<string, number>();
  private clients = new Map<string, ProviderClient>();
  private active = true;
  private scope: string;
  constructor(
    readonly accounts: ApiKeyAccounts,
    private endpoint: string,
    private factory: (account: ManagedAccount) => ProviderClient,
    private onSelect?: (owner: string) => void,
    private sync?: () => Promise<void>,
    private legacy?: LegacyProviderBinding,
  ) {
    this.scope = createHash("sha256").update(endpoint).digest("hex").slice(0, 24);
  }
  retire() {
    this.active = false;
  }
  isActive() {
    return this.active;
  }
  private owner(a: ManagedAccount) {
    return `${a.id}@${a.generation}.${this.scope}`;
  }
  select(model?: string, owner?: string | null) {
    if (!this.active) return null;
    const eligible = this.accounts
      .entries()
      .filter(
        (a) =>
          this.accounts.eligible(a.id) &&
          (!model ||
            ((a.models === null || a.models.includes(model)) && !a.deniedModels.includes(model))),
      );
    const legacyMatch = (a: ManagedAccount) =>
      this.legacy?.endpoint === this.endpoint &&
      this.legacy.owner === owner &&
      this.legacy.accountId === a.id &&
      this.legacy.generation === a.generation;
    const candidates =
      owner !== undefined
        ? eligible.filter((a) => this.owner(a) === owner || legacyMatch(a))
        : eligible.sort(
            (a, b) =>
              (this.accounts.strategy("manual_priority") === "manual_priority"
                ? a.priority - b.priority
                : 0) || (this.used.get(a.id) ?? 0) - (this.used.get(b.id) ?? 0),
          );
    const account = candidates[0];
    if (!account) return null;
    const identity = this.owner(account);
    let client = this.clients.get(
      `${identity}:${account.transportGeneration ?? ""}:${model ?? ""}`,
    );
    if (!client) {
      client = accountClient(this.factory(account), account, async () => {
        await this.sync?.();
        await this.accounts.refresh();
        const latest = this.accounts.entries().find((a) => a.id === account.id);
        if (
          !this.active ||
          !latest ||
          this.owner(latest) !== identity ||
          latest.transportGeneration !== account.transportGeneration ||
          !this.accounts.eligible(account.id) ||
          (model &&
            ((latest.models !== null && !latest.models.includes(model)) ||
              latest.deniedModels.includes(model)))
        )
          throw new UpstreamError("upstream_error", "Provider account changed or is unavailable");
        this.used.set(account.id, ++this.sequence);
        this.onSelect?.(identity);
      });
      // Model authorization is checked per selection as well as before send.
      this.clients.set(`${identity}:${account.transportGeneration ?? ""}:${model ?? ""}`, client);
    }
    return {
      client,
      account,
      owner: owner !== undefined && legacyMatch(account) ? owner : identity,
    };
  }
}
