import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Spec TDD #1 (signals.feedback): PROVE the main request path never references
// the Agentic Signals collector/store — collection is a BACKGROUND job that
// consumes already-persisted telemetry, so a served request neither awaits nor
// depends on any signal computation/write (zero added main-path latency).
//
// A structural guard: the request-handling route module must not import or name
// the signal collector / signal store. Background wiring lives ONLY in server.ts
// (the boot path), outside every middleware / route handler.
const chatRouteSrc = readFileSync(fileURLToPath(new URL("./chat.ts", import.meta.url)), "utf8");

describe("chat route is isolated from Agentic Signals (zero main-path coupling)", () => {
  it("does not import or reference the signal collector / signal store", () => {
    expect(chatRouteSrc).not.toMatch(/SignalStore/);
    expect(chatRouteSrc).not.toMatch(/SignalCollector/);
    expect(chatRouteSrc).not.toMatch(/createSignalCollector/);
    expect(chatRouteSrc).not.toMatch(/startSignalScheduler/);
    expect(chatRouteSrc).not.toMatch(/aggregateSignals/);
    // It MUST NOT pull anything from the signals module either.
    expect(chatRouteSrc).not.toMatch(/signals\//);
  });
});
