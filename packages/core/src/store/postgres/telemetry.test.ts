import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createPgliteDb } from "./migrate.js";
import { PgTelemetryStore } from "./telemetry.js";

describe("PgTelemetryStore", () => {
  it("updates and appends Session revisions after the former 64 MiB aggregate cap", async () => {
    const db = await createPgliteDb();
    const store = new PgTelemetryStore(db);
    const first = {
      sessionRef: "s-unbounded",
      accountId: "a1",
      apiKeyId: "k1",
      source: "header",
      externalSessionId: "external-unbounded",
      requestId: "r1",
      parentRequestId: null,
      retainCount: 0,
      requestDeltaJson: '["first"]',
      requestEnvelopeJson: "{}",
      responseId: null,
      responseJson: null,
      fidelity: "semantic",
      createdAt: new Date(1_000),
    } as const;
    await store.upsertSessionRevision(first);
    await db.execute(
      sql.raw(
        `UPDATE sessions SET stored_bytes = ${64 * 1024 * 1024} WHERE session_ref = 's-unbounded'`,
      ),
    );

    await store.upsertSessionRevision({
      ...first,
      responseId: "resp_1",
      responseJson: '{"output":"first"}',
    });
    await store.upsertSessionRevision({
      ...first,
      requestId: "r2",
      parentRequestId: "r1",
      requestDeltaJson: '["second"]',
      responseId: null,
      responseJson: null,
      createdAt: new Date(2_000),
    });

    expect(await store.listSessionRevisions(first.sessionRef)).toHaveLength(2);
    expect((await store.getSessionByRef(first.sessionRef))?.storedBytes).toBeGreaterThan(
      64 * 1024 * 1024,
    );
    await db.$close();
  });
});
