<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { ApiKeyView } from '$lib/api/keys.js';
  import {
    deleteFact,
    deleteReflection,
    type Fact,
    type FactQuery,
    listFacts,
    listReflections,
    type MemoryScope,
    type MemoryStatus,
    type Reflection,
    resolveKey,
    updateFact,
    updateReflection,
  } from '$lib/api/memory.js';
  import ConnectMcpDialog from '$lib/components/ConnectMcpDialog.svelte';
  import EditFactDialog from '$lib/components/EditFactDialog.svelte';
  import EditReflectionDialog from '$lib/components/EditReflectionDialog.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import { formatTimestamp } from '$lib/format.js';
  import { t } from '$lib/i18n';

  // Memory management view (docs/13). Manages the gateway's long-tier memory: the
  // discrete FACTS it has learned plus the per-scope REFLECTIONS it merges. This
  // is a MANAGEMENT surface — it can show superseded/archived/pruned rows (status
  // filter) and soft-deletes (facts → pruned, reflections → archived) so an
  // operator can curate what the gateway remembers. Pure consumer of
  // /admin/api/memory/* (CLAUDE.md Principle 1); the loader seeds scopes + keys,
  // facts/reflections load on selection.
  let {
    data,
  }: { data: { scopes: MemoryScope[]; keys: ApiKeyView[]; initialKeyId?: string | null } } =
    $props();

  const scopes = untrack(() => data.scopes);
  const keys = untrack(() => data.keys);

  type Tab = 'scope' | 'key';
  let tab = $state<Tab>('scope');

  // The scope currently selected (its facts/reflections fill the tables below).
  // accountId + project/resource/thread together address one memory scope; null
  // means nothing selected yet (empty tables).
  type SelectedScope = {
    accountId: string;
    projectId: string | null;
    resourceId: string | null;
    threadId: string | null;
  };
  let selected = $state<SelectedScope | null>(null);
  // A human label for the current selection, shown above the tables.
  let selectionLabel = $state<string>('');

  // By Key tab: the chosen key_id + a note that memory is account/project shared.
  let selectedKeyId = $state<string>('');

  let error = $state<string | null>(null);

  // Facts table state.
  let facts = $state<Fact[]>([]);
  let factsTotal = $state<number>(0);
  let factStatus = $state<MemoryStatus | 'all'>('active');
  let loadingFacts = $state<boolean>(false);

  // Reflections table state.
  let reflections = $state<Reflection[]>([]);
  let reflectionsTotal = $state<number>(0);
  let loadingReflections = $state<boolean>(false);

  // Edit/delete modal state (one fact / reflection at a time).
  let editingFact = $state<Fact | null>(null);
  let editingReflection = $state<Reflection | null>(null);
  // "Connect via MCP" guide — opened from the header, no minted key (the snippets
  // carry a copy-and-replace placeholder). Mirrors the API Keys "Connect a client".
  let showMcp = $state<boolean>(false);
  let confirmingFactDelete = $state<Fact | null>(null);
  let confirmingReflectionDelete = $state<Reflection | null>(null);

  // Render a scope tuple as a compact "project · resource · thread" label, with
  // an em-dash for each absent level (account-wide facts have all three null).
  function scopeLabel(s: {
    projectId: string | null;
    resourceId: string | null;
    threadId: string | null;
  }): string {
    const parts = [s.projectId, s.resourceId, s.threadId].map((v) => v ?? '—');
    return parts.join(' · ');
  }

  function sameScope(a: SelectedScope, b: SelectedScope): boolean {
    return (
      a.accountId === b.accountId &&
      a.projectId === b.projectId &&
      a.resourceId === b.resourceId &&
      a.threadId === b.threadId
    );
  }

  // Shared scope→query mapping. A null level is OMITTED (the server treats a
  // missing param as "no filter at that level"), so an account-wide scope (all
  // null) lists every fact under the account.
  function scopeQuery(s: SelectedScope): FactQuery {
    const q: FactQuery = { accountId: s.accountId };
    if (s.projectId !== null) q.projectId = s.projectId;
    if (s.resourceId !== null) q.resourceId = s.resourceId;
    if (s.threadId !== null) q.threadId = s.threadId;
    return q;
  }

  async function loadFacts(): Promise<void> {
    if (selected === null) return;
    loadingFacts = true;
    try {
      const page = await listFacts({ ...scopeQuery(selected), status: factStatus });
      facts = page.rows;
      factsTotal = page.total;
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to load facts');
    } finally {
      loadingFacts = false;
    }
  }

  async function loadReflections(): Promise<void> {
    if (selected === null) return;
    loadingReflections = true;
    try {
      const page = await listReflections({ ...scopeQuery(selected), status: 'all' });
      reflections = page.rows;
      reflectionsTotal = page.total;
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to load reflections');
    } finally {
      loadingReflections = false;
    }
  }

  // Select a scope (from either tab) and load both tables. Resetting the status
  // filter to "active" keeps a fresh selection focused on live facts.
  async function selectScope(s: SelectedScope, label: string): Promise<void> {
    error = null;
    selected = s;
    selectionLabel = label;
    factStatus = 'active';
    await Promise.all([loadFacts(), loadReflections()]);
  }

  function pickScopeRow(s: MemoryScope): void {
    void selectScope(
      {
        accountId: s.accountId,
        projectId: s.projectId,
        resourceId: s.resourceId,
        threadId: s.threadId,
      },
      scopeLabel(s),
    );
  }

  // By Key: resolve the key to its account + default project, then load that
  // scope (resource/thread null = the account/project-wide view).
  async function pickKey(keyId: string): Promise<void> {
    selectedKeyId = keyId;
    if (keyId === '') {
      selected = null;
      selectionLabel = '';
      facts = [];
      reflections = [];
      return;
    }
    error = null;
    try {
      const scope = await resolveKey(keyId);
      const key = keys.find((k) => k.key_id === keyId);
      const label = key?.name && key.name.length > 0 ? key.name : (key?.prefix ?? keyId);
      await selectScope(
        {
          accountId: scope.accountId,
          projectId: scope.projectId,
          resourceId: null,
          threadId: null,
        },
        label,
      );
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to resolve key');
    }
  }

  // A status badge for a fact: active rows superseded by a newer fact (active but
  // expiredAt set) read "superseded"; archived/pruned use the neutral pill.
  function factBadge(f: Fact): { cls: string; text: string } {
    if (f.status === 'active') {
      if (f.expiredAt !== null) return { cls: 'badge-neutral', text: $t('superseded') };
      return { cls: 'badge-ok', text: $t('active') };
    }
    return { cls: 'badge-neutral', text: f.status === 'archived' ? $t('archived') : $t('pruned') };
  }

  function startEditFact(f: Fact): void {
    error = null;
    editingFact = f;
  }

  function onFactSaved(updated: Fact): void {
    facts = facts.map((f) => (f.id === updated.id ? updated : f));
    editingFact = null;
    // The status filter may now exclude the edited row — re-fetch to reflect it.
    void loadFacts();
  }

  function startEditReflection(r: Reflection): void {
    error = null;
    editingReflection = r;
  }

  function onReflectionSaved(updated: Reflection): void {
    reflections = reflections.map((r) => (r.id === updated.id ? updated : r));
    editingReflection = null;
  }

  function askDeleteFact(f: Fact): void {
    error = null;
    confirmingFactDelete = f;
  }

  async function confirmDeleteFact(): Promise<void> {
    const f = confirmingFactDelete;
    if (f === null) return;
    error = null;
    try {
      await deleteFact(f.id);
      confirmingFactDelete = null;
      await loadFacts();
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to delete fact');
    }
  }

  function askDeleteReflection(r: Reflection): void {
    error = null;
    confirmingReflectionDelete = r;
  }

  async function confirmDeleteReflection(): Promise<void> {
    const r = confirmingReflectionDelete;
    if (r === null) return;
    error = null;
    try {
      await deleteReflection(r.id);
      confirmingReflectionDelete = null;
      await loadReflections();
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to delete reflection');
    }
  }

  // Deep link from a key's detail page (/memory?key=<keyId>): open on the By Key tab
  // pre-selected to that key and load its memory — the same path as picking it from
  // the dropdown. Ignored when the key isn't in the list (stale link / deleted key).
  onMount(() => {
    const id = data.initialKeyId;
    if (id && keys.some((k) => k.key_id === id)) {
      tab = 'key';
      void pickKey(id);
    }
  });
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
    <div class="min-w-0">
      <h1 class="page-title">{$t('Memory')}</h1>
      <p class="section-desc">
        {$t(
          'Manage the long-term memory the gateway has learned — the discrete facts it remembers and the per-scope reflections it merges. Browse by scope or by key, then edit or remove what it keeps.',
        )}
      </p>
    </div>
    <div class="flex shrink-0 gap-2">
      <button type="button" class="btn-secondary" onclick={() => (showMcp = true)}
        >{$t('Connect via MCP')}</button
      >
    </div>
  </header>

  {#if error}
    <p class="alert-error" role="alert">{error}</p>
  {/if}

  <!-- Tab switcher: By Scope / By Key. aria-selected drives both a11y + style. -->
  <div class="flex gap-2" role="tablist">
    <button
      type="button"
      role="tab"
      aria-selected={tab === 'scope'}
      class={tab === 'scope' ? 'btn-primary-sm' : 'btn-secondary'}
      onclick={() => (tab = 'scope')}>{$t('By Scope')}</button
    >
    <button
      type="button"
      role="tab"
      aria-selected={tab === 'key'}
      class={tab === 'key' ? 'btn-primary-sm' : 'btn-secondary'}
      onclick={() => (tab = 'key')}>{$t('By Key')}</button
    >
  </div>

  {#if tab === 'scope'}
    {#if scopes.length === 0}
      <div class="empty-state">
        <p>{$t('No memory yet. The gateway forms facts and reflections as it serves traffic.')}</p>
      </div>
    {:else}
      <div class="cards-table-frame">
        <table class="cards-table">
          <thead class="table-head">
            <tr>
              <th class="px-3 py-2">{$t('Project')}</th>
              <th class="px-3 py-2">{$t('Resource')}</th>
              <th class="px-3 py-2">{$t('Thread')}</th>
              <th class="px-3 py-2">{$t('Facts')}</th>
              <th class="px-3 py-2">{$t('Reflections')}</th>
              <th class="px-3 py-2">{$t('Last updated')}</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {#each scopes as scope (scope.accountId + '|' + scope.projectId + '|' + scope.resourceId + '|' + scope.threadId)}
              {@const isSelected =
                selected !== null &&
                sameScope(selected, {
                  accountId: scope.accountId,
                  projectId: scope.projectId,
                  resourceId: scope.resourceId,
                  threadId: scope.threadId,
                })}
              <tr
                data-testid="scope-row"
                class="cursor-pointer align-top {isSelected ? 'bg-indigo-50' : ''}"
                onclick={() => pickScopeRow(scope)}
              >
                <td data-label={$t('Project')} class="px-3 py-2">
                  <span class="text-ink-strong">{scope.projectId ?? '—'}</span>
                </td>
                <td data-label={$t('Resource')} class="px-3 py-2 text-ink-muted">
                  {scope.resourceId ?? '—'}
                </td>
                <td data-label={$t('Thread')} class="px-3 py-2 text-ink-muted">
                  {scope.threadId ?? '—'}
                </td>
                <td data-label={$t('Facts')} class="px-3 py-2 text-ink-body">{scope.factCount}</td>
                <td data-label={$t('Reflections')} class="px-3 py-2 text-ink-body"
                  >{scope.reflectionCount}</td
                >
                <td data-label={$t('Last updated')} class="px-3 py-2 text-ink-muted">
                  {scope.lastUpdated ? formatTimestamp(scope.lastUpdated) : '—'}
                </td>
                <td class="px-3 py-2 lg:text-right">
                  <button type="button" class="btn-secondary" onclick={() => pickScopeRow(scope)}
                    >{$t('View')}</button
                  >
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {:else}
    <div class="card flex flex-col gap-2">
      <label class="field-label" for="memory-key-select">{$t('Key')}</label>
      <select
        id="memory-key-select"
        class="select"
        aria-label={$t('Key')}
        value={selectedKeyId}
        onchange={(e) => pickKey((e.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">{$t('Select a key…')}</option>
        {#each keys as key (key.key_id)}
          <option value={key.key_id}
            >{key.name && key.name.length > 0 ? key.name : key.prefix}</option
          >
        {/each}
      </select>
      <p class="field-help">
        {$t(
          "Showing memory for this key's account + default project (memory is shared across keys on the same account/project).",
        )}
      </p>
    </div>
  {/if}

  {#if selected !== null}
    <div class="flex flex-col gap-6">
      <!-- Facts section -->
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div class="min-w-0">
            <h2 class="section-header">{$t('Facts')}</h2>
            <p class="section-desc">
              {$t('Scope')}: <span class="font-mono">{selectionLabel}</span>
            </p>
          </div>
          <label class="flex items-center gap-2 text-sm">
            <span class="field-label">{$t('Status')}</span>
            <select
              class="select w-40"
              aria-label={$t('Fact status filter')}
              value={factStatus}
              onchange={(e) => {
                factStatus = (e.currentTarget as HTMLSelectElement).value as MemoryStatus | 'all';
                void loadFacts();
              }}
            >
              <option value="active">{$t('Active')}</option>
              <option value="all">{$t('All')}</option>
              <option value="archived">{$t('Archived')}</option>
              <option value="pruned">{$t('Pruned')}</option>
            </select>
          </label>
        </div>

        {#if loadingFacts}
          <p class="section-desc">{$t('Loading…')}</p>
        {:else if facts.length === 0}
          <div class="empty-state">
            <p>{$t('No facts for this scope and filter.')}</p>
          </div>
        {:else}
          <div class="cards-table-frame">
            <table class="cards-table">
              <thead class="table-head">
                <tr>
                  <th class="px-3 py-2">{$t('Subject')}</th>
                  <th class="px-3 py-2">{$t('Fact')}</th>
                  <th class="px-3 py-2">{$t('Status')}</th>
                  <th class="px-3 py-2">{$t('Importance')}</th>
                  <th class="px-3 py-2">{$t('Updated')}</th>
                  <th class="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {#each facts as fact (fact.id)}
                  {@const badge = factBadge(fact)}
                  <tr data-testid="fact-row" class="align-top">
                    <td data-label={$t('Subject')} class="px-3 py-2">
                      <span class="font-mono text-ink-strong">{fact.subjectKey}</span>
                    </td>
                    <td data-label={$t('Fact')} class="px-3 py-2 text-ink-body">
                      <span class="block max-w-md whitespace-normal">{fact.factText}</span>
                    </td>
                    <td data-label={$t('Status')} class="px-3 py-2">
                      <span class={badge.cls}>{badge.text}</span>
                    </td>
                    <td data-label={$t('Importance')} class="px-3 py-2 text-ink-muted">
                      {fact.importance.toFixed(2)}
                    </td>
                    <td data-label={$t('Updated')} class="px-3 py-2 text-ink-muted">
                      {formatTimestamp(fact.updatedAt)}
                    </td>
                    <td class="px-3 py-2 lg:text-right">
                      <div class="flex justify-end gap-2">
                        <button
                          type="button"
                          class="btn-secondary"
                          onclick={() => startEditFact(fact)}>{$t('Edit')}</button
                        >
                        <button
                          type="button"
                          class="btn-danger-outline"
                          onclick={() => askDeleteFact(fact)}>{$t('Delete')}</button
                        >
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if factsTotal > facts.length}
            <p class="section-desc">
              {$t('Showing {count} of {total} facts.', { count: facts.length, total: factsTotal })}
            </p>
          {/if}
        {/if}
      </div>

      <!-- Reflections section -->
      <div class="flex flex-col gap-3">
        <h2 class="section-header">{$t('Reflections')}</h2>
        {#if loadingReflections}
          <p class="section-desc">{$t('Loading…')}</p>
        {:else if reflections.length === 0}
          <div class="empty-state">
            <p>{$t('No reflections for this scope.')}</p>
          </div>
        {:else}
          <div class="cards-table-frame">
            <table class="cards-table">
              <thead class="table-head">
                <tr>
                  <th class="px-3 py-2">{$t('Text')}</th>
                  <th class="px-3 py-2">{$t('Version')}</th>
                  <th class="px-3 py-2">{$t('Status')}</th>
                  <th class="px-3 py-2">{$t('Updated')}</th>
                  <th class="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {#each reflections as reflection (reflection.id)}
                  <tr data-testid="reflection-row" class="align-top">
                    <td data-label={$t('Text')} class="px-3 py-2 text-ink-body">
                      <span class="block max-w-lg truncate">{reflection.reflectionText}</span>
                    </td>
                    <td data-label={$t('Version')} class="px-3 py-2 text-ink-muted"
                      >{reflection.version}</td
                    >
                    <td data-label={$t('Status')} class="px-3 py-2">
                      {#if reflection.status === 'active'}
                        <span class="badge-ok">{$t('active')}</span>
                      {:else}
                        <span class="badge-neutral">{$t('archived')}</span>
                      {/if}
                    </td>
                    <td data-label={$t('Updated')} class="px-3 py-2 text-ink-muted">
                      {formatTimestamp(reflection.updatedAt)}
                    </td>
                    <td class="px-3 py-2 lg:text-right">
                      <div class="flex justify-end gap-2">
                        <button
                          type="button"
                          class="btn-secondary"
                          onclick={() => startEditReflection(reflection)}>{$t('Edit')}</button
                        >
                        <button
                          type="button"
                          class="btn-danger-outline"
                          onclick={() => askDeleteReflection(reflection)}>{$t('Delete')}</button
                        >
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if reflectionsTotal > reflections.length}
            <p class="section-desc">
              {$t('Showing {count} of {total} reflections.', {
                count: reflections.length,
                total: reflectionsTotal,
              })}
            </p>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</section>

{#if showMcp}
  <ConnectMcpDialog onclose={() => (showMcp = false)} />
{/if}

{#if editingFact}
  <EditFactDialog fact={editingFact} onsaved={onFactSaved} onclose={() => (editingFact = null)} />
{/if}

{#if editingReflection}
  <EditReflectionDialog
    reflection={editingReflection}
    onsaved={onReflectionSaved}
    onclose={() => (editingReflection = null)}
  />
{/if}

{#if confirmingFactDelete}
  <Modal label={$t('Confirm delete')} onclose={() => (confirmingFactDelete = null)}>
    <h2 class="section-header">{$t('Delete fact')}</h2>
    <p class="mt-2 text-sm text-amber-800">
      {$t(
        'Remove this fact from memory? It is soft-deleted (pruned) — the gateway stops using it.',
      )}
    </p>
    <p class="mt-2 max-w-full whitespace-normal text-sm text-ink-body">
      {confirmingFactDelete.factText}
    </p>
    <div class="mt-4 flex justify-end gap-2">
      <button type="button" class="btn-secondary" onclick={() => (confirmingFactDelete = null)}
        >{$t('Cancel')}</button
      >
      <button type="button" class="btn-danger" onclick={confirmDeleteFact}>{$t('Delete')}</button>
    </div>
  </Modal>
{/if}

{#if confirmingReflectionDelete}
  <Modal label={$t('Confirm delete')} onclose={() => (confirmingReflectionDelete = null)}>
    <h2 class="section-header">{$t('Delete reflection')}</h2>
    <p class="mt-2 text-sm text-amber-800">
      {#if confirmingReflectionDelete.status === 'active'}
        {$t(
          'Remove this reflection? It is soft-deleted (archived) — the gateway stops injecting it.',
        )}
      {:else}
        {$t(
          'This reflection is already archived. Deleting it now removes it permanently and cannot be undone.',
        )}
      {/if}
    </p>
    <div class="mt-4 flex justify-end gap-2">
      <button
        type="button"
        class="btn-secondary"
        onclick={() => (confirmingReflectionDelete = null)}>{$t('Cancel')}</button
      >
      <button type="button" class="btn-danger" onclick={confirmDeleteReflection}
        >{$t('Delete')}</button
      >
    </div>
  </Modal>
{/if}
