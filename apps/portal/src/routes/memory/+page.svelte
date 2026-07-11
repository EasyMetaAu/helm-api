<script lang="ts">
  import { t } from "$lib/i18n";
  import { formatTimestamp } from "$lib/format";
  import { paginationItems } from "$lib/pagination";
  import { getMe, type Me } from "$lib/api/portal";
  import {
    deleteFact,
    deleteReflection,
    factMatchesStatus,
    listAllFacts,
    listAllReflections,
    type Fact,
    type FactCreateResult,
    type FactStatusFilter,
    type Reflection,
  } from "$lib/api/memory";
  import AddFactDialog from "$lib/components/AddFactDialog.svelte";
  import EditFactDialog from "$lib/components/EditFactDialog.svelte";
  import EditReflectionDialog from "$lib/components/EditReflectionDialog.svelte";
  import MemorySettingsDialog from "$lib/components/MemorySettingsDialog.svelte";
  import Modal from "$lib/components/Modal.svelte";
  import RefreshControl from "$lib/components/RefreshControl.svelte";

  const PAGE_SIZE = 25;

  let me = $state<Me | null>(null);
  let facts = $state<Fact[]>([]);
  let reflections = $state<Reflection[]>([]);
  let loading = $state(true);
  let disabled = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);

  let factSearch = $state("");
  let factStatus = $state<FactStatusFilter>("active");
  let factPage = $state(1);
  let showInfo = $state(false);
  let showAddFact = $state(false);
  let showSettings = $state(false);
  let editingFact = $state<Fact | null>(null);
  let editingReflection = $state<Reflection | null>(null);
  let confirmingFactDelete = $state<Fact | null>(null);
  let confirmingReflectionDelete = $state<Reflection | null>(null);

  const sharedPool = $derived(me?.memory.project_name ?? null);

  const filteredFacts = $derived.by(() => {
    const query = factSearch.trim().toLowerCase();
    return facts.filter((fact) => {
      if (!factMatchesStatus(fact, factStatus)) return false;
      if (!query) return true;
      return `${fact.subjectKey} ${fact.factText}`
        .toLowerCase()
        .includes(query);
    });
  });
  const factTotalPages = $derived(
    Math.max(1, Math.ceil(filteredFacts.length / PAGE_SIZE)),
  );
  const factPageItems = $derived(paginationItems(factPage, factTotalPages));
  const pagedFacts = $derived(
    filteredFacts.slice((factPage - 1) * PAGE_SIZE, factPage * PAGE_SIZE),
  );

  $effect(() => {
    if (factPage > factTotalPages) factPage = factTotalPages;
  });

  async function load(): Promise<void> {
    loading = true;
    error = null;
    disabled = false;
    try {
      me = await getMe().catch(() => null);
      // NOTE: memory.mode ('off'/'observe'/'inject') only controls whether THIS key
      // auto-writes memory during chat — it does NOT gate browsing/curating existing
      // facts. The only real gate is whether the /mcp endpoint is enabled at all,
      // which surfaces as a 404 / "not enabled" from the MCP calls below (caught).
      const [nextFacts, nextReflections] = await Promise.all([
        listAllFacts(true),
        listAllReflections(true),
      ]);
      facts = nextFacts;
      reflections = nextReflections;
      factPage = 1;
    } catch (e) {
      if (
        e instanceof Error &&
        (e.message.includes("not enabled") || e.message.includes("404"))
      ) {
        disabled = true;
      } else {
        error = e instanceof Error ? e.message : $t("Failed to load memory");
      }
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  function factBadge(fact: Fact): { cls: string; text: string } {
    if (fact.status === "active") {
      if (fact.superseded)
        return { cls: "badge-neutral", text: $t("superseded") };
      return { cls: "badge-ok", text: $t("active") };
    }
    return { cls: "badge-neutral", text: $t(fact.status) };
  }

  function applyFactSearch(): void {
    factPage = 1;
  }

  function onFactCreated(result: FactCreateResult): void {
    showAddFact = false;
    error = null;
    notice = result.deduped
      ? $t("That fact already exists — no duplicate was created.")
      : result.superseded.length > 0
        ? $t("Fact added — it replaced an older fact on the same subject.")
        : $t("Fact added.");
    factStatus = "active";
    factSearch = "";
    void load();
  }

  function onFactSaved(updated: Fact): void {
    facts = facts.map((fact) => (fact.id === updated.id ? updated : fact));
    editingFact = null;
    notice = $t("Fact updated.");
  }

  function onReflectionSaved(updated: Reflection): void {
    reflections = reflections.map((reflection) =>
      reflection.id === updated.id ? updated : reflection,
    );
    editingReflection = null;
    notice = $t("Reflection updated.");
  }

  function onSettingsSaved(memory: Me["memory"]): void {
    if (me) me = { ...me, memory };
    showSettings = false;
    notice = $t("Saved");
    // A project change selects a different memory pool. Reload immediately so
    // the page never keeps showing facts/reflections from the previous pool.
    void load();
  }

  async function confirmDeleteFact(): Promise<void> {
    const fact = confirmingFactDelete;
    if (!fact) return;
    error = null;
    try {
      await deleteFact(fact.id);
      confirmingFactDelete = null;
      notice = $t("Fact deleted.");
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : $t("Failed to delete fact");
    }
  }

  async function confirmDeleteReflection(): Promise<void> {
    const reflection = confirmingReflectionDelete;
    if (!reflection) return;
    error = null;
    try {
      await deleteReflection(reflection.id);
      confirmingReflectionDelete = null;
      notice = $t("Reflection deleted.");
      await load();
    } catch (e) {
      error =
        e instanceof Error ? e.message : $t("Failed to delete reflection");
    }
  }
</script>

<header
  class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
>
  <div class="min-w-0">
    <div class="flex items-center gap-2">
      <h1 class="page-title">{$t("Memory")}</h1>
      <button
        type="button"
        class="btn-icon"
        aria-label={$t("What is memory?")}
        title={$t("What is memory?")}
        onclick={() => (showInfo = !showInfo)}
      >
        ?
      </button>
    </div>
    <p class="section-desc mt-1">
      {$t("Review and curate what Helm remembers across sessions.")}
    </p>
  </div>
  <div class="flex shrink-0 items-center gap-2">
    <button
      type="button"
      class="btn-secondary"
      disabled={!me}
      onclick={() => (showSettings = true)}
    >
      {$t("Settings")}
    </button>
    <RefreshControl onRefresh={load} />
  </div>
</header>

{#if showInfo}
  <div class="alert-warn mb-4">
    <p class="font-medium">{$t("What Helm remembers")}</p>
    <p class="mt-1">
      {$t(
        "Facts are small statements Helm can reuse later. Reflections are longer summaries distilled from past work. Memory can carry across sessions, and you can add, edit, or delete it here.",
      )}
    </p>
    <p class="mt-2">
      {$t(
        "Privacy: this page only shows memory for your own key scope. Avoid storing secrets or credentials.",
      )}
    </p>
  </div>
{/if}

{#if loading}
  <p class="section-desc">{$t("Loading…")}</p>
{:else if disabled}
  <div class="card empty-state">
    {$t("Memory is not enabled for this gateway.")}
  </div>
{:else}
  {#if error}
    <p class="alert-error mb-4" role="alert">{error}</p>
  {/if}
  {#if notice}
    <p class="alert-success mb-4" role="status">{notice}</p>
  {/if}

  {#if sharedPool}
    <p class="alert-warn mb-4">
      {$t('This memory is shared with other keys in project "{project}".', {
        project: sharedPool,
      })}
    </p>
  {/if}

  <section class="mb-6 flex flex-col gap-3">
    <h2 class="section-header">{$t("Reflections")}</h2>
    {#if reflections.length === 0}
      <div class="empty-state">{$t("No reflections yet.")}</div>
    {:else}
      <div class="flex flex-col gap-3">
        {#each reflections as reflection (reflection.id)}
          <div data-testid="reflection-row" class="card flex flex-col gap-2">
            <div class="flex items-start justify-between gap-3">
              <div
                class="flex flex-wrap items-center gap-2 text-xs text-ink-muted"
              >
                {#if reflection.status === "active"}
                  <span class="badge-ok">{$t("active")}</span>
                {:else}
                  <span class="badge-neutral">{$t("archived")}</span>
                {/if}
                <span>{$t("Version")} {reflection.version}</span>
                <span aria-hidden="true">·</span>
                <span>{formatTimestamp(reflection.updatedAt)}</span>
              </div>
              <div class="flex shrink-0 gap-2">
                <button
                  type="button"
                  class="btn-secondary"
                  onclick={() => (editingReflection = reflection)}
                  >{$t("Edit")}</button
                >
                <button
                  type="button"
                  class="btn-danger-outline"
                  onclick={() => (confirmingReflectionDelete = reflection)}
                >
                  {$t("Delete")}
                </button>
              </div>
            </div>
            <p class="whitespace-pre-wrap break-words text-sm text-ink-body">
              {reflection.reflectionText}
            </p>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section class="flex flex-col gap-3">
    <div
      class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between"
    >
      <h2 class="section-header">{$t("Facts")}</h2>
      <div class="flex flex-wrap items-end gap-2">
        <form
          class="flex items-end gap-2"
          onsubmit={(e) => {
            e.preventDefault();
            applyFactSearch();
          }}
        >
          <input
            type="search"
            class="input w-52"
            aria-label={$t("Search facts")}
            placeholder={$t("Search fact text…")}
            bind:value={factSearch}
          />
          <button type="submit" class="btn-secondary">{$t("Search")}</button>
        </form>
        <label class="flex flex-col gap-1 text-xs font-medium text-ink-muted">
          {$t("Status")}
          <select
            class="select w-40"
            aria-label={$t("Fact status filter")}
            bind:value={factStatus}
            onchange={() => {
              factPage = 1;
            }}
          >
            <option value="active">{$t("Active")}</option>
            <option value="superseded">{$t("Superseded")}</option>
            <option value="archived">{$t("Archived")}</option>
            <option value="pruned">{$t("Pruned")}</option>
            <option value="all">{$t("All")}</option>
          </select>
        </label>
        <button
          type="button"
          class="btn-primary-sm"
          onclick={() => (showAddFact = true)}
        >
          {$t("Add fact")}
        </button>
      </div>
    </div>

    {#if facts.length === 0}
      <div class="empty-state">
        <p class="font-medium text-ink-body">{$t("No facts yet.")}</p>
        <p class="mt-1 text-ink-muted">
          {$t("Add a fact to teach Helm something useful for future sessions.")}
        </p>
      </div>
    {:else if pagedFacts.length === 0}
      <div class="empty-state">
        <p class="font-medium text-ink-body">
          {$t("No facts match these filters.")}
        </p>
        <p class="mt-1 text-ink-muted">
          {$t("Try another status or search term.")}
        </p>
      </div>
    {:else}
      <div class="cards-table-frame">
        <table class="cards-table">
          <thead class="table-head">
            <tr>
              <th class="px-3 py-2">{$t("Subject")}</th>
              <th class="px-3 py-2">{$t("Fact")}</th>
              <th class="px-3 py-2">{$t("Status")}</th>
              <th class="px-3 py-2">{$t("Importance")}</th>
              <th class="px-3 py-2">{$t("Updated")}</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {#each pagedFacts as fact (fact.id)}
              {@const badge = factBadge(fact)}
              <tr data-testid="fact-row" class="align-top">
                <td data-label={$t("Subject")} class="px-3 py-2">
                  <span class="font-mono text-ink-strong"
                    >{fact.subjectKey || "—"}</span
                  >
                </td>
                <td data-label={$t("Fact")} class="px-3 py-2 text-ink-body">
                  <span class="block whitespace-pre-wrap break-words"
                    >{fact.factText}</span
                  >
                </td>
                <td data-label={$t("Status")} class="px-3 py-2">
                  <span class={badge.cls}>{badge.text}</span>
                </td>
                <td
                  data-label={$t("Importance")}
                  class="px-3 py-2 text-ink-muted"
                >
                  {fact.importance.toFixed(2)}
                </td>
                <td data-label={$t("Updated")} class="px-3 py-2 text-ink-muted">
                  {formatTimestamp(fact.updatedAt)}
                </td>
                <td class="px-3 py-2 lg:text-right">
                  <div class="flex justify-end gap-2">
                    <button
                      type="button"
                      class="btn-secondary"
                      onclick={() => (editingFact = fact)}
                    >
                      {$t("Edit")}
                    </button>
                    <button
                      type="button"
                      class="btn-danger-outline"
                      onclick={() => (confirmingFactDelete = fact)}
                    >
                      {$t("Delete")}
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div
        class="flex flex-col gap-3 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between"
      >
        <span>
          {$t("Page {page} of {pages}", {
            page: factPage,
            pages: factTotalPages,
          })} ·
          {$t("{total} facts", { total: filteredFacts.length })}
        </span>
        <nav class="flex items-center gap-1" aria-label={$t("Pagination")}>
          <button
            type="button"
            class="btn-secondary"
            disabled={factPage <= 1}
            onclick={() => (factPage -= 1)}>{$t("Previous")}</button
          >
          {#each factPageItems as item, i (item === "ellipsis" ? `e${i}` : item)}
            {#if item === "ellipsis"}
              <span class="px-2 text-ink-muted" aria-hidden="true">…</span>
            {:else if item === factPage}
              <span
                aria-current="page"
                class="inline-flex h-9 min-w-9 items-center justify-center rounded border border-slate-800 bg-slate-800 px-2 text-sm font-medium text-white"
                >{item}</span
              >
            {:else}
              <button
                type="button"
                class="inline-flex h-9 min-w-9 cursor-pointer items-center justify-center rounded border border-slate-300 px-2 text-sm text-ink-body transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                onclick={() => (factPage = item)}>{item}</button
              >
            {/if}
          {/each}
          <button
            type="button"
            class="btn-secondary"
            disabled={factPage >= factTotalPages}
            onclick={() => (factPage += 1)}>{$t("Next")}</button
          >
        </nav>
      </div>
    {/if}
  </section>
{/if}

{#if showSettings && me}
  <MemorySettingsDialog
    {me}
    onsaved={onSettingsSaved}
    onclose={() => (showSettings = false)}
  />
{/if}

{#if showAddFact}
  <AddFactDialog
    onsaved={onFactCreated}
    onclose={() => (showAddFact = false)}
  />
{/if}

{#if editingFact}
  <EditFactDialog
    fact={editingFact}
    onsaved={onFactSaved}
    onclose={() => (editingFact = null)}
  />
{/if}

{#if editingReflection}
  <EditReflectionDialog
    reflection={editingReflection}
    onsaved={onReflectionSaved}
    onclose={() => (editingReflection = null)}
  />
{/if}

{#if confirmingFactDelete}
  <Modal
    label={$t("Confirm delete")}
    onclose={() => (confirmingFactDelete = null)}
  >
    <h2 class="section-header">{$t("Delete fact")}</h2>
    <p class="mt-2 text-sm text-amber-800">
      {$t("Remove this fact from memory? Helm stops using it.")}
    </p>
    <p class="mt-2 max-w-full whitespace-normal text-sm text-ink-body">
      {confirmingFactDelete.factText}
    </p>
    <div class="mt-4 flex justify-end gap-2">
      <button
        type="button"
        class="btn-secondary"
        onclick={() => (confirmingFactDelete = null)}
      >
        {$t("Cancel")}
      </button>
      <button type="button" class="btn-danger" onclick={confirmDeleteFact}
        >{$t("Delete")}</button
      >
    </div>
  </Modal>
{/if}

{#if confirmingReflectionDelete}
  <Modal
    label={$t("Confirm delete")}
    onclose={() => (confirmingReflectionDelete = null)}
  >
    <h2 class="section-header">{$t("Delete reflection")}</h2>
    <p class="mt-2 text-sm text-amber-800">
      {#if confirmingReflectionDelete.status === "active"}
        {$t("Remove this reflection? Helm stops using it.")}
      {:else}
        {$t(
          "This reflection is already archived. Deleting it again may remove it permanently.",
        )}
      {/if}
    </p>
    <div class="mt-4 flex justify-end gap-2">
      <button
        type="button"
        class="btn-secondary"
        onclick={() => (confirmingReflectionDelete = null)}
      >
        {$t("Cancel")}
      </button>
      <button
        type="button"
        class="btn-danger"
        onclick={confirmDeleteReflection}
      >
        {$t("Delete")}
      </button>
    </div>
  </Modal>
{/if}
