<script lang="ts">
  import { untrack } from 'svelte';
  import { navigating } from '$app/stores';
  import { t } from '$lib/i18n';

  // Top-of-page navigation progress bar (NProgress-style). SvelteKit's
  // `navigating` store is non-null from the instant a link click starts a
  // navigation until the destination page is ready — and that window *includes*
  // the page `load` function, which is where the admin's API requests happen.
  // Surfacing it as a thin animated bar gives the operator immediate feedback
  // that the click registered and a request is in flight, instead of a screen
  // that looks frozen. Pure client UX — kept as code constants, not config.
  const INITIAL = 8; // immediate jump on start, so the click feels acknowledged
  const CEILING = 92; // trickle approaches but never reaches this until resolved
  const TRICKLE_MS = 280; // cadence of the asymptotic forward nudge
  const DONE_HOLD_MS = 240; // keep the full bar visible briefly before fading out

  let active = $state(false); // a navigation (and its load) is in progress
  let progress = $state(0); // 0–100

  let trickleTimer: ReturnType<typeof setInterval> | undefined;
  let doneTimer: ReturnType<typeof setTimeout> | undefined;

  function clearTimers(): void {
    if (trickleTimer !== undefined) clearInterval(trickleTimer);
    if (doneTimer !== undefined) clearTimeout(doneTimer);
    trickleTimer = undefined;
    doneTimer = undefined;
  }

  function start(): void {
    clearTimers();
    active = true;
    progress = INITIAL;
    // Asymptotic trickle: keep moving so a slow request never looks stuck, but
    // hold back the final stretch for the genuine "done" signal.
    trickleTimer = setInterval(() => {
      progress = Math.min(CEILING, progress + (CEILING - progress) * 0.18 + 0.4);
    }, TRICKLE_MS);
  }

  function finish(): void {
    clearTimers();
    progress = 100;
    doneTimer = setTimeout(() => {
      active = false;
      progress = 0;
    }, DONE_HOLD_MS);
  }

  // Drive purely off `navigating` transitions. `untrack` keeps the effect's only
  // reactive dependency the store itself — the bar's own `active`/`progress`
  // writes must not re-trigger it (that would restart the trickle on every tick).
  $effect(() => {
    const nav = $navigating;
    untrack(() => {
      if (nav) start();
      else if (active) finish();
    });
  });

  $effect(() => () => clearTimers());
</script>

<div
  class="pointer-events-none fixed inset-x-0 top-0 z-50 h-[3px] transition-opacity duration-200 {active
    ? 'opacity-100'
    : 'opacity-0'}"
  role="progressbar"
  aria-hidden={!active}
  aria-label={$t('Loading…')}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(progress)}
  data-testid="nav-progress"
>
  <div
    class="h-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.6)] transition-[width] duration-200 ease-out"
    style="width: {progress}%"
  ></div>
</div>
