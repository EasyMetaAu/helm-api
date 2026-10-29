<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiKeyPoolsViewSchema, type ApiKeyPoolView, type ApiKeyAccountView } from '@helm/shared';
  import { t } from '$lib/i18n';
  import Modal from './Modal.svelte';

  let pools = $state<ApiKeyPoolView[]>([]);
  let busy = $state(false);
  let error = $state('');
  let adding = $state<string | null>(null);
  let keys = $state('');
  let editing = $state<{ pool: string; account: ApiKeyAccountView } | null>(null);
  let name = $state('');
  let replacement = $state('');
  let priority = $state(50);
  let models = $state('');
  let deleting = $state<{ pool: string; account: ApiKeyAccountView } | null>(null);
  const base = '/admin/api/api-key-pools';
  const accountUrl = (pool: string, id: string) =>
    `${base}/${encodeURIComponent(pool)}/accounts/${encodeURIComponent(id)}`;
  async function load() {
    const res = await fetch(base, { cache: 'no-store' });
    if (!res.ok) throw new Error($t('Could not load API key providers'));
    pools = ApiKeyPoolsViewSchema.parse(await res.json()).pools;
  }
  async function run(action: () => Promise<void>) {
    busy = true;
    error = '';
    try {
      await action();
    } catch (e) {
      error = e instanceof Error ? e.message : $t('API key operation failed');
    } finally {
      busy = false;
    }
  }
  async function write(url: string, method: string, body?: unknown) {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok)
      throw new Error(
        res.status === 409
          ? $t('Duplicate key or invalid recovery request')
          : $t('API key operation failed'),
      );
  }
  onMount(() => {
    void run(load);
  });
  async function add() {
    if (!adding) return;
    const lines = keys
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length || lines.some((s) => s.startsWith('sk-admin-'))) {
      error = $t('Enter model API keys, not Admin keys');
      return;
    }
    await write(`${base}/${encodeURIComponent(adding)}/accounts`, 'POST', {
      accounts: lines.map((key, i) => ({ name: `API ${i + 1}`, key })),
    });
    keys = '';
    adding = null;
    await load();
  }
  function edit(pool: string, account: ApiKeyAccountView) {
    editing = { pool, account };
    name = account.name;
    priority = account.priority;
    models = account.models?.join('\n') ?? '';
    replacement = '';
  }
  async function save() {
    if (!editing) return;
    await write(accountUrl(editing.pool, editing.account.id), 'PATCH', {
      name,
      priority,
      models: models.trim()
        ? models
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        : null,
      ...(replacement.trim() ? { key: replacement.trim() } : {}),
    });
    replacement = '';
    editing = null;
    await load();
  }
  const stateLabel = (account: ApiKeyAccountView) =>
    !account.enabled
      ? $t('Paused manually')
      : {
          ready: $t('Available'),
          cooldown: $t('Rate limited'),
          quota_exhausted: $t('Quota exhausted'),
          invalid: $t('Invalid credential'),
        }[account.state];
</script>

