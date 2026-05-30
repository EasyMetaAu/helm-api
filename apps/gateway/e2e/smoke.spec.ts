import { expect, test } from "@playwright/test";
import { NONSTREAM_RESPONSE } from "./fixtures/mock-upstream.js";

// The mock echoes the gateway's RESOLVED provider model back as `model`. The
// non-stream body is otherwise the canonical fixture, so we compare every field
// except `model` (which legitimately reflects the routed alias, not the
// client's requested id, since the e2e key has allow_custom_model=false).
const { model: _ignored, ...NONSTREAM_RESPONSE_NO_MODEL } = NONSTREAM_RESPONSE;

const TEST_KEY = "helm_live_e2e_testkey";
const CHAT_BODY = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] };

test("healthz is green", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ready).toBe(true);
});

test("version returns build info", async ({ request }) => {
  const res = await request.get("/version");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty("version");
});

test("rejects a request without an API key (401, no anonymous access)", async ({ request }) => {
  const res = await request.post("/v1/chat/completions", {
    data: { ...CHAT_BODY, stream: false },
    headers: { "Content-Type": "application/json" },
  });
  expect(res.status()).toBe(401);
  const body = await res.json();
  // auth middleware emits the structured HelmError shape directly
  expect(body.error_class).toBe("auth_error");
});

test("rejects an invalid API key (401)", async ({ request }) => {
  const res = await request.post("/v1/chat/completions", {
    data: { ...CHAT_BODY, stream: false },
    headers: { Authorization: "Bearer not-a-real-key", "Content-Type": "application/json" },
  });
  expect(res.status()).toBe(401);
});

test("non-stream passthrough returns the upstream completion unchanged", async ({ request }) => {
  const res = await request.post("/v1/chat/completions", {
    data: { ...CHAT_BODY, stream: false },
    headers: { Authorization: `Bearer ${TEST_KEY}`, "Content-Type": "application/json" },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const { model: _m, ...rest } = body;
  expect(rest).toEqual(NONSTREAM_RESPONSE_NO_MODEL);
  // the echoed model is a routed alias (the e2e key cannot pass custom models).
  expect(typeof body.model).toBe("string");
});

test("stream passthrough yields SSE delta chunks ending in [DONE]", async ({ request }) => {
  const res = await request.post("/v1/chat/completions", {
    data: { ...CHAT_BODY, stream: true },
    headers: { Authorization: `Bearer ${TEST_KEY}`, "Content-Type": "application/json" },
  });
  expect(res.status()).toBe(200);
  const text = await res.text();
  // chunks arrive in order and the stream terminates with [DONE]
  expect(text.indexOf('"hel"')).toBeLessThan(text.indexOf('"lo"'));
  expect(text).toContain("[DONE]");
});

test("does not echo the plaintext API key in any response", async ({ request }) => {
  const res = await request.post("/v1/chat/completions", {
    data: { ...CHAT_BODY, stream: false },
    headers: { Authorization: `Bearer ${TEST_KEY}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  expect(text).not.toContain(TEST_KEY);
});
