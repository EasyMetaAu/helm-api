<script lang="ts">
  import {
    type ApiKeyView,
    type CreateKeyInput,
    createKey,
    type CreatedKey,
  } from '$lib/api/keys.js';

  // Create-key dialog: owns the caps form AND the ONE-TIME plaintext reveal.
  // CLAUDE.md 原则7 / docs/06: the plaintext is returned by the create response
  // exactly once, shown once, then wiped from component state on close — it is
  // never persisted, re-fetchable, or surfaced anywhere else. The dialog bubbles
  // the redacted view (prefix only, NO plaintext) up via `oncreated`.
  let {
    lanes,
    oncreated,
    onclose,
  }: {
    lanes: string[];
    oncreated: (key: ApiKeyView) => void;
    onclose: () => void;
  } = $props();

  type Role = 'root' | 'user';

  let role = $state<Role>('user');
  let maxLane = $state<string>('');
  let allowCustomModel = $state<boolean>(false);

  let error = $state<string | null>(null);
  let creating = $state<boolean>(false);
  // The minted plaintext + its key_id live ONLY in this transient state and are
  // cleared on close. While set, the form is replaced by the one-time reveal.
  let revealed = $state<CreatedKey | null>(null);
  let copied = $state<boolean>(false);

  async function handleCreate(): Promise<void> {
    error = null;
    creating = true;
    const input: CreateKeyInput = {
      role,
      allow_custom_model: allowCustomModel,
    };
    if (maxLane) input.max_lane = maxLane;
    try {
      revealed = await createKey(input);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to create key';
    } finally {
      creating = false;
    }
  }

  async function copyPlaintext(): Promise<void> {
    if (!revealed) return;
    try {
      await navigator.clipboard?.writeText(revealed.plaintext);
      copied = true;
    } catch {
      // Clipboard may be unavailable (e.g. insecure context); operator can select
      // the text manually. Do not surface the secret in an error message.
      copied = false;
    }
  }

  // Operator confirms they stored the secret. Bubble the redacted view up (prefix
  // is unknown to the client — POST returns only key_id+plaintext — so we project
  // a minimal view from the chosen caps; the page will refresh prefixes from the
  // server list). Then WIPE the plaintext and close.
  function confirmSaved(): void {
    if (revealed) {
      const view: ApiKeyView = {
        key_id: revealed.key_id,
        // The create response does not include the prefix; show a redacted
        // placeholder until the next list load fills it in. NEVER the plaintext.
        prefix: revealed.plaintext.slice(0, 14),
        role,
        max_lane: maxLane || null,
        allowed_lanes: null,
        allow_custom_model: allowCustomModel,
        disabled: false,
      };
      oncreated(view);
    }
    // Wipe transient secret state from the component.
    revealed = null;
    copied = false;
    onclose();
  }
</script>

<div
  class="rounded-lg border border-slate-300 bg-white p-5 shadow-sm"
  role="dialog"
  aria-label="Create API key"
>
  {#if revealed}
    <h2 class="text-lg font-semibold text-slate-900">Your new API key</h2>
    <p class="mt-1 text-sm text-amber-700">
      Copy it now — this is the only time it will be shown. We store only a hash, so it cannot be
      recovered later.
    </p>
    <div class="mt-3 flex items-center gap-2">
      <code
        data-testid="plaintext-reveal"
        class="flex-1 break-all rounded bg-slate-100 px-3 py-2 font-mono text-sm text-slate-900"
        >{revealed.plaintext}</code
      >
      <button
        type="button"
        class="rounded bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
        onclick={copyPlaintext}>{copied ? 'Copied' : 'Copy'}</button
      >
    </div>
    <div class="mt-4 flex justify-end">
      <button
        type="button"
        class="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
        onclick={confirmSaved}>I saved it</button
      >
    </div>
  {:else}
    <h2 class="text-lg font-semibold text-slate-900">Create API key</h2>

    {#if error}
      <p
        class="mt-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        role="alert"
      >
        {error}
      </p>
    {/if}

    <div class="mt-3 flex flex-col gap-3">
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium text-slate-700">Role</span>
        <select
          bind:value={role}
          aria-label="role"
          class="rounded border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="user">user</option>
          <option value="root">root</option>
        </select>
        {#if role === 'root'}
          <span class="text-xs text-amber-700"
            >Root keys are for the bootstrap/management plane only — do not feed production traffic.</span
          >
        {/if}
      </label>

      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium text-slate-700">Max lane (cap)</span>
        <select
          bind:value={maxLane}
          aria-label="max lane"
          class="rounded border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="">— no cap —</option>
          {#each lanes as lane (lane)}
            <option value={lane}>{lane}</option>
          {/each}
        </select>
      </label>

      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" bind:checked={allowCustomModel} aria-label="allow custom model" />
        <span class="text-slate-700">Allow explicit client-specified model passthrough</span>
      </label>
    </div>

    <div class="mt-4 flex justify-end gap-2">
      <button
        type="button"
        class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
        onclick={onclose}>Cancel</button
      >
      <button
        type="button"
        class="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        disabled={creating}
        onclick={handleCreate}>Create key</button
      >
    </div>
  {/if}
</div>
