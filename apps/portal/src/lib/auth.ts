import { writable } from "svelte/store";
import { base } from "$app/paths";
import { goto } from "$app/navigation";

// Portal session = a plaintext API key held ONLY in sessionStorage (docs/12 §4.1).
// Closing the tab clears it; there is no server-side session, no cookie, no
// localStorage (XSS window is shorter, CSP is the real defense). Every API call
// carries `Authorization: Bearer <key>` — the key never rides a query/body (R6).
const STORAGE_KEY = "helm_portal_key";

// The prefix shown in the UI ("helm_…3f9") — NEVER the full key on screen (§3).
export const apiKey = writable<string | null>(readStoredKey());

function readStoredKey(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(STORAGE_KEY);
}

export function getKey(): string | null {
  return readStoredKey();
}

export function setKey(key: string): void {
  sessionStorage.setItem(STORAGE_KEY, key);
  apiKey.set(key);
}

export function clearKey(): void {
  sessionStorage.removeItem(STORAGE_KEY);
  apiKey.set(null);
  void goto(`${base}/login`);
}

// Show only the display fingerprint: the key's own prefix segment + last 3 chars,
// e.g. "helm_live_ab…3f9". Never the middle. Safe for the key pill / account menu.
export function keyFingerprint(key: string | null): string {
  if (!key) return "";
  const tail = key.slice(-3);
  // helm keys look like helm_<env>_<random>; keep through the 2nd underscore.
  const secondUnderscore = key.indexOf("_", key.indexOf("_") + 1);
  const head =
    secondUnderscore > 0
      ? key.slice(0, secondUnderscore + 3)
      : key.slice(0, 10);
  return `${head}…${tail}`;
}
