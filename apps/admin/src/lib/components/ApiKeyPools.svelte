<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    ApiKeyPoolsViewSchema,
    apiKeyMatchesProvider,
    ApiKeyTestResultSchema,
    type ApiKeyTestResult,
    type ApiKeyPoolView,
    type ApiKeyAccountView,
  } from '@helm/shared';
  import { t, locale } from '$lib/i18n';
  import { formatCount, formatTokens, formatUsd } from '$lib/format';
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
  let testTarget = $state<{ pool: ApiKeyPoolView; account: ApiKeyAccountView } | null>(null);
  let testModel = $state('');
  let testResult = $state<ApiKeyTestResult | null>(null);
  let testBusy = $state(false);
  let testError = $state('');
  let testAbort: AbortController | null = null;
  let batchPool = $state<ApiKeyPoolView | null>(null);
  let batchModel = $state('');
  let batchBusy = $state(false);
  let batchResults = $state<Array<{ name: string; result?: ApiKeyTestResult; error?: string }>>([]);
  let batchAbort: AbortController | null = null;
  const recoverable = (account: ApiKeyAccountView) =>
    account.enabled &&
    account.state !== 'invalid' &&
    (account.state !== 'ready' || account.deniedModels.length > 0) &&
    !(account.probeUntil && account.probeUntil > Date.now());
  const defaultTestModel = (choices: string[]) =>
    choices.find((m) => m === 'gpt-6-luna') ??
    choices.find((m) => m.includes('haiku')) ??
    choices[0] ??
    '';
  function closeBatch() {
    batchAbort?.abort();
    batchPool = null;
  }
  async function runBatch() {
    if (!batchPool || batchBusy) return;
    const pool = batchPool;
    const model = batchModel;
    const controller = new AbortController();
    batchAbort = controller;
    batchBusy = true;
    batchResults = [];
    try {
      for (const account of pool.accounts.filter(
        (a) => recoverable(a) && testModels(pool, a).includes(model),
      )) {
        if (controller.signal.aborted) break;
        try {
          const result = await requestTest(pool.id, account.id, model, controller.signal);
          batchResults = [...batchResults, { name: account.name, result }];
        } catch {
          if (!controller.signal.aborted)
            batchResults = [
              ...batchResults,
              {
                name: account.name,
                error: $t('API key test could not start. Refresh and try again.'),
              },
            ];
        }
      }
      await run(load);
    } finally {
      batchBusy = false;
      batchAbort = null;
    }
  }
  async function requestTest(pool: string, id: string, model: string, signal: AbortSignal) {
    const res = await fetch(`${accountUrl(pool, id)}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal,
    });
    if (!res.ok) throw new Error($t('API key test could not start. Refresh and try again.'));
    return ApiKeyTestResultSchema.parse(await res.json());
  }
  const testModels = (pool: ApiKeyPoolView, account: ApiKeyAccountView) =>
    pool.models.filter(
      (model) =>
        (account.models === null || account.models.includes(model)) &&
        !/image|realtime|audio|live|tts|whisper|transcri/i.test(model),
    );
  function openTest(pool: ApiKeyPoolView, account: ApiKeyAccountView) {
    testTarget = { pool, account };
    const choices = testModels(pool, account);
    testModel = defaultTestModel(choices);
    testResult = null;
    testError = '';
  }
  function closeTest() {
    testAbort?.abort();
    testTarget = null;
  }
  onDestroy(() => {
    testAbort?.abort();
    batchAbort?.abort();
  });
  async function testAccount() {
    if (!testTarget || testBusy) return;
    testBusy = true;
    testResult = null;
    testError = '';
    const controller = new AbortController();
    testAbort = controller;
    try {
      testResult = await requestTest(
        testTarget.pool.id,
        testTarget.account.id,
        testModel,
        controller.signal,
      );
      await run(load);
    } catch (e) {
      if (!controller.signal.aborted)
        testError = $t('API key test could not start. Refresh and try again.');
    } finally {
      testBusy = false;
      testAbort = null;
    }
  }
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
  const poolName = (pool: ApiKeyPoolView) =>
    pool.type === 'anthropic' ? 'Claude (Anthropic)' : pool.id === 'openai' ? 'OpenAI' : pool.id;
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
    const pool = pools.find((entry) => entry.id === adding);
    if (!pool || lines.some((key) => !apiKeyMatchesProvider(key, pool.type))) {
      error = $t('API key does not match the selected provider type');
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
  const statusClass = (account: ApiKeyAccountView) =>
    !account.enabled
      ? 'badge-neutral'
      : account.state === 'ready'
        ? 'badge-ok'
        : account.state === 'invalid'
          ? 'badge-error'
          : 'badge-warning';
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

<section class="mt-2 flex flex-col gap-2" aria-label={$t('API key providers')}>
  <header class="flex flex-wrap items-center gap-x-4 gap-y-2">
    <h2 class="section-header" title={$t('Rotate model API keys across accounts.')}>
      {$t('API key providers')}
    </h2>
    <div class="ml-auto flex items-center gap-2">
      <button
        type="button"
        class="btn-secondary shrink-0"
        disabled={busy}
        onclick={() => run(load)}
      >
        <svg
          class="size-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
          ><path d="M20 7v5h-5M4 17v-5h5" /><path
            d="M6.1 7a7 7 0 0 1 11.55-1.7L20 8M4 16l2.35 2.7A7 7 0 0 0 17.9 17"
          /></svg
        >
        {$t('Refresh API keys')}
      </button>
      <button
        type="button"
        class="btn-primary"
        disabled={busy || !pools.some((pool) => pool.configured)}
        onclick={() => {
          adding = pools.find((pool) => pool.configured)?.id ?? null;
          keys = '';
          error = '';
        }}>{$t('Add API keys')}</button
      >
    </div>
  </header>
  <div class="flex flex-col gap-4">
    {#if error}<p role="alert" class="alert-error">{error}</p>{/if}
    {#each pools as pool (pool.id)}
      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3 class="text-sm font-semibold text-ink">
            {poolName(pool)}
          </h3>
          <span class="field-help">
            {#if pool.type === 'anthropic'}
              {$t('Out of credit: paused until you add credit and retry.')}
            {:else}
              {$t('Monthly retry timezone')}: {pool.timezone} · {$t('Day 1, 00:00')}
            {/if}
          </span>
          <div class="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
            <button
              type="button"
              class="btn-secondary shrink-0"
              disabled={busy ||
                testBusy ||
                batchBusy ||
                !pool.accounts.some((a) => recoverable(a) && testModels(pool, a).length > 0)}
              onclick={() => {
                batchPool = pool;
                batchResults = [];
                batchModel = defaultTestModel(
                  pool.models.filter((model) =>
                    pool.accounts.some(
                      (a) => recoverable(a) && testModels(pool, a).includes(model),
                    ),
                  ),
                );
              }}>{$t('Batch test and recover')}</button
            >
            <select
              aria-label={$t('API key rotation strategy')}
              class="select h-11 min-w-0 flex-1 sm:h-9 sm:w-40 sm:flex-none"
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
              <option value="round_robin">{$t('Round robin')}</option><option
                value="manual_priority">{$t('Manual priority')}</option
              >
            </select>
          </div>
        </div>
        {#if !pool.configured}<p class="alert-warn">
            {$t('Encrypted credential storage is not configured.')}
          </p>{/if}
        {#if pool.accounts.length === 0}
          <div class="empty-state">
            {$t(
              'No managed API keys. Existing environment credentials remain in use only until the pool is first configured.',
            )}
          </div>
        {:else}
          <div class="cards-table-frame compact overflow-visible">
            <table class="cards-table">
              <thead class="table-head"
                ><tr>
                  <th class="px-3 py-2 table-mode:w-[30%]">{$t('Account')}</th>
                  <th class="px-3 py-2 table-mode:w-[25%]">{$t('Status')}</th>
                  <th class="px-3 py-2">{$t('Usage (last 24 hours)')}</th>
                  {#if pool.strategy === 'manual_priority'}<th class="px-3 py-2"
                      >{$t('Priority')}</th
                    >{/if}
                  <th class="px-3 py-2 table-mode:text-right">{$t('Actions')}</th>
                </tr></thead
              >
              <tbody>
                {#each pool.accounts as account (account.id)}
                  {@const usage = pool.usage.find((row) => row.account === account.id)}
                  <tr>
                    <td data-label={$t('Account')}
                      ><div class="font-medium text-ink-strong">{account.name}</div>
                      <code class="mt-0.5 block text-xs text-ink-muted">{account.mask}</code></td
                    >
                    <td data-label={$t('Status')}>
                      <span class={statusClass(account)}>{stateLabel(account)}</span>
                      {#if account.reason}<details class="mt-1 text-xs text-ink-muted">
                          <summary
                            class="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-offset-2"
                            >{$t('Details')}</summary
                          >
                          <p class="mt-1 max-w-xs whitespace-normal break-words">
                            {account.reason}
                            {#if account.reasonMessage}<span class="mt-1 block"
                                >{account.reasonMessage}</span
                              >{/if}
                          </p>
                        </details>{/if}
                      {#if account.nextRetryAt}<p class="field-help mt-1 whitespace-normal">
                          {$t('Next recovery attempt')}: {new Date(
                            account.nextRetryAt,
                          ).toLocaleString($locale)}
                        </p>{/if}
                      {#if account.probeUntil && account.probeUntil > Date.now()}<p
                          class="field-help mt-1"
                        >
                          {$t('Recovery request in progress')}
                        </p>{/if}
                    </td>
                    <td data-label={$t('Usage (last 24 hours)')} class="tabular-nums">
                      <div class="text-ink-body">
                        {$t('{requests} requests · {tokens} tokens', {
                          requests: formatCount(usage?.requests ?? 0),
                          tokens: formatTokens(usage?.tokens ?? 0),
                        })}
                      </div>
                      <div class="field-help mt-0.5" title={$t('Estimated cost')}>
                        {formatUsd(usage?.costUsd)}
                      </div>
                    </td>
                    {#if pool.strategy === 'manual_priority'}<td
                        data-label={$t('Priority')}
                        class="tabular-nums text-ink-body">{account.priority}</td
                      >{/if}
                    <td>
                      <div class="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          class="btn-secondary"
                          disabled={busy ||
                            testBusy ||
                            batchBusy ||
                            testModels(pool, account).length === 0}
                          onclick={() => openTest(pool, account)}>{$t('Test')}</button
                        >
                        <button
                          type="button"
                          class="btn-secondary"
                          disabled={busy}
                          onclick={() => edit(pool.id, account)}>{$t('Manage')}</button
                        >
                        <details class="menu">
                          <summary
                            class="menu-trigger"
                            title={$t('More actions')}
                            aria-disabled={busy}
                            onclick={(e) => {
                              if (busy) e.preventDefault();
                            }}
                            ><span aria-hidden="true">⋯</span><span class="sr-only"
                              >{$t('More actions')}</span
                            ></summary
                          >
                          <div class="menu-panel w-48">
                            <button
                              type="button"
                              class="menu-item"
                              disabled={busy}
                              onclick={() =>
                                run(async () => {
                                  await write(accountUrl(pool.id, account.id), 'PATCH', {
                                    enabled: !account.enabled,
                                  });
                                  await load();
                                })}>{account.enabled ? $t('Pause') : $t('Resume')}</button
                            >
                            {#if account.enabled && account.state !== 'invalid' && (account.state !== 'ready' || account.deniedModels.length > 0)}
                              <button
                                type="button"
                                class="menu-item"
                                disabled={busy ||
                                  testBusy ||
                                  batchBusy ||
                                  testModels(pool, account).length === 0 ||
                                  Boolean(account.probeUntil && account.probeUntil > Date.now())}
                                onclick={() => {
                                  openTest(pool, account);
                                  void testAccount();
                                }}>{$t('Try recovery')}</button
                              >
                            {/if}
                            <button
                              type="button"
                              class="menu-item-danger"
                              disabled={busy}
                              onclick={() => {
                                deleting = { pool: pool.id, account };
                              }}>{$t('Delete')}</button
                            >
                          </div>
                        </details>
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/each}
  </div>
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
      {#if error}<p role="alert" class="alert-error">{error}</p>{/if}
      <label class="block"
        >{$t('Provider type')}
        <select
          class="select mt-2 w-full"
          aria-label={$t('Provider type')}
          bind:value={adding}
          disabled={busy}
        >
          {#each pools as pool (pool.id)}
            <option value={pool.id} disabled={!pool.configured}>{poolName(pool)}</option>
          {/each}
        </select>
      </label>
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
      <div class="card-actions">
        <button
          type="button"
          class="btn-secondary"
          disabled={busy}
          onclick={() => {
            adding = null;
            keys = '';
          }}>{$t('Cancel')}</button
        ><button class="btn-primary" disabled={busy}>{$t('Save API keys')}</button>
      </div>
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
      <div class="card-actions">
        <button
          type="button"
          class="btn-secondary"
          disabled={busy}
          onclick={() => {
            editing = null;
            replacement = '';
          }}>{$t('Cancel')}</button
        ><button class="btn-primary" disabled={busy}>{$t('Save')}</button>
      </div>
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
    <div class="card-actions">
      <button type="button" class="btn-secondary" disabled={busy} onclick={() => (deleting = null)}
        >{$t('Cancel')}</button
      ><button
        class="btn-danger"
        disabled={busy}
        onclick={() =>
          run(async () => {
            if (!deleting) return;
            await write(accountUrl(deleting.pool, deleting.account.id), 'DELETE');
            deleting = null;
            await load();
          })}>{$t('Confirm delete')}</button
      >
    </div></Modal
  >
{/if}

{#if testTarget}
  <Modal label={$t('Test API key')} onclose={closeTest}>
    <h2 class="section-header mb-4">{$t('Test API key')}</h2>
    <form
      class="space-y-4"
      onsubmit={(event) => {
        event.preventDefault();
        void testAccount();
      }}
    >
      <div>
        <p class="font-medium text-ink-strong">{testTarget.account.name}</p>
        <code class="text-xs text-ink-muted">{testTarget.account.mask}</code>
      </div>
      <p class="field-help">
        {$t(
          'Sends one short request per key. Successful tests clear automatic quota pauses; manually paused keys stay paused. Uses upstream quota.',
        )}
      </p>
      <label class="block"
        ><span class="field-label">{$t('Model')}</span>
        <select
          class="select w-full"
          bind:value={testModel}
          disabled={testBusy}
          onchange={() => {
            testResult = null;
            testError = '';
          }}
        >
          {#each testModels(testTarget.pool, testTarget.account) as model}
            <option value={model}>{model}</option>
          {/each}
        </select>
      </label>
      {#if testError}<p class="alert-error" role="alert">{testError}</p>{/if}
      {#if testResult}
        <div role="status" class="space-y-2">
          <div class="flex items-center gap-2">
            <span class={testResult.ok ? 'badge-ok' : 'badge-error'}
              >{testResult.ok ? $t('Test passed') : $t('Test failed')}</span
            >
            <span class="text-xs text-ink-muted tabular-nums">{testResult.durationMs} ms</span>
          </div>
          {#if testResult.ok}<pre
              class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm whitespace-pre-wrap break-words">{testResult.response}</pre>
          {:else}<p class="alert-error">
              {testResult.error}{testResult.upstreamStatus
                ? ` · HTTP ${testResult.upstreamStatus}`
                : ''}
            </p>{/if}
        </div>
      {/if}
      <div class="card-actions">
        <button type="button" class="btn-secondary" onclick={closeTest}>{$t('Close')}</button>
        <button type="submit" class="btn-primary" disabled={testBusy || !testModel}
          >{testBusy ? $t('Testing…') : $t('Run test')}</button
        >
      </div>
    </form>
  </Modal>
{/if}

{#if batchPool}
  <Modal label={$t('Batch test and recover')} onclose={closeBatch}>
    <h2 class="section-header mb-4">{$t('Batch test and recover')} · {poolName(batchPool)}</h2>
    <p class="field-help mb-4">
      {$t(
        'Sends one short request per key. Successful tests clear automatic quota pauses; manually paused keys stay paused. Uses upstream quota.',
      )}
    </p>
    <form
      class="space-y-4"
      onsubmit={(event) => {
        event.preventDefault();
        void runBatch();
      }}
    >
      <label class="block"
        >{$t('Model')}
        <select
          class="select mt-2 w-full"
          aria-label={$t('Model')}
          bind:value={batchModel}
          disabled={batchBusy}
        >
          {#each batchPool.models.filter( (model) => batchPool!.accounts.some((a) => recoverable(a) && testModels(batchPool!, a).includes(model)), ) as model}
            <option value={model}>{model}</option>
          {/each}
        </select>
      </label>
      <ul class="space-y-2" aria-live="polite">
        {#each batchResults as item}
          <li>
            <span class="font-medium">{item.name}</span> · {item.result?.ok
              ? $t('Test passed')
              : (item.error ?? `${$t('Test failed')}: ${item.result?.error ?? ''}`)}
          </li>
        {/each}
      </ul>
      <div class="card-actions">
        <button type="button" class="btn-secondary" onclick={closeBatch}>{$t('Close')}</button>
        <button
          type="submit"
          class="btn-primary"
          disabled={batchBusy || !batchModel || batchResults.length > 0}
          >{batchBusy ? $t('Testing…') : $t('Run test')}</button
        >
      </div>
    </form>
  </Modal>
{/if}
