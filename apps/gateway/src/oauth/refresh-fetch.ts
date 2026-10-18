// OAuth control-plane calls must have a deadline through the final body byte.
// Some transports/streams do not settle on abort; never await their cleanup.
export function boundedOAuthFetch(transport: typeof fetch, timeoutMs = 30_000): typeof fetch {
  return async (input, init) => {
    const external = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    external?.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("OAuth request timed out")),
      timeoutMs,
    );
    const forwardAbort = () => controller.abort(external?.reason);
    external?.addEventListener("abort", forwardAbort, { once: true });
    const signal = controller.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    let rejectFetch!: (error: unknown) => void;
    const cleanup = () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", forwardAbort);
      signal.removeEventListener("abort", abort);
    };
    const cancelReader = (reason?: unknown) => {
      if (!reader) return;
      void reader.cancel(reason).catch(() => {});
      reader.releaseLock();
    };
    const abort = () => {
      if (finished) return;
      finished = true;
      rejectFetch(signal.reason);
      bodyController?.error(signal.reason);
      cancelReader(signal.reason);
      cleanup();
    };
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectFetch = reject;
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const pending = transport(input, { ...init, signal });
      // A transport can ignore abort and return headers after the caller has left.
      void pending.then(
        (response) => {
          if (signal.aborted) void response.body?.cancel().catch(() => {});
        },
        () => {},
      );
      const response = await Promise.race([pending, aborted]);
      signal.throwIfAborted();
      if (!response.body) {
        finished = true;
        cleanup();
        return response;
      }
      reader = response.body.getReader();
      const source = reader;
      const body = new ReadableStream<Uint8Array>(
        {
          start(streamController) {
            bodyController = streamController;
          },
          async pull(streamController) {
            try {
              const chunk = await source.read();
              if (finished) return;
              if (chunk.done) {
                finished = true;
                cleanup();
                source.releaseLock();
                streamController.close();
              } else {
                streamController.enqueue(chunk.value);
              }
            } catch (error) {
              if (finished) return;
              finished = true;
              cleanup();
              source.releaseLock();
              streamController.error(error);
            }
          },
          cancel(reason) {
            if (finished) return;
            finished = true;
            cancelReader(reason);
            cleanup();
          },
        },
        { highWaterMark: 0 },
      );
      const bounded = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      for (const key of ["url", "redirected", "type"] as const) {
        Object.defineProperty(bounded, key, { value: response[key] });
      }
      return bounded;
    } catch (error) {
      finished = true;
      cleanup();
      throw error;
    }
  };
}
