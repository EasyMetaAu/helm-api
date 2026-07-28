// Pure decision for the off-hours auto-VACUUM scheduler. The gateway checks more
// than once during the selected hour so a failed preflight can retry; each tick asks "should I
// VACUUM right now?" from the live settings + the wall clock. Kept pure (no Date, no
// store) so the once-a-day, right-hour, opt-in logic is unit-testable: the tick
// supplies the clock (currentHour/todayKey) and remembers lastRunDayKey across ticks.
//
// Rules, in order:
//   - vacuum_enabled OFF      → never (opt-in; default off — VACUUM takes an
//                               EXCLUSIVE lock for the whole file rewrite);
//   - not the configured hour → wait (the operator picks a low-traffic local hour);
//   - already ran today       → skip (at most once per day, even if the hour ticks
//                               twice from setInterval drift).
export const AUTO_VACUUM_CHECK_INTERVAL_MS = 10 * 60 * 1_000;

export function shouldAutoVacuum(args: {
  enabled: boolean;
  vacuumHour: number;
  currentHour: number;
  lastRunDayKey: string | null;
  todayKey: string;
}): boolean {
  if (!args.enabled) return false;
  if (args.currentHour !== args.vacuumHour) return false;
  return args.lastRunDayKey !== args.todayKey;
}

export function createAutoVacuumRunner() {
  let lastSuccessfulDayKey: string | null = null;

  return {
    async run(
      current: () => Omit<Parameters<typeof shouldAutoVacuum>[0], "lastRunDayKey">,
      maintenance: () => Promise<boolean>,
    ): Promise<boolean> {
      const args = current();
      if (!shouldAutoVacuum({ ...args, lastRunDayKey: lastSuccessfulDayKey })) return false;
      if ((await maintenance()) === false) return false;
      lastSuccessfulDayKey = args.todayKey;
      return true;
    },
  };
}