<section class="card space-y-4" aria-label={$t('API key providers')}>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h2 class="section-header">{$t('API key providers')}</h2>
      <p class="field-help">
        {$t(
          'Rotate model API keys. Exhausted accounts retry next month; a successful request confirms recovery.',
        )}
      </p>
    </div>
    <button class="btn-secondary" disabled={busy} onclick={() => run(load)}
      >{$t('Refresh API keys')}</button
    >
  </div>
  {#if error}<p role="alert" class="alert-error">{error}</p>{/if}
  {#each pools as pool (pool.id)}
    <div class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 class="font-semibold">{pool.id}</h3>
          <p class="field-help">
            {$t('Monthly retry timezone')}: {pool.timezone} · {$t('Day 1, 00:00')}
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <select
            aria-label={$t('API key rotation strategy')}
            class="input"
            value={pool.strategy}
            disabled={busy || !pool.configured}
            onchange={(e) =>
              run(async () => {
                await write(`${base}/${encodeURIComponent(pool.id)}/strategy`, 'PUT', {
                  strategy: e.currentTarget.value,
                });
                await load();
              })}
          >
            <option value="round_robin">{$t('Round robin')}</option><option value="manual_priority"
              >{$t('Manual priority')}</option
            >
          </select>
          <button
            class="btn-primary"
            disabled={busy || !pool.configured}
            onclick={() => {
              adding = pool.id;
              keys = '';
            }}>{$t('Add API keys')}</button
          >
        </div>
      </div>
      {#if !pool.configured}<p class="field-help">
          {$t('Encrypted credential storage is not configured.')}
        </p>{/if}
      {#if pool.accounts.length === 0}<p class="field-help">
          {$t(
            'No managed API keys. Existing environment credentials remain in use only until the pool is first configured.',
          )}
        </p>{/if}
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead
            ><tr class="text-left"
              ><th class="p-2">{$t('Account')}</th><th class="p-2">{$t('Status')}</th><th
                class="p-2">{$t('Usage (last 24 hours)')}</th
              ><th class="p-2">{$t('Actions')}</th></tr
            ></thead
          >
          <tbody>
            {#each pool.accounts as account (account.id)}
              {@const usage = pool.usage.find((row) => row.account === account.id)}
              <tr class="border-t border-[var(--border)]">
                <td class="p-2"
                  ><div>{account.name}</div>
                  <code>{account.mask}</code></td
                >
                <td class="p-2"
                  ><div>{stateLabel(account)}</div>
                  {#if account.reason}<div class="field-help">{account.reason}</div>{/if}
                  {#if account.nextRetryAt}<div class="field-help">
                      {$t('Next recovery attempt')}: {new Date(
                        account.nextRetryAt,
                      ).toLocaleString()}
                    </div>{/if}
                  {#if account.probeUntil && account.probeUntil > Date.now()}<div
                      class="field-help"
                    >
                      {$t('Recovery request in progress')}
                    </div>{/if}
                </td>
                <td class="p-2"
                  >{usage?.requests ?? 0}
                  {$t('requests')} · {usage?.tokens ?? 0} tokens<br />{$t('Estimated cost')}: {usage?.costUsd ==
                  null
                    ? '—'
                    : `$${usage.costUsd.toFixed(4)}`}</td
                >
                <td class="p-2"
                  ><div class="flex flex-wrap gap-2">
                    <button
                      class="btn-secondary"
                      disabled={busy}
                      onclick={() => edit(pool.id, account)}>{$t('Edit')}</button
                    >
                    <button
                      class="btn-secondary"
                      disabled={busy}
                      onclick={() =>
                        run(async () => {
                          await write(accountUrl(pool.id, account.id), 'PATCH', {
                            enabled: !account.enabled,
                          });
                          await load();
                        })}>{account.enabled ? $t('Pause') : $t('Resume')}</button
                    >
                    <button
                      class="btn-secondary"
                      disabled={busy || !account.enabled || account.state === 'invalid'}
                      onclick={() =>
                        run(async () => {
                          await write(`${accountUrl(pool.id, account.id)}/retry`, 'POST', {});
                          await load();
                        })}>{$t('Try recovery')}</button
                    >
                    <button
                      class="btn-secondary"
                      disabled={busy}
                      onclick={() => {
                        deleting = { pool: pool.id, account };
                      }}>{$t('Delete')}</button
                    >
                  </div></td
                >
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/each}
</section>

{#if adding}
  <Modal
    label={$t('Add API keys')}
    onclose={() => {
      if (!busy) {
        adding = null;
        keys = '';
      }
    }}
  >
    <form
      class="space-y-4"
      onsubmit={(e) => {
        e.preventDefault();
        void run(add);
      }}
    >
      <h2 class="section-header">{$t('Add API keys')}</h2>
      <label class="block"
        >{$t('API keys (one per line)')}<textarea
          class="input mt-2 w-full font-mono"
          rows="6"
          bind:value={keys}
          autocomplete="off"
          spellcheck="false"
          required
        ></textarea></label
      >
      <p class="field-help">
        {$t('Keys are encrypted on the server. Admin keys are not used for model requests.')}
      </p>
      <button class="btn-primary" disabled={busy}>{$t('Save API keys')}</button>
    </form>
  </Modal>
{/if}
{#if editing}
  <Modal
    label={$t('Edit API key account')}
    onclose={() => {
      if (!busy) {
        editing = null;
        replacement = '';
      }
    }}
  >
    <form
      class="space-y-4"
      onsubmit={(e) => {
        e.preventDefault();
        void run(save);
      }}
    >
      <h2 class="section-header">{$t('Edit API key account')}</h2>
      <label class="block"
        >{$t('Name')}<input class="input w-full" bind:value={name} required maxlength="80" /></label
      >
      <label class="block"
        >{$t('Replacement API key (optional)')}<input
          class="input w-full"
          type="password"
          bind:value={replacement}
          autocomplete="new-password"
        /></label
      >
      <label class="block"
        >{$t('Priority')}<input
          class="input w-full"
          type="number"
          min="0"
          max="1000"
          bind:value={priority}
          required
        /></label
      >
      <label class="block"
        >{$t('Allowed models (one per line; empty means configured models)')}<textarea
          class="input w-full"
          rows="4"
          bind:value={models}
        ></textarea></label
      >
      <button class="btn-primary" disabled={busy}>{$t('Save')}</button>
    </form>
  </Modal>
{/if}
{#if deleting}
  <Modal
    label={$t('Delete API key account')}
    onclose={() => {
      if (!busy) deleting = null;
    }}
  >
    <p>{$t('Delete API key account')}: {deleting.account.name}?</p>
    <button
      class="btn-primary mt-4"
      disabled={busy}
      onclick={() =>
        run(async () => {
          if (!deleting) return;
          await write(accountUrl(deleting.pool, deleting.account.id), 'DELETE');
          deleting = null;
          await load();
        })}>{$t('Confirm delete')}</button
    >
  </Modal>
{/if}
