import {
  type ConfigStore,
  decryptSecret,
  encryptSecret,
  type OAuthSelectionStrategy,
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
const PROVIDER_SETTINGS_KEY = "oauth.provider_settings";
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
  // Subset of discovered models the operator exposes to Lanes. Unset = expose all.
  enabledModels?: string[];
  // Lower = preferred; round-robin within an equal priority. Scheduler default 50.
  priority?: number;
  // When false the account is skipped by the scheduler (kept connected, parked).
  schedulable?: boolean;
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

export interface ProviderSettings {
  selectionStrategy?: OAuthSelectionStrategy;
}

export type ProviderSettingsMap = Record<string, ProviderSettings>;

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

// Load + decrypt the full settings map. FAIL-OPEN to {} on a missing/corrupt blob
// so a bad write can never wedge routing or the providers page.
export async function loadAccountSettings(
  config: ConfigStore,
  encKey: Buffer,
): Promise<AccountSettingsMap> {
  try {
    const blob = await config.get(SETTINGS_KEY);
    if (!blob) return {};
    const json = decryptSecret(blob, encKey);
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as AccountSettingsMap;
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

export async function loadProviderSettings(
  config: ConfigStore,
  encKey: Buffer,
): Promise<ProviderSettingsMap> {
  try {
    const blob = await config.get(PROVIDER_SETTINGS_KEY);
    if (!blob) return {};
    const json = decryptSecret(blob, encKey);
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ProviderSettingsMap;
  } catch {
    return {};
  }
}

export async function saveProviderSettings(
  config: ConfigStore,
  encKey: Buffer,
  map: ProviderSettingsMap,
): Promise<void> {
  await config.set(PROVIDER_SETTINGS_KEY, encryptSecret(JSON.stringify(map), encKey));
}

// Read one account's settings out of an already-loaded map (never throws).
export function getAccountSettings(
  map: AccountSettingsMap,
  providerId: string,
  account: string,
): AccountSettings {
  return map[composite(providerId, account)] ?? {};
}

export function getProviderSettings(
  map: ProviderSettingsMap,
  providerId: string,
): ProviderSettings {
  const raw = map[providerId] ?? {};
  return SELECTION_STRATEGIES.has(raw.selectionStrategy as OAuthSelectionStrategy)
    ? raw
    : { ...raw, selectionStrategy: undefined };
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
    const map = await loadAccountSettings(config, encKey);
    const key = composite(providerId, account);
    map[key] = { ...map[key], ...patch };
    await saveAccountSettings(config, encKey, map);
  });
}

export async function setProviderSettings(
  config: ConfigStore,
  encKey: Buffer,
  providerId: string,
  patch: ProviderSettings,
): Promise<void> {
  await serializeSettingsMutation(config, async () => {
    const map = await loadProviderSettings(config, encKey);
    map[providerId] = { ...map[providerId], ...patch };
    await saveProviderSettings(config, encKey, map);
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
    const map = await loadAccountSettings(config, encKey);
    delete map[composite(providerId, account)];
    await saveAccountSettings(config, encKey, map);
  });
}
