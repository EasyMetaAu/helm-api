import { iteratePayloadTextChunks, type PayloadTextChunk } from "./payload-codec.js";
import type { PayloadResponseWriter } from "./ports.js";

// A bounded encoding window, not a response-size limit. Hold a trailing high
// surrogate so append boundaries never change the original UTF-8 byte stream.
export function createPayloadResponseWriter(ops: {
  write(chunk: PayloadTextChunk): Promise<void>;
  commit(): Promise<void>;
  abort(): Promise<void>;
}): PayloadResponseWriter {
  let pending = "";
  let index = 0;
  let closed = false;
  const flush = async (final: boolean) => {
    const last = pending.charCodeAt(pending.length - 1);
    const hold = !final && last >= 0xd800 && last <= 0xdbff;
    const text = hold ? pending.slice(0, -1) : pending;
    pending = hold ? String.fromCharCode(last) : "";
    if (text.length === 0 && !final) return;
    if (text.length === 0 && index > 0) return;
    for (const chunk of iteratePayloadTextChunks(text)) {
      await ops.write({ ...chunk, chunkIndex: index++ });
    }
  };
  return {
    async append(chunk) {
      if (closed) throw new Error("payload response writer is closed");
      for (let offset = 0; offset < chunk.length; ) {
        const end = Math.min(chunk.length, offset + 65_536 - pending.length);
        pending += chunk.slice(offset, end);
        offset = end;
        if (pending.length >= 65_536) await flush(false);
      }
      // A bounded substring must not keep a whole upstream chunk alive.
      pending = Buffer.from(pending, "utf16le").toString("utf16le");
    },
    async commit() {
      if (closed) throw new Error("payload response writer is closed");
      await flush(true);
      await ops.commit();
      closed = true;
    },
    async abort() {
      pending = "";
      closed = true;
      await ops.abort();
    },
  };
}
