import { describe, expect, it } from "vitest";
import { coordinateAccountPriority, nextPriority, priorityGroups } from "./account-priority.js";

const candidate = (priority = 50, eligible = true) => ({ account: "fixture", priority, eligible });
const lane = (
  alias: string,
  kind: "oauth" | "api_key",
  candidates = [candidate()],
  model = "m",
) => ({ alias, kind, candidates, model });

describe("shared account ordering", () => {
  it("bypasses the scheduler at default priorities", () => {
    expect(priorityGroups([lane("a", "oauth"), lane("k", "api_key")])).toEqual([]);
  });
  it("requires both types and exact non-auto wire models", () => {
    expect(priorityGroups([lane("a", "oauth", [candidate(10)]), lane("b", "oauth")])).toEqual([]);
    expect(
      priorityGroups([
        lane("a", "oauth", [candidate(10)]),
        lane("k", "api_key", [candidate()], "vendor/m"),
      ]),
    ).toEqual([]);
    expect(
      priorityGroups([
        lane("a", "oauth", [candidate(10)], "auto"),
        lane("k", "api_key", [candidate()], "auto"),
      ]),
    ).toEqual([]);
  });
  it("keeps alias order for ties, groups by first chain occurrence", () => {
    expect(
      priorityGroups([
        lane("a", "oauth", [candidate(10)]),
        lane("other", "api_key", [candidate()], "other"),
        lane("k", "api_key", [candidate(10)]),
      ]),
    ).toEqual([["a", "k"]]);
  });
  it.each([
    "disabled",
    "parked",
    "no model permission",
  ])("excludes %s accounts before ordering or activation", () => {
    expect(nextPriority([candidate(1, false), candidate(30)])).toBe(30);
    expect(
      priorityGroups([lane("a", "oauth", [candidate(1, false)]), lane("k", "api_key")]),
    ).toEqual([]);
  });
});

it("leaves empty legacy-key aliases out of a coordinated group", () => {
  expect(
    priorityGroups([
      lane("a", "oauth", [candidate(10)]),
      lane("k", "api_key", [candidate(20)]),
      lane("legacy", "api_key", []),
    ]),
  ).toEqual([["a", "k"]]);
});

it("does not resume a finished cursor when an abort races with a preview read", async () => {
  let beginRead = () => {};
  let releaseRead = () => {};
  const reading = new Promise<void>((resolve) => {
    beginRead = resolve;
  });
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const abort = new AbortController();
  let reads = 0;
  let aSelections = 0;
  let peerRuns = 0;
  const pending = coordinateAccountPriority(
    [
      {
        alias: "a",
        candidates: [candidate(10)],
        snapshot: async () => {
          if (++reads === 3) {
            beginRead();
            await readGate;
          }
          return [candidate(aSelections ? 30 : 10)];
        },
      },
      { alias: "k", candidates: [candidate(20)] },
    ],
    async (alias, cursor) => {
      if (alias === "k") {
        peerRuns++;
        return "peer";
      }
      try {
        await cursor.wait(() => [candidate(10)], abort.signal);
        aSelections++;
        await cursor.wait(() => [candidate(30)], abort.signal);
        throw new Error("must not resume after abort");
      } catch {
        return "aborted";
      }
    },
  );
  await reading;
  abort.abort();
  await Promise.resolve();
  releaseRead();
  expect(await pending).toBe("aborted");
  expect(peerRuns).toBe(0);
});
