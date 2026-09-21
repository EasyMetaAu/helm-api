import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createRuntimeMemoryCoordinator,
  createSqliteDb,
  hashKey,
  SqliteKeyStore,
} from "@helm/core";
import { DecisionsEnvelopeSchema } from "@helm/shared";
import { expect, it, vi } from "vitest";
import { buildServer, type ServerHandle } from "./server.js";

it("wires Decisions through the real server and stores metadata without any payload/session rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helm-jev-test-"));
  const db = createSqliteDb(join(directory, "helm.db"));
  let server: ServerHandle | undefined;
  const logs: unknown[] = [];
  try {
    await new SqliteKeyStore(db).createKey({
      keyId: "jev-test",
      hash: hashKey("synthetic-test-key"),
      prefix: "helm_test",
      accountId: "test",
      role: "root",
      allowCustomModel: true,
      requestContentMode: "payload",
      budgetRequests: 2,
    });
    vi.stubEnv("HELM_DATA_DIR", directory);
    vi.stubEnv("HELM_SIGNALS_DISABLED", "1");
    vi.stubEnv("HELM_OAUTH_ENC_KEY", Buffer.alloc(32, 11).toString("base64"));
    vi.stubEnv("OPENROUTER_API_KEY", "synthetic-upstream-key");
    vi.stubEnv("HELM_PROVIDER_BASE_URL", "https://mock.invalid");
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) !== "https://mock.invalid/alpha/decisions")
        throw new Error("Unexpected external request");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-upstream-key");
      const body = JSON.parse(String(init?.body));
      if (body.state === "PRIVATE_ERROR_MARKER")
        return new Response("PRIVATE_UPSTREAM_MARKER", { status: 500 });
      return Response.json({
        model: "typesafe/jev-1.13-20260917",
        answers: { q: { type: "noul", noul: 0.9 } },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    server = await buildServer({
      configDir: resolve("config"),
      memoryCoordinator: createRuntimeMemoryCoordinator({
        capacityBytes: () => Number.MAX_SAFE_INTEGER,
      }),
      resourcePressure: { shouldRun: async () => false, shouldRunHeavy: async () => false },
      logger: {
        log: (...args) => {
          logs.push(args);
        },
      },
    });
    for (const [state, status] of [
      ["PRIVATE_OK_MARKER", 200],
      ["PRIVATE_ERROR_MARKER", 502],
      ["PRIVATE_CAP_MARKER", 429],
    ] as const) {
      const res = await server.app.request("/v1/decisions", {
        method: "POST",
        headers: {
          Authorization: "Bearer synthetic-test-key",
          "content-type": "application/json",
          "x-session-id": "PRIVATE_SESSION_MARKER",
        },
        body: JSON.stringify({
          model: "~typesafe/jev-latest",
          state,
          questions: { q: { type: "noul", instructions: "PRIVATE_QUESTION_MARKER" } },
        }),
      });
      expect(res.status).toBe(status);
      const result = await res.json();
      if (status === 200)
        expect(DecisionsEnvelopeSchema.parse(result).usage).toEqual({
          input_tokens: null,
          output_tokens: null,
          cost: null,
        });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    const rows = db.$sqlite
      .prepare("SELECT decision_json FROM telemetry WHERE api_key_id = ?")
      .all("jev-test");
    expect(rows).toHaveLength(3);
    expect(JSON.stringify([rows, logs])).not.toMatch(
      /PRIVATE_|synthetic-test-key|synthetic-upstream-key/,
    );
    for (const table of [
      "request_payloads",
      "sessions",
      "session_revisions",
      "session_revision_body_chunks",
    ]) {
      expect(db.$sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  } finally {
    await server?.dispose?.();
    db.$sqlite.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
