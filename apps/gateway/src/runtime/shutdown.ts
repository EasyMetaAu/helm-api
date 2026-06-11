// Graceful shutdown helper. The minimal slice of a Node http.Server we drive — the
// optional methods exist on http.Server (Node 18.2+) but not on every member of
// @hono/node-server's ServerType union, so they're optional + called defensively.
export interface ClosableServer {
  close(callback?: (err?: Error) => void): void;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

// Stop accepting new connections and WAIT for in-flight requests to finish before
// resolving, so the caller can safely tear down the write queue + store afterwards.
// Without this, SIGTERM would close the listener and immediately stop the queue /
// close the DB while a request is still running — its later enqueue() calls would be
// dropped and its synchronous budget/store work would hit a closed DB.
//
// Idle keep-alive sockets are dropped immediately (they would otherwise hold the
// close callback open indefinitely). If active requests don't drain within drainMs,
// any lingering connection is force-closed so shutdown can never hang forever.
export function closeServer(server: ClosableServer, drainMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    // Stop accepting new connections; the callback fires once active ones finish.
    server.close(() => done());
    // Drop idle keep-alive sockets so they don't keep the close callback pending.
    server.closeIdleConnections?.();
    timer = setTimeout(() => {
      // Drain deadline hit — force-abort whatever is still connected, then proceed.
      server.closeAllConnections?.();
      done();
    }, drainMs);
    if (typeof timer.unref === "function") timer.unref();
  });
}
