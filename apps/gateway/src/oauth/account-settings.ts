import {
  type ConfigStore,
  decryptSecret,
  encryptSecret,
  type OAuthSelectionStrategy,
  parseXaiOAuthModels,
  type XaiOAuthModel,
} from "@helm/core";

// Per-account OAuth subscription SETTINGS (issue #38 follow-up). These are
// OPERATOR choices that live ALONGSIDE the stored credential but must NOT ride in
// the OAuthTokenStore `meta` column — a token refresh overwrites that JSON, so
// any settings parked there would be silently wiped. They are instead persisted
// as a single ENCRYPTED blob in the ConfigStore (config_kv) under one key, keyed
// internally by `${providerId}\u0000${account}`.
//
// SECURITY (principle 7): the blob can hold a proxy password, so it is AES-256-GCM
// ciphertext (token-cipher), never plaintext — same enc key as the tokens. The
// read path is FAIL-OPEN: any decrypt/parse error yields {} (settings are
// convenience state layered on top of the credential, not a security boundary —
// a corrupt blob must never block routing or the admin page).

const SETTINGS_KEY = "oauth.account_settings";
const GLOBAL_SETTINGS_KEY = "oauth.global_settings";
const SELECTION_STRATEGIES = new Set<OAuthSelectionStrategy>([
  "balanced",
  "manual_priority",
  "low_risk",
  "use_expiring",
]);
// NUL composite separator: it cannot appear in a provider id or account label,
// so `${providerId}\u0000${account}` is an unambiguous, collision-free map key
// (a printable separator could collide with a label that contains it).
const SEP = "\u0000";
const mutationQueues = new WeakMap<ConfigStore, Promise<void>>();

// Settings for one connected account. All fields optional — an absent field means
// "inherit the default" (enabledModels unset = ALL discovered models exposed;
// priority unset = the scheduler default; schedulable unset = true; proxy unset =
// direct connection). Later stages (proxy / priority pool) read the same blob.
export interface AccountSettings {
  // Codex defaults to auto so newly entitled models appear without an operator
  // edit. Manual preserves an explicit enabledModels allowlist. Legacy rows with
  // an enabledModels list remain manual so an upgrade cannot widen operator access.
  modelsMode?: "auto" | "manual";
  // Subset of discovered models the operator exposes to Lanes. Unset = expose all.
  enabledModels?: string[];
  // Last non-empty remote catalog successfully discovered for this account.
  // Auto mode uses it after a restart or transient discovery failure; live cache
  // data still wins. Stored inside the existing encrypted settings blob.
  discoveredModels?: string[];
  // xAI only: first-party structured catalog required to preserve the distinct
  // catalog id / inference model mapping and per-model request defaults across
  // transient discovery failures. Revalidated on every read.
  xaiDiscoveredModels?: XaiOAuthModel[];
  // Lower = preferred; round-robin within an equal priority. Scheduler default 50.
  priority?: number;
  // When false the account is skipped by the scheduler (kept connected, parked).
  schedulable?: boolean;
  // Durable credential failure detected from a refresh 400/401/403 or upstream auth
  // rejection. While set, the account is treated as unhealthy and not routable until a
  // successful reconnect clears it.
  credentialFailedAt?: number;
  credentialFailureReason?: string;
  // True when Helm, not the operator, flipped schedulable:false because the credential
  // failed. A successful reconnect may safely restore default schedulability only for
  // these auto-disabled accounts; manually parked accounts stay parked.
  autoDisabledForCredentialFailure?: boolean;
  // Codex only: when true, auto-consume one rate-limit reset credit the moment the
  // weekly window saturates (≥100%). Unset/false = never auto-reset (manual only).
  autoReset?: boolean;
  // Per-account Fast mode. Anthropic accounts force `speed:"fast"`; Codex accounts
  // force Responses `service_tier:"priority"` on every request served by this account.
  fastMode?: boolean;
  // Optional upstream proxy for this account's provider traffic.
  proxy?: {
    type: "http" | "https" | "socks5";
    host: string;
    port: number;
    username?: string;
    password?: string;
  };
}

// The whole map: internal composite key -> settings. Exported for the callers that
// thread it (server synthesis, admin seam).
export type AccountSettingsMap = Record<string, AccountSettings>;

export type AccountModelsMode = "auto" | "manual";

export function resolveAccountModelsMode(
  _providerId: string,
  settings: Pick<AccountSettings, "modelsMode" | "enabledModels">,
): AccountModelsMode {
  if (settings.modelsMode === "auto" || settings.modelsMode === "manual") {
    return settings.modelsMode;
  }
  return settings.enabledModels === undefined ? "auto" : "manual";
}

export interface GlobalOAuthSettings {
  selectionStrategy?: OAuthSelectionStrategy;
}

function composite(providerId: string, account: string): string {
  return `${providerId}${SEP}${account}`;
}

