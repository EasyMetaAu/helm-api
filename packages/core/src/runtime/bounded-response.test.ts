import { describe, expect, it } from "vitest";
import {
  consumeResponseTextWithinBudget,
  ResponseBodyTooLargeError,
  readResponseTextWithinBudget,
} from "./bounded-response.js";
import {
  createResponseWorkAdmission,
  ResponseWorkCapacityError,
} from "./response-work-admission.js";

describe("readResponseTextWithinBudget", () => {
  it("rejects an oversized Content-Length before reading or decoding the body", async () => {
    const response = new Response("unread", {
      headers: { "content-length": "4" },
    });

    await expect(readResponseTextWithinBudget(response, 3)).rejects.toMatchObject({
      name: "ResponseBodyTooLargeError",
      limitBytes: 3,
    });
  });

  it("counts streamed bytes, including when Content-Length is absent", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("ab"));
          controller.enqueue(new TextEncoder().encode("cd"));
          controller.close();
        },
      }),
    );

    await expect(readResponseTextWithinBudget(response, 3)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
  });

  it("returns valid UTF-8 up to the supplied dynamic budget", async () => {
    const body = "你好";
    expect(
      await readResponseTextWithinBudget(
        new Response(body),
        new TextEncoder().encode(body).byteLength,
      ),
    ).toBe(body);
  });

  it("holds the shared amplified reservation through consumption and releases it", async () => {
    const admission = createResponseWorkAdmission({
      capacityBytes: 12,
      jsonAmplification: 2,
      minChargeBytes: 2,
    });

    await expect(
      consumeResponseTextWithinBudget(
        new Response("123456"),
        6,
        async (text) => {
          expect(admission.reservedBytes).toBe(12);
          await expect(
            readResponseTextWithinBudget(new Response("x"), 1, admission),
          ).rejects.toBeInstanceOf(ResponseWorkCapacityError);
          return text;
        },
        admission,
      ),
    ).resolves.toBe("123456");
    expect(admission.reservedBytes).toBe(0);
  });

  it("releases the shared reservation when the consumer throws", async () => {
    const admission = createResponseWorkAdmission({
      capacityBytes: 12,
      jsonAmplification: 2,
      minChargeBytes: 2,
    });

    await expect(
      consumeResponseTextWithinBudget(
        new Response("123456"),
        6,
        () => {
          throw new Error("parse failed");
        },
        admission,
      ),
    ).rejects.toThrow("parse failed");
    expect(admission.reservedBytes).toBe(0);
  });
});
