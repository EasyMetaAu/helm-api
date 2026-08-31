<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { type Policy, savePolicies, TASK_TYPE_OPTIONS } from '$lib/api/policies.js';
  import PolicyRow from '$lib/components/PolicyRow.svelte';
  import { t } from '$lib/i18n';

  // Data comes from `+page.ts`'s load (mocked via the `data` prop in tests).
  // The page owns the ORDERED working list — order IS the match priority
  // (docs/04 first-match). It contains NO matching logic (Principle 1/Principle 5): it only
  // edits/reorders the list and writes the whole set back via the API client.
  let { data }: { data: { policies: Policy[]; lanes?: string[] } } = $props();

  type PolicyRowState = { key: string; policy: Policy };

  let nextPolicyRowKey = 0;

  function makePolicyRow(policy: Policy): PolicyRowState {
    nextPolicyRowKey += 1;
    return {
      key: `${policy.id ?? 'policy'}-${nextPolicyRowKey}`,
      policy: { ...policy, match: { ...policy.match } },
    };
  }

  let policyRows = $state<PolicyRowState[]>(untrack(() => data.policies.map(makePolicyRow)));
  const policies = $derived(policyRows.map((row) => row.policy));
  // Lane names for the action dropdowns. Falls back to the well-known set when
  // the load didn't supply them (the gateway is the source of truth on save).
  const lanes = untrack(() => data.lanes ?? ['economy', 'balanced', 'premium', 'coding']);

  let error = $state<string | null>(null);
  let saving = $state(false);
  let saved = $state(false);
  let draggingKey = $state<string | null>(null);
  let dropTargetKey = $state<string | null>(null);
  let stopPointerDrag: (() => void) | null = null;
  let lastDragClientY: number | null = null;
  let autoScrollFrame: number | null = null;

  const AUTO_SCROLL_EDGE_PX = 72;
  const AUTO_SCROLL_MAX_STEP_PX = 18;

  function updateRow(index: number, next: Policy): void {
    policyRows = policyRows.map((row, i) =>
      i === index ? { ...row, policy: { ...next, match: { ...next.match } } } : row,
    );
  }

  function removeRow(index: number): void {
    policyRows = policyRows.filter((_, i) => i !== index);
  }

  function moveRow(from: number, to: number): void {
    if (from === to || from < 0 || from >= policyRows.length || to < 0 || to >= policyRows.length) {
      return;
    }
    const next = [...policyRows];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    policyRows = next;
  }

  function indexOfKey(key: string): number {
    return policyRows.findIndex((row) => row.key === key);
  }

  function resetDrag(): void {
    draggingKey = null;
    dropTargetKey = null;
    cancelAutoScroll();
  }

  function finishPointerDrag(): void {
    stopPointerDrag?.();
    stopPointerDrag = null;
    resetDrag();
  }

  function targetIndexFromClientY(clientY: number): number {
    const rows = Array.from(document.querySelectorAll('[data-testid="policy-row"]'));
    if (rows.length === 0) return -1;

    for (let i = 0; i < rows.length; i += 1) {
      const rect = rows[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return rows.length - 1;
  }

  function scrollContainer(): HTMLElement | null {
    const main = document.querySelector('main');
    return main instanceof HTMLElement ? main : null;
  }

  function dragAutoScrollDelta(container: HTMLElement, clientY: number): number {
    const rect = container.getBoundingClientRect();
    const topDistance = clientY - rect.top;
    const bottomDistance = rect.bottom - clientY;
    if (topDistance < AUTO_SCROLL_EDGE_PX) {
      return -Math.ceil(
        ((AUTO_SCROLL_EDGE_PX - Math.max(0, topDistance)) / AUTO_SCROLL_EDGE_PX) *
          AUTO_SCROLL_MAX_STEP_PX,
      );
    }
    if (bottomDistance < AUTO_SCROLL_EDGE_PX) {
      return Math.ceil(
        ((AUTO_SCROLL_EDGE_PX - Math.max(0, bottomDistance)) / AUTO_SCROLL_EDGE_PX) *
          AUTO_SCROLL_MAX_STEP_PX,
      );
    }
    return 0;
  }

  function moveDraggingRowToClientY(clientY: number): void {
    if (draggingKey === null) return;
    const from = indexOfKey(draggingKey);
    const to = targetIndexFromClientY(clientY);
    if (from === -1 || to === -1) return;
    if (from !== to) moveRow(from, to);
    dropTargetKey = draggingKey;
  }

  function runAutoScroll(): void {
    autoScrollFrame = null;
    if (draggingKey === null || lastDragClientY === null) return;

    const container = scrollContainer();
    if (!container) return;

    const delta = dragAutoScrollDelta(container, lastDragClientY);
    if (delta === 0) return;

    container.scrollBy({ top: delta });
    moveDraggingRowToClientY(lastDragClientY);
    autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
  }

  function scheduleAutoScroll(clientY: number): void {
    lastDragClientY = clientY;
    if (autoScrollFrame !== null) return;
    autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
  }

  function cancelAutoScroll(): void {
    if (autoScrollFrame !== null) {
      window.cancelAnimationFrame(autoScrollFrame);
      autoScrollFrame = null;
    }
    lastDragClientY = null;
  }

  function handlePointerMove(event: PointerEvent): void {
    if (draggingKey === null) return;
    event.preventDefault();
    moveDraggingRowToClientY(event.clientY);
    scheduleAutoScroll(event.clientY);
  }

  function handlePointerStart(index: number, event: PointerEvent): void {
    if (event.button !== 0 || policyRows.length < 2) return;
    const row = policyRows[index];
    if (!row) return;
    finishPointerDrag();
    event.preventDefault();
    draggingKey = row.key;
    dropTargetKey = row.key;

    const pointerId = event.pointerId;
    const onMove = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId === pointerId) handlePointerMove(nextEvent);
    };
    const onUp = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== pointerId) return;
      finishPointerDrag();
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    stopPointerDrag = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }

  function handleDragStart(index: number, event: DragEvent): void {
    const row = policyRows[index];
    if (!row) return;
    draggingKey = row.key;
    dropTargetKey = null;
    event.dataTransfer?.setData('text/plain', row.key);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(index: number, event: DragEvent): void {
    if (draggingKey === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dropTargetKey = policyRows[index]?.key ?? null;
  }

  function handleDrop(index: number, event: DragEvent): void {
    event.preventDefault();
    const key = draggingKey ?? event.dataTransfer?.getData('text/plain');
    if (!key) {
      resetDrag();
      return;
    }
    const from = indexOfKey(key);
    if (from !== -1) moveRow(from, index);
    resetDrag();
  }

  async function addRow(): Promise<void> {
    // New rule defaults to a concrete action so it is never a silent no-op
    // (server requires at least one of use_lane/allowed_lanes). Appended LAST so it
    // gets the lowest priority (first-match order) and can't shadow existing rules.
    policyRows = [
      ...policyRows,
      makePolicyRow({ match: { task_type: TASK_TYPE_OPTIONS[0] }, use_lane: lanes[0] }),
    ];
    // The new row appends to the end of a potentially long list, so the click can
    // land below the fold and look like a no-op. Scroll it into view for
    // immediate feedback.
    await tick();
    const rows = document.querySelectorAll('[data-testid="policy-row"]');
    rows[rows.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Whole-set PUT (preserves priority order; avoids per-item patch losing it).
  // On failure: fail-closed — surface the error, keep the current working list.
  async function handleSave(): Promise<void> {
    error = null;
    saved = false;
    saving = true;
    try {
      const result = await savePolicies(policies);
      policyRows = result.map(makePolicyRow);
      saved = true;
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to save policies');
    } finally {
      saving = false;
    }
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header class="flex flex-col gap-2">
    <div class="min-w-0">
      <h1 class="page-title">{$t('Policies')}</h1>
      <p class="section-desc">
        {$t(
          'Server-side routing rules. Each is a condition → action (force a lane). Policies override task lanes but never the execution fallback chain.',
        )}
      </p>
    </div>
    <p class="card text-sm text-ink-body" data-testid="first-match-explainer">
      {$t('Rules are evaluated top to bottom; the')}
      <strong>{$t('first matching')}</strong>
      {$t(
        'rule wins (first-match). Order is the priority — drag a rule up to give it precedence. Rules apply in plain order, not by any weighting.',
      )}
    </p>
  </header>

  {#if error}
    <p class="alert-error" role="alert">
      {error}
    </p>
  {/if}

  {#if policyRows.length === 0}
    <div class="empty-state" data-testid="policies-empty">
      <p class="font-medium text-ink-body">{$t('No policies yet')}</p>
      <p class="mt-1 text-sm text-ink-muted">
        {$t(
          'Without a policy, requests are routed only by their task lane. Add a policy to force a lane for matching requests.',
        )}
      </p>
    </div>
  {/if}

  <div class="flex flex-col gap-4">
    {#each policyRows as row, i (row.key)}
      <PolicyRow
        policy={row.policy}
        index={i}
        total={policyRows.length}
        {lanes}
        dragging={draggingKey === row.key}
        dropTarget={dropTargetKey === row.key}
        onchange={(next) => updateRow(i, next)}
        onremove={removeRow}
        onmove={moveRow}
        ondragstart={handleDragStart}
        ondragover={handleDragOver}
        ondrop={handleDrop}
        ondragend={resetDrag}
        onpointerstart={handlePointerStart}
      />
    {/each}
  </div>

  <div
    class="fixed right-4 bottom-4 z-20 flex items-center justify-between gap-3 rounded-lg border border-border bg-canvas/95 p-3 shadow-lg backdrop-blur"
  >
    <button type="button" class="btn-secondary" onclick={addRow}>{$t('Add policy')}</button>
    <div class="flex items-center gap-3">
      {#if saved}
        <span class="badge-ok" data-testid="policies-saved" role="status">{$t('Saved')}</span>
      {/if}
      <button type="button" class="btn-primary" onclick={handleSave} disabled={saving}
        >{$t('Save policies')}</button
      >
    </div>
  </div>
</section>