function serializeSettingsMutation<T>(config: ConfigStore, work: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(config) ?? Promise.resolve();
  const run = previous.then(work, work);
  mutationQueues.set(
    config,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function parseAccountSettings(blob: string, encKey: Buffer): AccountSettingsMap {
  const parsed: unknown = JSON.parse(decryptSecret(blob, encKey));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid OAuth account settings");
  }
  const settings = parsed as Record<string, unknown>;
  const normalized: AccountSettingsMap = {};
  for (const [key, raw] of Object.entries(settings)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const account = { ...(raw as AccountSettings) };
    if ("xaiDiscoveredModels" in account) {
      const models = parseXaiOAuthModels(account.xaiDiscoveredModels);
      if (models === null) delete account.xaiDiscoveredModels;
      else account.xaiDiscoveredModels = models;
    }
    normalized[key] = account;
  }
  return normalized;
}

async function loadAccountSettingsForMutation(
  config: ConfigStore,
  encKey: Buffer,
): Promise<AccountSettingsMap> {
  const blob = await config.get(SETTINGS_KEY);
  if (blob === null) return {};
  return parseAccountSettings(blob, encKey);
}

// Read paths FAIL-OPEN to {} on a missing/corrupt blob so a bad write can never
// wedge routing or the providers page. Mutation paths use the strict loader above:
// corrupt/unreadable settings must never be replaced with a partial empty map.
export async function loadAccountSettings(
  config: ConfigStore,
  encKey: Buffer,
): Promise<AccountSettingsMap> {
  try {
    const blob = await config.get(SETTINGS_KEY);
    if (blob === null) return {};
    return parseAccountSettings(blob, encKey);
  } catch {
    return {};
  }
}

// Encrypt + persist the whole map.
export async function saveAccountSettings(
  config: ConfigStore,
  encKey: Buffer,
  map: AccountSettingsMap,
): Promise<void> {
  await config.set(SETTINGS_KEY, encryptSecret(JSON.stringify(map), encKey));
}

function normalizeSelectionStrategy(
  selectionStrategy: unknown,
): OAuthSelectionStrategy | undefined {
  return SELECTION_STRATEGIES.has(selectionStrategy as OAuthSelectionStrategy)
    ? (selectionStrategy as OAuthSelectionStrategy)
    : undefined;
}

export async function loadGlobalOAuthSettings(
  config: ConfigStore,
  encKey: Buffer,
): Promise<GlobalOAuthSettings> {
  try {
    const blob = await config.get(GLOBAL_SETTINGS_KEY);
    if (!blob) return {};
    const json = decryptSecret(blob, encKey);
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const raw = parsed as GlobalOAuthSettings;
    return { selectionStrategy: normalizeSelectionStrategy(raw.selectionStrategy) };
  } catch {
    return {};
  }
}

export async function saveGlobalOAuthSettings(
  config: ConfigStore,
  encKey: Buffer,
  settings: GlobalOAuthSettings,
): Promise<void> {
  await config.set(GLOBAL_SETTINGS_KEY, encryptSecret(JSON.stringify(settings), encKey));
}

// Read one account's settings out of an already-loaded map (never throws).
export function getAccountSettings(
  map: AccountSettingsMap,
  providerId: string,
  account: string,
): AccountSettings {
  return map[composite(providerId, account)] ?? {};
}

// Merge a partial patch into one account's settings and PERSIST the whole map.
// Load → merge → save, so concurrent unrelated accounts are preserved. `patch`
// keys overwrite at the top level (e.g. setting `enabledModels` replaces the list,
// leaving `priority`/`proxy` untouched).
export async function setAccountSettings(
  config: ConfigStore,
  encKey: Buffer,
  providerId: string,
  account: string,
  patch: AccountSettings,
): Promise<void> {
  await serializeSettingsMutation(config, async () => {
    const map = await loadAccountSettingsForMutation(config, encKey);
    const key = composite(providerId, account);
    map[key] = { ...map[key], ...patch };
    await saveAccountSettings(config, encKey, map);
  });
}

// Persist one account's non-empty, last-known-good remote catalog. Empty/error
// discovery must never erase a prior snapshot. Avoid rewriting the encrypted blob
// when the normalized catalog is unchanged (refresh runs can be frequent).
export async function saveAccountDiscoveredModels(
  config: ConfigStore,
  encKey: Buffer,
  providerId: string,
  account: string,
  models: readonly string[],
): Promise<boolean> {
  const normalized = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  if (normalized.length === 0) return true;
  try {
    await serializeSettingsMutation(config, async () => {
      const map = await loadAccountSettingsForMutation(config, encKey);
      const key = composite(providerId, account);
      const current = map[key] ?? {};
      if (
        current.discoveredModels?.length === normalized.length &&
        current.discoveredModels.every((model, index) => model === normalized[index])
      ) {
        return;
      }
      map[key] = { ...current, discoveredModels: normalized };
      await saveAccountSettings(config, encKey, map);
    });
    return true;
  } catch {
    return false;
  }
}

// Persist the authoritative first-party xAI catalog, including a successful
// empty result. The string ids remain in sync for the existing Manage dialog,
// while routing consumes only the structured snapshot so id -> wire-model and
// request-default metadata cannot be guessed after a restart.
export async function saveAccountXaiDiscoveredModels(
  config: ConfigStore,
  encKey: Buffer,
  account: string,
  models: readonly XaiOAuthModel[],
): Promise<boolean> {
  const normalized = parseXaiOAuthModels(models) ?? [];
  try {
    await serializeSettingsMutation(config, async () => {
      const map = await loadAccountSettingsForMutation(config, encKey);
      const key = composite("xai", account);
      const current = map[key] ?? {};
      const next: AccountSettings = { ...current, xaiDiscoveredModels: normalized };
      if (normalized.length > 0) {
        next.discoveredModels = normalized.map((model) => model.id);
      } else {
        delete next.discoveredModels;
      }
      if (JSON.stringify(current) === JSON.stringify(next)) return;
      map[key] = next;
      await saveAccountSettings(config, encKey, map);
    });
    return true;
  } catch {
    return false;
  }
}

// Credential replacement must remove the old identity's durable catalog BEFORE
// the token row changes. Unlike background snapshot writes, a failed clear is a
// hard stop for reconnect; callers use the boolean to keep the old credential.
export async function clearAccountDiscoveredModels(
  config: ConfigStore,
  encKey: Buffer,
  providerId: string,
  account: string,
): Promise<boolean> {
  try {
    await serializeSettingsMutation(config, async () => {
      const map = await loadAccountSettingsForMutation(config, encKey);
      const key = composite(providerId, account);
      const current = map[key];
      if (
        !current ||
        (current.discoveredModels === undefined && current.xaiDiscoveredModels === undefined)
      ) {
        return;
      }
      const next = { ...current };
      delete next.discoveredModels;
      delete next.xaiDiscoveredModels;
      map[key] = next;
      await saveAccountSettings(config, encKey, map);
    });
    return true;
  } catch {
    return false;
  }
}

export async function markAccountCredentialFailure(
  config: ConfigStore,
  encKey: Buffer,
  providerId: string,
  account: string,
  failure: { at: number; reason: string },
): Promise<void> {
  await serializeSettingsMutation(config, async () => {
    const map = await loadAccountSettingsForMutation(config, encKey);
    const key = composite(providerId, account);
    const current = map[key] ?? {};
    const wasOperatorParked =
      current.schedulable === false && current.autoDisabledForCredentialFailure !== true;
    map[key] = {
      ...current,
      schedulable: false,
      credentialFailedAt: failure.at,
      credentialFailureReason: failure.reason.slice(0, 240),
      autoDisabledForCredentialFailure: !wasOperatorParked,
    };
    await saveAccountSettings(config, encKey, map);
  });
}

export async function clearAccountCredentialFailure(
  config: ConfigStore,
  encKey: Buffer,
  providerId: string,
  account: string,
): Promise<void> {
  await serializeSettingsMutation(config, async () => {
    const map = await loadAccountSettingsForMutation(config, encKey);
    const key = composite(providerId, account);
    const current = map[key];
    if (!current) return;
    const next: AccountSettings = { ...current };
    const shouldRestoreDefaultSchedulable =
      next.autoDisabledForCredentialFailure === true && next.schedulable === false;
    delete next.credentialFailedAt;
    delete next.credentialFailureReason;
    delete next.autoDisabledForCredentialFailure;
    if (shouldRestoreDefaultSchedulable) delete next.schedulable;
    map[key] = next;
    await saveAccountSettings(config, encKey, map);
  });
}

export async function setGlobalOAuthSettings(
  config: ConfigStore,
  encKey: Buffer,
  patch: GlobalOAuthSettings,
): Promise<void> {
  await serializeSettingsMutation(config, async () => {
    const current = await loadGlobalOAuthSettings(config, encKey);
    await saveGlobalOAuthSettings(config, encKey, {
      ...current,
      ...patch,
      selectionStrategy: normalizeSelectionStrategy(patch.selectionStrategy),
    });
  });
}

// Delete one account's settings from the encrypted settings map. Used by OAuth
// logout so proxy passwords and per-account curation do not survive a disconnect.
export async function clearAccountSettings(
  config: ConfigStore,
  encKey: Buffer,
  providerId: string,
  account: string,
): Promise<void> {
  await serializeSettingsMutation(config, async () => {
    const map = await loadAccountSettingsForMutation(config, encKey);
    delete map[composite(providerId, account)];
    await saveAccountSettings(config, encKey, map);
  });
}
