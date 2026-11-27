<script lang="ts">
  import { onMount } from 'svelte';
  import {
    ManagedProviderInputSchema,
    ManagedProviderViewSchema,
    type ManagedProviderView,
  } from '@helm/shared';
  import { t } from '$lib/i18n';
  import Modal from './Modal.svelte';
  let {
    onOAuth,
    onchange = () => {},
    onloaded = () => {},
    headless = false,
  }: {
    onOAuth: () => void;
    onchange?: () => void;
    onloaded?: (providers: ManagedProviderView[]) => void;
    headless?: boolean;
  } = $props();
  let providers = $state<ManagedProviderView[]>([]);
  let available = $state(false);
  let error = $state('');
  let notice = $state('');
  let busy = $state(false);
  let open = $state<'choice' | 'api' | null>(null);
  let editing = $state<ManagedProviderView | null>(null);
  let deleting = $state<ManagedProviderView | null>(null);
  let preset = $state('custom');
  let id = $state('');
  let label = $state('');
  let type = $state('openai');
  let endpoint = $state('');
  let mediaAccount = $state('');
  let key = $state('');
  let accountName = $state('Default');
  let importLegacy = $state(false);
  let developerRole = $state(false);
  let reasoningAlias = $state(false);
  let models = $state<Array<{ alias: string; provider_model: string; metadata: string }>>([]);
  const presets: Record<string, { label: string; type: string; url: string }> = {
    kimi: { label: 'Kimi', type: 'openai', url: 'https://api.kimi.ai/coding/v1' },
    openai: { label: 'OpenAI', type: 'openai', url: 'https://api.openai.com/v1' },
    'anthropic-api': { label: 'Claude', type: 'anthropic', url: 'https://api.anthropic.com' },
    deepseek: { label: 'DeepSeek', type: 'openai', url: 'https://api.deepseek.com/v1' },
    google: {
      label: 'Gemini',
      type: 'gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta',
    },
    openrouter: { label: 'OpenRouter', type: 'openai', url: 'https://openrouter.ai/api/v1' },
    ark: { label: 'Volcengine Ark', type: 'ark', url: 'https://ark.cn-beijing.volces.com/api/v3' },
    bailian: {
      label: 'Bailian',
      type: 'bailian-media',
      url: 'https://dashscope.aliyuncs.com/api/v1',
    },
    minimax: { label: 'MiniMax', type: 'minimax-media', url: 'https://api.minimax.io' },
  };
  const protocols = [
    ['openai', 'OpenAI Chat compatible'],
    ['openai-responses-generic', 'OpenAI Responses compatible'],
    ['anthropic', 'Anthropic Messages'],
    ['gemini', 'Gemini'],
    ['deepseek-responses', 'DeepSeek Responses'],
    ['helm', 'Helm gateway'],
    ['ark', 'Volcengine Ark'],
    ['bailian-media', 'Bailian media'],
    ['minimax-media', 'MiniMax media'],
    ['doubao-speech', 'Doubao speech'],
    ['openai-audio', 'OpenAI audio'],
    ['deepgram', 'Deepgram'],
    ['whisperx-asr', 'WhisperX'],
  ];
  export async function load() {
    try {
      const res = await fetch('/admin/api/providers', { cache: 'no-store' });
      if (!res.ok) throw Error();
      const data = await res.json();
      available = data.configured === true;
      providers = ManagedProviderViewSchema.array().parse(data.providers);
      onloaded(providers);
      error = '';
    } catch {
      error = $t('Could not load provider connections.');
    }
  }
  onMount(() => {
    void load();
  });
  function close() {
    open = null;
    key = '';
    editing = null;
    error = '';
  }
  export function start(provider: ManagedProviderView | null = null) {
    editing = provider;
    error = '';
    notice = '';
    preset = 'custom';
    id = provider?.id ?? '';
    label = provider?.label ?? '';
    type = provider?.type ?? 'openai';
    endpoint = provider?.base_url ?? '';
    mediaAccount = provider?.media_account_id ?? '';
    key = '';
    accountName = 'Default';
    importLegacy = !!provider?.legacyCredentialAvailable;
    developerRole = provider?.map_developer_role_to_system ?? false;
    reasoningAlias = provider?.normalize_reasoning_delta_alias ?? false;
    models = provider?.models.map(({ alias, provider_model, ...metadata }) => ({
      alias,
      provider_model,
      metadata: Object.keys(metadata).length ? JSON.stringify(metadata, null, 2) : '',
    })) ?? [{ alias: '', provider_model: '', metadata: '' }];
    open = provider ? 'api' : 'choice';
  }
  function choosePreset() {
    const p = presets[preset];
    if (!p) return;
    id = preset;
    label = p.label;
    type = p.type;
    endpoint = p.url;
    mediaAccount = ['bailian-media', 'minimax-media'].includes(p.type) ? preset : '';
  }
  async function save() {
    busy = true;
    error = '';
    try {
      const provider = ManagedProviderInputSchema.parse({
        id,
        label,
        type,
        base_url: endpoint,
        ...(mediaAccount ? { media_account_id: mediaAccount } : {}),
        map_developer_role_to_system: developerRole,
        normalize_reasoning_delta_alias: reasoningAlias,
        models: models.map((m) => ({
          alias: m.alias,
          provider_model: m.provider_model,
          ...(m.metadata.trim() ? JSON.parse(m.metadata) : {}),
        })),
      });
      const res = await fetch('/admin/api/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider,
          ...(key.trim() ? { key: key.trim(), accountName } : {}),
          importLegacy,
        }),
      });
      if (!res.ok)
        throw Error(
          $t(
            'Provider could not be saved. Check for duplicate aliases and verify encryption is configured.',
          ),
        );
      close();
      notice = $t('Provider saved. Changes apply to new requests immediately.');
      await load();
      onchange();
    } catch (e) {
      error =
        e instanceof Error && !e.message.startsWith('[')
          ? e.message
          : $t('Check the endpoint, model associations and advanced settings.');
    } finally {
      busy = false;
    }
  }
  export function askDelete(provider: ManagedProviderView) {
    deleting = provider;
    error = '';
  }
  async function remove() {
    if (!deleting) return;
    busy = true;
    error = '';
    try {
      const res = await fetch(`/admin/api/providers/${encodeURIComponent(deleting.id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw Error();
      deleting = null;
      await load();
      onchange();
      notice = $t('Provider removed. Existing routes may need updating.');
    } catch {
      error = $t('Could not remove provider. Refresh and try again.');
    } finally {
      busy = false;
    }
  }
</script>

{#if !headless}<button class="btn-primary" onclick={() => start()}>{$t('Add provider')}</button
  >{/if}
{#if error && !open && !deleting}<p class="alert-error" role="alert">{error}</p>{/if}
{#if notice}<p class="alert-success" role="status">{notice}</p>{/if}

{#if open === 'choice'}
  <Modal label={$t('Add provider')} onclose={close}>
    <h2 class="section-header">{$t('Add provider')}</h2>
    <p class="mt-2 field-help">
      {$t('Choose how to connect. Both methods support account management.')}
    </p>
    <div class="mt-5 grid gap-3 sm:grid-cols-2">
      <button
        class="card cursor-pointer text-left transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-control"
        aria-label={$t('OAuth login')}
        onclick={() => {
          close();
          onOAuth();
        }}
        ><strong class="block text-lg">{$t('OAuth login')}</strong><span
          class="mt-2 block text-sm text-ink-muted"
          >{$t('Authorize a supported subscription account in your browser.')}</span
        ></button
      >
      <button
        class="card cursor-pointer text-left transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-control"
        aria-label={$t('API key')}
        onclick={() => {
          open = 'api';
        }}
        ><strong class="block text-lg">{$t('API key')}</strong><span
          class="mt-2 block text-sm text-ink-muted"
          >{$t('Enter a key and endpoint for an official or compatible provider.')}</span
        ></button
      >
    </div>
  </Modal>
{:else if open === 'api'}
  <Modal
    label={editing ? $t('Configure provider') : $t('Add API provider')}
    wide
    onclose={close}
    dismissible={!busy}
  >
    <form
      class="space-y-5"
      onsubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div>
        <h2 class="section-header">
          {editing ? $t('Configure provider') : $t('Add API provider')}
        </h2>
        <p class="field-help mt-1">{$t('Keys are encrypted. Changes apply without a restart.')}</p>
      </div>
      {#if error}<p class="alert-error" role="alert">{error}</p>{/if}
      {#if !available}<p class="alert-warn">
          {$t('Encrypted storage is unavailable. Configure the server encryption key first.')}
        </p>{/if}
      {#if !editing}<label class="block text-sm"
          >{$t('Provider preset')}<select
            class="select mt-1 w-full"
            bind:value={preset}
            onchange={choosePreset}
            ><option value="custom">{$t('Custom provider')}</option
            >{#each Object.entries(presets) as [value, p]}<option {value}>{p.label}</option
              >{/each}</select
          ></label
        >{/if}
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block text-sm"
          >{$t('Display name')}<input
            class="input mt-1 w-full"
            bind:value={label}
            required
            maxlength="80"
            placeholder="Kimi"
          /></label
        ><label class="block text-sm"
          >{$t('Provider ID')}<input
            class="input mt-1 w-full"
            bind:value={id}
            required
            pattern="[a-zA-Z0-9_-]+"
            readonly={!!editing}
            placeholder="kimi"
          /></label
        >
      </div>
      <div class="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <label class="block text-sm"
          >{$t('Protocol')}<select class="select mt-1 w-full" bind:value={type}
            >{#each protocols as [value, text]}<option {value}>{text}</option>{/each}</select
          ></label
        ><label class="block text-sm"
          >{$t('API base URL')}<input
            class="input mt-1 w-full"
            type="url"
            bind:value={endpoint}
            required
            placeholder="https://api.example.com/v1"
          /></label
        >
      </div>
      {#if ['bailian-media', 'minimax-media', 'doubao-speech'].includes(type)}<label
          class="block text-sm"
          >{$t('Media account identity')}<input
            class="input mt-1 w-full"
            bind:value={mediaAccount}
            required
          /></label
        >{/if}
      {#if editing?.managed}
        <p class="field-help">
          {$t('Keys are already saved. Use account settings to add or replace a key.')}
        </p>
      {:else}
        <fieldset class="form-section p-4">
          <legend class="px-2 text-sm font-semibold">{$t('API key account')}</legend>
          <div class="grid gap-3 sm:grid-cols-[1fr_2fr]">
            <label class="block text-sm"
              >{$t('Account name')}<input
                class="input mt-1 w-full"
                bind:value={accountName}
              /></label
            ><label class="block text-sm"
              >{$t('API key')}<input
                class="input mt-1 w-full"
                type="password"
                autocomplete="new-password"
                bind:value={key}
                placeholder={editing ? $t('Leave blank to keep existing keys') : '••••••••••••••••'}
                required={!editing && !importLegacy}
              /></label
            >
          </div>
          {#if editing?.legacyCredentialAvailable}<label class="checkbox-field mt-3"
              ><input class="checkbox" type="checkbox" bind:checked={importLegacy} />{$t(
                'Import the current environment key into encrypted storage',
              )}</label
            >{/if}
          <p class="field-help mt-2">
            {$t('Manage priority, model access and a separate proxy for each key after saving.')}
          </p>
        </fieldset>
      {/if}
      <fieldset class="space-y-3">
        <legend class="text-sm font-semibold">{$t('Model associations')}</legend>
        <p class="field-help">
          {$t('The alias is used by Helm routes. The upstream ID is sent to the provider.')}
        </p>
        {#each models as model, i}<div class="form-section p-3">
            <div class="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <label class="block text-sm"
                >{$t('Model alias')}<input
                  class="input mt-1 w-full"
                  bind:value={model.alias}
                  required
                  placeholder="kimi/pro"
                /></label
              ><label class="block text-sm"
                >{$t('Upstream model ID')}<input
                  class="input mt-1 w-full"
                  bind:value={model.provider_model}
                  required
                  placeholder="k3.1-pro"
                /></label
              ><button
                type="button"
                class="btn-secondary self-end"
                disabled={models.length === 1}
                aria-label={`${$t('Remove model')} ${i + 1}`}
                onclick={() => (models = models.filter((_, n) => n !== i))}>{$t('Remove')}</button
              >
            </div>
            <details class="mt-3">
              <summary class="cursor-pointer text-xs text-ink-muted"
                >{$t('Capabilities and pricing (optional JSON)')}</summary
              ><textarea
                class="input mt-2 w-full font-mono text-xs"
                rows="5"
                aria-label={`${$t('Model metadata')} ${i + 1}`}
                bind:value={model.metadata}
                placeholder={'{"capabilities": {...}, "pricing": {...}}'}
              ></textarea>
              <p class="field-help">
                {$t(
                  'Existing catalog values are inherited. Media models need matching output capabilities and pricing.',
                )}
              </p>
            </details>
          </div>{/each}
        <button
          type="button"
          class="btn-secondary"
          onclick={() => (models = [...models, { alias: '', provider_model: '', metadata: '' }])}
          >{$t('Add model')}</button
        >
      </fieldset>
      <details>
        <summary class="cursor-pointer text-sm font-medium">{$t('Compatibility settings')}</summary>
        <div class="mt-3 space-y-2">
          <label class="checkbox-field"
            ><input class="checkbox" type="checkbox" bind:checked={developerRole} />{$t(
              'Map developer role to system',
            )}</label
          ><label class="checkbox-field"
            ><input class="checkbox" type="checkbox" bind:checked={reasoningAlias} />{$t(
              'Normalize reasoning stream fields',
            )}</label
          >
        </div>
      </details>
      <div class="card-actions">
        <button type="button" class="btn-secondary" disabled={busy} onclick={close}
          >{$t('Cancel')}</button
        ><button class="btn-primary" disabled={busy || !available}
          >{busy ? $t('Saving…') : $t('Save provider')}</button
        >
      </div>
    </form>
  </Modal>
{/if}
{#if deleting}<Modal
    label={$t('Delete provider')}
    onclose={() => (deleting = null)}
    dismissible={!busy}
    ><h2 class="section-header">{$t('Delete provider')} · {deleting.label}</h2>
    <p class="my-4 text-sm">
      {$t(
        'This removes this connection. Unshared keys are deleted and existing routes may become unavailable.',
      )}
    </p>
    {#if error}<p class="alert-error" role="alert">{error}</p>{/if}
    <div class="card-actions">
      <button class="btn-secondary" disabled={busy} onclick={() => (deleting = null)}
        >{$t('Cancel')}</button
      ><button class="btn-primary" disabled={busy} onclick={() => void remove()}
        >{$t('Delete')}</button
      >
    </div></Modal
  >{/if}
