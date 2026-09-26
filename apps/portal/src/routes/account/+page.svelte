<script lang="ts">
  import { t } from "$lib/i18n";
  import { formatUsd, formatTokens } from "$lib/format";
  import { getMe, getUsage, type Me } from "$lib/api/portal";

  let me = $state<Me | null>(null);
  // Spend/tokens consumed within the budget's own reset window (falls back to
  // all-time when there's no window, i.e. a cap that never resets).
  let spent = $state(0);
  let tokensUsed = $state(0);
  let requestsUsed = $state(0);
  let loading = $state(true);
  let loadError = $state("");

  $effect(() => {
    void (async () => {
      try {
        const account = await getMe();
        me = account;
        const windowMs = account.budget.window_seconds
          ? account.budget.window_seconds * 1000
          : null;
        const now = Date.now();
        const stats = await getUsage(
          windowMs ? { start: now - windowMs, end: now } : {},
        );
        spent = stats.totals.cost_usd;
        tokensUsed = stats.totals.total_tokens;
        requestsUsed = stats.totals.requests;
      } catch (e) {
        loadError = e instanceof Error ? e.message : "load failed";
      } finally {
        loading = false;
      }
    })();
  });

  const rpm = $derived(me?.rate_limit.rpm);

  // Progress-bar percent against a cap; null cap → no bar (unlimited).
  function usedPct(used: number, cap: number | null): number | null {
    return cap !== null && cap > 0 ? Math.min(100, (used / cap) * 100) : null;
  }
  const spendPct = $derived(usedPct(spent, me?.budget.spend_usd ?? null));
  const tokensPct = $derived(usedPct(tokensUsed, me?.budget.tokens ?? null));
  const requestsPct = $derived(
    usedPct(requestsUsed, me?.budget.requests ?? null),
  );
</script>

<div class="mx-auto max-w-3xl">
  <h1 class="page-title mb-1">{$t("Account")}</h1>
  <p class="section-desc mb-4">
    {$t(
      "Your key and its limits. These are read-only — contact your administrator to change them.",
    )}
  </p>

  {#if loading}
    <p class="section-desc">{$t("Loading…")}</p>
  {:else if loadError}
    <p class="alert-error">{loadError}</p>
  {:else if me}
    <div class="card">
      <h2 class="section-header mb-3">{$t("Key")}</h2>
      <dl class="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
        <dt class="text-ink-muted">{$t("Key")}</dt>
        <dd class="text-right font-mono">{me.key_prefix}…</dd>
        <dt class="text-ink-muted">{$t("Role")}</dt>
        <dd class="text-right">{me.role}</dd>
        <dt class="text-ink-muted">{$t("Available lanes")}</dt>
        <dd class="text-right">{me.allowed_lanes?.join(", ") ?? $t("all")}</dd>
        <dt class="text-ink-muted">{$t("Rate limit")}</dt>
        <dd class="text-right">
          {rpm === null || rpm === undefined
            ? $t("unlimited")
            : `${rpm} rpm`}
        </dd>
      </dl>
    </div>

    <div class="card mt-4">
      <h2 class="section-header mb-3">{$t("Your budget")}</h2>
      <div class="flex flex-col gap-4">
        <div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-ink-muted">{$t("Spend limit")}</span>
            <span>
              {me.budget.spend_usd === null
                ? $t("unlimited")
                : `${formatUsd(spent)} ${$t("of")} ${formatUsd(me.budget.spend_usd)}`}
            </span>
          </div>
          {#if spendPct !== null}
            <div class="progress-track mt-1.5">
              <div class="progress-bar" style:width={`${spendPct}%`}></div>
            </div>
          {/if}
        </div>
        <div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-ink-muted">{$t("Token budget")}</span>
            <span>
              {me.budget.tokens === null
                ? $t("unlimited")
                : `${formatTokens(tokensUsed)} ${$t("of")} ${formatTokens(me.budget.tokens)}`}
            </span>
          </div>
          {#if tokensPct !== null}
            <div class="progress-track mt-1.5">
              <div class="progress-bar" style:width={`${tokensPct}%`}></div>
            </div>
          {/if}
        </div>
        {#if me.budget.requests !== null}
          <div>
            <div class="flex items-center justify-between text-sm">
              <span class="text-ink-muted">{$t("Requests")}</span>
              <span
                >{formatTokens(requestsUsed)} {$t("of")} {formatTokens(
                  me.budget.requests,
                )}</span
              >
            </div>
            {#if requestsPct !== null}
              <div class="progress-track mt-1.5">
                <div class="progress-bar" style:width={`${requestsPct}%`}
                ></div>
              </div>
            {/if}
          </div>
        {/if}
        {#if me.budget.window_seconds}
          <p class="field-help">
            {$t("Resets every {hours}h. Over budget: {behavior}.", {
              hours: Math.round(me.budget.window_seconds / 3600),
              behavior: me.budget.behavior,
            })}
          </p>
        {/if}
      </div>
    </div>

    <div class="card mt-4">
      <h2 class="section-header mb-3">{$t("Memory")}</h2>
      <dl class="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
        <dt class="text-ink-muted">{$t("Memory mode")}</dt>
        <dd class="text-right">{me.memory.mode}</dd>
        <dt class="text-ink-muted">{$t("Project")}</dt>
        <dd class="truncate text-right"
          >{me.memory.project_name ?? $t("Private to this key")}</dd
        >
        <dt class="text-ink-muted">{$t("Thread source")}</dt>
        <dd class="text-right">
          {me.memory.thread_source === "auto"
            ? $t("Auto (derive from client signals)")
            : $t("Header only (x-thread-id)")}
        </dd>
      </dl>
    </div>
  {/if}
</div>
