// Pure decision for the off-hours auto-VACUUM scheduler. The gateway runs a plain
// hourly tick (mirroring the cleanup scheduler); each tick this answers "should I
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
