import { describe, expect, it, vi } from "vitest";
import { type ClosableServer, closeServer } from "./shutdown.js";

// A fake http.Server: `closeCb` controls whether/when active connections "drain".
function fakeServer(opts: { drainsImmediately: boolean }): ClosableServer & {
  idleClosed: number;
  allClosed: number;
} {
  const state = { idleClosed: 0, allClosed: 0 };
  return {
    close(cb?: (err?: Error) => void) {
      if (opts.drainsImmediately && cb) cb();
      // else: never invokes cb (a connection is still in flight)
    },
    closeIdleConnections: vi.fn(() => {
      state.idleClosed++;
    }),
    closeAllConnections: vi.fn(() => {
      state.allClosed++;
    }),
    get idleClosed() {
      return state.idleClosed;
    },
    get allClosed() {
      return state.allClosed;
    },
  };
}

describe("closeServer", () => {
  it("resolves once in-flight requests drain, dropping idle keep-alives, without force-closing", async () => {
    const server = fakeServer({ drainsImmediately: true });
    await expect(closeServer(server, 5_000)).resolves.toBeUndefined();
    expect(server.idleClosed).toBe(1); // idle keep-alives dropped so close can complete
    expect(server.allClosed).toBe(0); // active drained in time — no force-abort
  });

  it("force-closes lingering connections once the drain deadline passes", async () => {
    const server = fakeServer({ drainsImmediately: false });
    await expect(closeServer(server, 5)).resolves.toBeUndefined();
    expect(server.allClosed).toBe(1); // deadline hit → force-abort the stuck connection
  });

  it("tolerates a server missing the optional connection-closing methods", async () => {
    const minimal: ClosableServer = {
      close(cb?: (err?: Error) => void) {
        cb?.();
      },
    };
    await expect(closeServer(minimal, 5_000)).resolves.toBeUndefined();
  });
});
