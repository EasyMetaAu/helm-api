<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { ApiKeyView } from '$lib/api/keys.js';
  import {
    deleteFact,
    deleteReflection,
    type Fact,
    type FactCreateResult,
    type FactQuery,
    type FactStatusFilter,
    getMemoryStats,
    listFacts,
    listReflections,
    type MemoryScope,
    type MemoryStats,
    type Reflection,
    resolveKey,
  } from '$lib/api/memory.js';
  import AddFactDialog from '$lib/components/AddFactDialog.svelte';
  import ConnectMcpDialog from '$lib/components/ConnectMcpDialog.svelte';
  import EditFactDialog from '$lib/components/EditFactDialog.svelte';
  import EditReflectionDialog from '$lib/components/EditReflectionDialog.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import RefreshControl from '$lib/components/RefreshControl.svelte';
  import { formatTimestamp } from '$lib/format.js';
  import { paginationItems } from '$lib/pagination.js';
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
  }: {
    data: {
      scopes: MemoryScope[];
      keys: ApiKeyView[];
      initialStats?: MemoryStats;
      initialKeyId?: string | null;
    };
  } = $props();

  const scopes = untrack(() => data.scopes);
  const keys = untrack(() => data.keys);
  const initialStats = untrack(() => data.initialStats ?? null);

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
  let statsError = $state<string | null>(null);
  // Neutral (non-error) feedback line — e.g. "fact added" / "already existed". Cleared
  // whenever an error is raised or a new selection is made.
  let notice = $state<string | null>(null);
  let stats = $state<MemoryStats | null>(initialStats);

  // Facts table state. The list is paginated + searchable client-side (facts load on
  // selection, not via the loader), so page/search live here and drive loadFacts.
  const FACT_PAGE_SIZE = 25;
  let facts = $state<Fact[]>([]);
  let factsTotal = $state<number>(0);
  let factStatus = $state<FactStatusFilter>('active');
  let factSearch = $state<string>('');
  let factPage = $state<number>(1);
  let loadingFacts = $state<boolean>(false);
  // "Add fact" dialog — opened from the Facts toolbar, scoped to the current selection.
  let showAddFact = $state<boolean>(false);

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

  function compactNumber(value: number): string {
    return new Intl.NumberFormat().format(value);
  }

  function ageFromNow(
    iso: string | null,
    baseIso: string | null = stats?.generatedAt ?? null,
  ): string {
    if (iso === null || baseIso === null) return '—';
    const delta = Math.max(0, new Date(baseIso).getTime() - new Date(iso).getTime());
    const minutes = Math.floor(delta / 60_000);
    if (minutes < 1) return $t('<1m');
    if (minutes < 60) return $t('{count}m', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return $t('{count}h', { count: hours });
    return $t('{count}d', { count: Math.floor(hours / 24) });
  }

  function statsBadge(s: MemoryStats | null): { cls: string; text: string } {
    if (s === null) return { cls: 'badge-neutral', text: $t('Unknown') };
    if (s.queue.staleRunning > 0) return { cls: 'badge-neutral', text: $t('Stale jobs') };
    if (s.queue.running > 0) return { cls: 'badge-ok', text: $t('Running') };
    if (s.queue.pending > 0) return { cls: 'badge-neutral', text: $t('Queued') };
    return { cls: 'badge-neutral', text: $t('Idle') };
  }

  const statsScopeLabel = $derived(
    selected === null ? $t('All memory') : `${selectionLabel} · ${selected.accountId}`,
  );
  const statusBadge = $derived(statsBadge(stats));

  async function loadStats(scope: SelectedScope | null = selected): Promise<void> {
    statsError = null;
    try {
      stats = await getMemoryStats(scope === null ? {} : scopeQuery(scope));
    } catch (e) {
      statsError = e instanceof Error ? e.message : $t('Failed to load memory status');
    }
  }

  async function loadFacts(): Promise<void> {
    if (selected === null) return;
    loadingFacts = true;
    try {
      const page = await listFacts({
        ...scopeQuery(selected),
        status: factStatus,
        ...(factSearch.trim() ? { search: factSearch.trim() } : {}),
        limit: FACT_PAGE_SIZE,
        offset: (factPage - 1) * FACT_PAGE_SIZE,
      });
      facts = page.rows;
      factsTotal = page.total;
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to load facts');
    } finally {
      loadingFacts = false;
    }
  }

  // Pager: total pages from the server count, plus the number/ellipsis row.
  const factTotalPages = $derived(Math.max(1, Math.ceil(factsTotal / FACT_PAGE_SIZE)));
  const factPageItems = $derived(paginationItems(factPage, factTotalPages));

  // Any change that alters the result set resets to page 1 before reloading.
  function reloadFactsFromFirstPage(): void {
    factPage = 1;
    void loadFacts();
  }
  function goFactPage(n: number): void {
    if (n < 1 || n > factTotalPages || n === factPage) return;
    factPage = n;
    void loadFacts();
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
    notice = null;
    selected = s;
    selectionLabel = label;
    factStatus = 'active';
    factSearch = '';
    factPage = 1;
    await Promise.all([loadFacts(), loadReflections(), loadStats(s)]);
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
      void loadStats(null);
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
    void loadStats();
  }

  // After adding a fact: close, jump to the live (Active) view's first page so the new
  // row is visible, and surface what reconciliation did — a re-added identical fact is
  // a no-op (deduped), and a same-subject add replaces the older one (superseded).
  function onFactCreated(result: FactCreateResult): void {
    showAddFact = false;
    error = null;
    notice = result.deduped
      ? $t('That fact already exists — no duplicate was created.')
      : result.superseded.length > 0
        ? $t('Fact added — it replaced an older fact on the same subject.')
        : $t('Fact added.');
    factStatus = 'active';
    factSearch = '';
    reloadFactsFromFirstPage();
    void loadStats();
  }

  function startEditReflection(r: Reflection): void {
    error = null;
    editingReflection = r;
  }

  function onReflectionSaved(updated: Reflection): void {
    reflections = reflections.map((r) => (r.id === updated.id ? updated : r));
    editingReflection = null;
    void loadStats();
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
      await Promise.all([loadFacts(), loadStats()]);
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
      await Promise.all([loadReflections(), loadStats()]);
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
    } else if (initialStats === null) {
      void loadStats(null);
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
  {#if notice}
    <p
      class="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
      role="status"
    >
      {notice}
    </p>
  {/if}

  <section data-testid="memory-stats" class="flex flex-col gap-3">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="section-header">{$t('Memory status')}</h2>
          <span class={statusBadge.cls}>{statusBadge.text}</span>
        </div>
        <p class="section-desc font-mono">{statsScopeLabel}</p>
      </div>
      <RefreshControl onRefresh={() => loadStats()} />
    </div>
    {#if statsError}
      <p class="alert-error" role="alert">{statsError}</p>
    {/if}
    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <div class="card flex flex-col gap-2">
        <p class="text-xs uppercase tracking-wide text-ink-muted">{$t('Queue')}</p>
        <p class="text-2xl font-semibold text-ink-strong">
          {stats ? compactNumber(stats.queue.open) : '—'}
        </p>
        <div class="flex flex-wrap gap-2 text-xs text-ink-muted">
          <span>{$t('{count} pending', { count: stats?.queue.pending ?? 0 })}</span>
          <span>{$t('{count} running', { count: stats?.queue.running ?? 0 })}</span>
          <span>{$t('{count} stale', { count: stats?.queue.staleRunning ?? 0 })}</span>
        </div>
      </div>
      <div class="card flex flex-col gap-2">
        <p class="text-xs uppercase tracking-wide text-ink-muted">{$t('Lag')}</p>
        <p class="text-2xl font-semibold text-ink-strong">
          {stats ? ageFromNow(stats.queue.oldestPendingAt) : '—'}
        </p>
        <div class="flex flex-col gap-1 text-xs text-ink-muted">
          <span>{$t('Oldest pending')}</span>
          <span
            >{$t('Oldest running: {age}', {
              age: ageFromNow(stats?.queue.oldestRunningAt ?? null),
            })}</span
          >
        </div>
      </div>
      <div class="card flex flex-col gap-2">
        <p class="text-xs uppercase tracking-wide text-ink-muted">{$t('Raw input')}</p>
        <p class="text-2xl font-semibold text-ink-strong">
          {stats ? compactNumber(stats.storage.messages) : '—'}
        </p>
        <div class="flex flex-wrap gap-2 text-xs text-ink-muted">
          <span>{$t('{count} threads', { count: stats?.storage.threads ?? 0 })}</span>
          <span>{$t('{count} observations', { count: stats?.storage.observations ?? 0 })}</span>
        </div>
      </div>
      <div class="card flex flex-col gap-2">
        <p class="text-xs uppercase tracking-wide text-ink-muted">{$t('Learned')}</p>
        <p class="text-2xl font-semibold text-ink-strong">
          {stats ? compactNumber(stats.storage.activeFacts + stats.storage.activeReflections) : '—'}
        </p>
        <div class="flex flex-wrap gap-2 text-xs text-ink-muted">
          <span>{$t('{count} active facts', { count: stats?.storage.activeFacts ?? 0 })}</span>
          <span
            >{$t('{count} active reflections', {
              count: stats?.storage.activeReflections ?? 0,
            })}</span
          >
        </div>
      </div>
    </div>
    <div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
      <div class="card flex flex-col gap-2 text-sm">
        <p class="text-xs uppercase tracking-wide text-ink-muted">{$t('Activity')}</p>
        <div class="grid gap-2 sm:grid-cols-2">
          <div>
            <p class="text-ink-muted">{$t('Last raw message')}</p>
            <p class="text-ink-strong">
              {stats?.activity.lastMessageAt ? formatTimestamp(stats.activity.lastMessageAt) : '—'}
            </p>
          </div>
          <div>
            <p class="text-ink-muted">{$t('Last observation')}</p>
            <p class="text-ink-strong">
              {stats?.activity.lastObservationAt
                ? formatTimestamp(stats.activity.lastObservationAt)
                : '—'}
            </p>
          </div>
          <div>
            <p class="text-ink-muted">{$t('Last completed job')}</p>
            <p class="text-ink-strong">
              {stats?.queue.newestDoneAt ? formatTimestamp(stats.queue.newestDoneAt) : '—'}
            </p>
          </div>
          <div>
            <p class="text-ink-muted">{$t('Last refreshed')}</p>
            <p class="text-ink-strong">
              {stats?.generatedAt ? formatTimestamp(stats.generatedAt) : '—'}
            </p>
          </div>
        </div>
      </div>
      <div class="card flex flex-col gap-2 text-sm">
        <p class="text-xs uppercase tracking-wide text-ink-muted">{$t('Jobs by type')}</p>
        {#if stats === null || stats.queue.byType.length === 0}
          <p class="text-ink-muted">—</p>
        {:else}
          <div class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            {#each stats.queue.byType as row (`${row.type}:${row.status}`)}
              <span class="truncate text-ink-muted">{row.type} · {row.status}</span>
              <span class="font-mono text-ink-strong">{compactNumber(row.count)}</span>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </section>

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
    <div class="flex flex-col gap-8">
      <!-- Selected scope header: what the sections below are scoped to. -->
      <div class="border-b border-slate-200 pb-2">
        <p class="text-xs uppercase tracking-wide text-ink-muted">{$t('Scope')}</p>
        <p class="font-mono text-sm text-ink-strong">{selectionLabel}</p>
      </div>

      <!-- Reflections (the merged, slow-changing overview) come FIRST. Rendered as
           cards because the text is long free-form prose — a table cell clips it. -->
      <div class="flex flex-col gap-3">
        <h2 class="section-header">{$t('Reflections')}</h2>
        {#if loadingReflections}
          <p class="section-desc">{$t('Loading…')}</p>
        {:else if reflections.length === 0}
          <div class="empty-state">
            <p>{$t('No reflections for this scope.')}</p>
          </div>
        {:else}
          <div class="flex flex-col gap-3">
            {#each reflections as reflection (reflection.id)}
              <div data-testid="reflection-row" class="card flex flex-col gap-2">
                <div class="flex items-start justify-between gap-3">
                  <div class="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                    {#if reflection.status === 'active'}
                      <span class="badge-ok">{$t('active')}</span>
                    {:else}
                      <span class="badge-neutral">{$t('archived')}</span>
                    {/if}
                    <span>{$t('Version')} {reflection.version}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatTimestamp(reflection.updatedAt)}</span>
                  </div>
                  <div class="flex shrink-0 gap-2">
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
                </div>
                <p class="whitespace-pre-wrap break-words text-sm text-ink-body">
                  {reflection.reflectionText}
                </p>
              </div>
            {/each}
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

      <!-- Facts (the atomic detail) below, with a toolbar: search + status + add. -->
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <h2 class="section-header">{$t('Facts')}</h2>
          <div class="flex flex-wrap items-end gap-2">
            <form
              class="flex items-end gap-2"
              onsubmit={(e) => {
                e.preventDefault();
                reloadFactsFromFirstPage();
              }}
            >
              <input
                type="search"
                class="input w-44"
                aria-label={$t('Search facts')}
                placeholder={$t('Search fact text…')}
                bind:value={factSearch}
              />
              <button type="submit" class="btn-secondary">{$t('Search')}</button>
            </form>
            <label class="flex items-center gap-2 text-sm">
              <span class="field-label">{$t('Status')}</span>
              <select
                class="select w-40"
                aria-label={$t('Fact status filter')}
                value={factStatus}
                onchange={(e) => {
                  factStatus = (e.currentTarget as HTMLSelectElement).value as FactStatusFilter;
                  reloadFactsFromFirstPage();
                }}
              >
                <option value="active">{$t('Active')}</option>
                <option value="superseded">{$t('Superseded')}</option>
                <option value="archived">{$t('Archived')}</option>
                <option value="pruned">{$t('Pruned')}</option>
                <option value="all">{$t('All')}</option>
              </select>
            </label>
            <button
              type="button"
              data-testid="add-fact"
              class="btn-primary-sm"
              onclick={() => {
                notice = null;
                showAddFact = true;
              }}>{$t('Add fact')}</button
            >
          </div>
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
                      <span class="block whitespace-pre-wrap break-words">{fact.factText}</span>
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
          {#if factsTotal > 0}
            <!-- Pager footer (client-side; facts load via $state, not the loader).
                 Mirrors the requests-list pager but with buttons since there is no URL
                 to link to. Shown even on a single page so the total count is visible. -->
            <div
              class="flex flex-col gap-3 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between"
            >
              <span data-testid="pager-status">
                {$t('Page {page} of {pages}', { page: factPage, pages: factTotalPages })} ·
                {$t('{total} facts', { total: factsTotal })}
              </span>
              <nav class="flex items-center gap-1" aria-label={$t('Pagination')}>
                <button
                  type="button"
                  data-testid="pager-prev"
                  class="btn-secondary"
                  disabled={factPage <= 1}
                  onclick={() => goFactPage(factPage - 1)}>{$t('Previous')}</button
                >
                {#each factPageItems as item, i (item === 'ellipsis' ? `e${i}` : item)}
                  {#if item === 'ellipsis'}
                    <span class="px-2 text-ink-muted" aria-hidden="true">…</span>
                  {:else if item === factPage}
                    <span
                      data-testid="pager-page-current"
                      aria-current="page"
                      class="inline-flex h-9 min-w-9 items-center justify-center rounded border border-slate-800 bg-slate-800 px-2 text-sm font-medium text-white"
                      >{item}</span
                    >
                  {:else}
                    <button
                      type="button"
                      data-testid="pager-page"
                      class="inline-flex h-9 min-w-9 cursor-pointer items-center justify-center rounded border border-slate-300 px-2 text-sm text-ink-body transition-colors hover:bg-slate-50"
                      onclick={() => goFactPage(item)}>{item}</button
                    >
                  {/if}
                {/each}
                <button
                  type="button"
                  data-testid="pager-next"
                  class="btn-secondary"
                  disabled={factPage >= factTotalPages}
                  onclick={() => goFactPage(factPage + 1)}>{$t('Next')}</button
                >
              </nav>
            </div>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</section>

{#if showMcp}
  <ConnectMcpDialog onclose={() => (showMcp = false)} />
{/if}

{#if showAddFact && selected !== null}
  <AddFactDialog scope={selected} onsaved={onFactCreated} onclose={() => (showAddFact = false)} />
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
