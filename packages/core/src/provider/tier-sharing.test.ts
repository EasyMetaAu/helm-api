import { describe, expect, it } from "vitest";
import {
  coordinateAccountPriority,
  type PriorityAccount,
  rankPriorityPools,
} from "./account-priority.js";

const account = (name: string, priority = 10, eligible = true): PriorityAccount => ({
  account: name,
  priority,
  eligible,
});
const entries = [
  { alias: "oauth/m", pool: "oauth", candidates: [account("A"), account("B")] },
  { alias: "api/m", pool: "api", candidates: [account("K")] },
  { alias: "zen/m", pool: "zen", candidates: [account("Z")] },
  { alias: "kimi/k", pool: "kimi", candidates: [account("C", 20)] },
];
describe("tier pool ordering", () => {
  it("weights eligible accounts only in the current tier, without mutating snapshots", () => {
    const input = [
      ...entries,
      { alias: "disabled/m", candidates: [account("off", 10, false), account("next", 30)] },
    ];
    const before = structuredClone(input);
    expect(rankPriorityPools(input, 10, { random: () => 0.5 })).toEqual([
      { pool: "oauth", weight: 2 },
      { pool: "api", weight: 1 },
      { pool: "zen", weight: 1 },
    ]);
    expect(input).toEqual(before);
  });
  it("counts busy accounts for sharing but excludes parked or otherwise ineligible accounts", () => {
    expect(
      rankPriorityPools(
        [
          {
            alias: "oauth",
            candidates: [
              account("A"),
              { ...account("B", 10, false), sharingEligible: true },
              { ...account("parked", 10, false), sharingEligible: false },
            ],
          },
          { alias: "key", candidates: [account("K")] },
        ],
        10,
        { random: () => 0.5 },
      ),
    ).toEqual([
      { pool: "oauth", weight: 2 },
      { pool: "key", weight: 1 },
    ]);
  });
  it("deduplicates one pool account reachable through multiple aliases", () => {
    expect(
      rankPriorityPools(
        [
          ...entries,
          { alias: "oauth/mirror", pool: "oauth", candidates: [account("A"), account("B")] },
        ],
        10,
        { random: () => 0.5 },
      )[0],
    ).toEqual({ pool: "oauth", weight: 2 });
  });
  it("uses stable sticky ranking independent of chain order and ignores random", () => {
    const options = {
      affinityHash: "fixture-digest",
      random: () => {
        throw new Error("sticky must not draw random");
      },
    };
    const order = rankPriorityPools(entries, 10, options);
    expect(rankPriorityPools([...entries].reverse(), 10, options)).toEqual(order);
    const removed = order.at(-1)?.pool;
    expect(
      rankPriorityPools(
        entries.filter((e) => e.pool !== removed),
        10,
        options,
      )[0],
    ).toEqual(order[0]);
  });
  it("does not draw randomness for one eligible pool", () => {
    expect(
      rankPriorityPools(entries, 20, {
        random: () => {
          throw new Error("single pool");
        },
      }),
    ).toEqual([{ pool: "kimi", weight: 1 }]);
  });
  it("refreshes eligibility while suspended and exhausts same-tier pools before tier20", async () => {
    const calls: string[] = [];
    let parked = false;
    const result = await coordinateAccountPriority(
      entries.map((e) => ({
        ...e,
        snapshot: async () => (e.pool === "zen" && parked ? [] : e.candidates),
      })),
      async (alias, cursor) => {
        const entry = entries.find((e) => e.alias === alias);
        if (!entry) throw new Error("fixture");
        const candidates = alias === "zen/m" && parked ? [] : [...entry.candidates];
        while (candidates.length) {
          await cursor.wait(() => candidates);
          calls.push(alias);
          if (alias === "api/m") parked = true;
          if (alias === "kimi/k") return "ok";
          cursor.lastError = new Error("pre-output");
          candidates.shift();
        }
        return undefined;
      },
      { random: () => 0.5 },
    );
    expect(result).toBe("ok");
    expect(calls).toEqual(["oauth/m", "api/m", "oauth/m", "kimi/k"]);
  });
});

it("rotates peers even when repeated failures reuse the same Error instance", async () => {
  const calls: string[] = [];
  const failure = new Error("shared fixture error");
  await coordinateAccountPriority(
    [
      { alias: "a", candidates: [account("a1"), account("a2"), account("a3")] },
      { alias: "k", candidates: [account("k1"), account("k2"), account("k3")] },
    ],
    async (alias, cursor) => {
      const remaining = [account(`${alias}1`), account(`${alias}2`), account(`${alias}3`)];
      while (remaining.length) {
        await cursor.wait(() => remaining);
        calls.push(alias);
        cursor.lastError = failure;
        remaining.shift();
      }
      return undefined;
    },
    { random: () => 0.5 },
  );
  expect(calls).toEqual(["a", "k", "a", "k", "a", "k"]);
});

it("keeps simultaneous coordinator choices independent", async () => {
  const entries = [
    { alias: "a", candidates: [account("a")] },
    { alias: "k", candidates: [account("k")] },
  ];
  const draw = (values: number[]) => () => values.shift() ?? 0.5;
  const [left, right] = await Promise.all([
    coordinateAccountPriority(entries, async (alias) => alias, { random: draw([0.9, 0.1]) }),
    coordinateAccountPriority(entries, async (alias) => alias, { random: draw([0.1, 0.9]) }),
  ]);
  expect([left, right]).toEqual(["a", "k"]);
});
