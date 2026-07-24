import { describe, expect, it, vi } from "vitest";
import { createOpenAIClient } from "./openai.js";

const SESSION = { type: "quicksilver", model: "gpt-realtime-1.5" };

describe("createOpenAIClient.realtimeCall", () => {
  it("forwards the public Realtime call as multipart and returns a bound sideband target", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("v=answer\r\n", {
        status: 201,
        headers: {
          "content-type": "application/sdp",
          location: "/v1/realtime/calls/rtc_public",
        },
      }),
    );
    const client = createOpenAIClient({
      config: { baseUrl: "https://api.openai.test/v1", apiKey: "sk-secret" },
      fetch,
    });

    const result = await client.realtimeCall?.({
      endpoint: "realtime",
      query: "intent=quicksilver&architecture=avas",
      sdp: "v=offer\r\n",
      session: SESSION,
      headers: { "openai-alpha": "quicksilver=v1", "x-session-id": "sess-1" },
    });

    expect(result).toMatchObject({
      status: 201,
      sdp: "v=answer\r\n",
      location: "/v1/realtime/calls/rtc_public",
      callId: "rtc_public",
      sideband: {
        url: "wss://api.openai.test/v1/realtime?intent=quicksilver&architecture=avas&call_id=rtc_public",
      },
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.openai.test/v1/realtime/calls?intent=quicksilver&architecture=avas",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(await (form.get("sdp") as File).text()).toBe("v=offer\r\n");
    expect(JSON.parse(await (form.get("session") as File).text())).toEqual(SESSION);
    expect((init.headers as Record<string, string>)["openai-alpha"]).toBe("quicksilver=v1");
    expect(await result?.sideband.headers()).toMatchObject({
      Authorization: "Bearer sk-secret",
      "openai-alpha": "quicksilver=v1",
      "x-session-id": "sess-1",
    });
  });

  it("translates ChatGPT OAuth calls to JSON and keeps Frameless sideband on the bound account", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("v=answer\r\n", {
        status: 201,
        headers: { location: "/v1/live/rtc_backend", "content-type": "application/sdp" },
      }),
    );
    const getAuthHeader = vi.fn().mockResolvedValue("Bearer oauth-token");
    const client = createOpenAIClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader,
        extraHeaders: () => ({ "chatgpt-account-id": "acct-1" }),
      },
      fetch,
    });

    const result = await client.realtimeCall?.({
      endpoint: "live",
      query: "intent=quicksilver&architecture=avas",
      sdp: "v=offer\r\n",
      session: { ...SESSION, delegation: { type: "client" } },
      headers: { "openai-alpha": "quicksilver=v2" },
    });

    const [url, init] = fetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe(
      "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
    );
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      sdp: "v=offer\r\n",
      session: { ...SESSION, delegation: { type: "client" } },
    });
    expect(result?.sideband.url).toBe("wss://chatgpt.com/backend-api/codex/rtc_backend");
    expect(await result?.sideband.headers()).toMatchObject({
      Authorization: "Bearer oauth-token",
      "chatgpt-account-id": "acct-1",
    });
  });

  it("preserves a non-2xx upstream response as an UpstreamError", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad session" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createOpenAIClient({
      config: { baseUrl: "https://api.openai.test/v1", apiKey: "sk-secret" },
      fetch,
    });

    await expect(
      client.realtimeCall?.({
        endpoint: "realtime",
        query: "",
        sdp: "v=offer\r\n",
        session: SESSION,
        headers: {},
      }),
    ).rejects.toMatchObject({ name: "UpstreamError", upstreamStatus: 400 });
  });

  it("refreshes OAuth once after a 401 call-create response", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response("v=answer\r\n", {
          status: 201,
          headers: { location: "/v1/realtime/calls/rtc_refreshed" },
        }),
      );
    let token = 1;
    const onUnauthorized = vi.fn(() => {
      token = 2;
    });
    const client = createOpenAIClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer token-${token}`,
        onUnauthorized,
      },
      fetch,
    });

    const result = await client.realtimeCall?.({
      endpoint: "realtime",
      query: "",
      sdp: "v=offer\r\n",
      session: SESSION,
      headers: {},
    });

    expect(result?.callId).toBe("rtc_refreshed");
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(
      fetch.mock.calls.map((call) => (call[1]?.headers as Record<string, string>).Authorization),
    ).toEqual(["Bearer token-1", "Bearer token-2"]);
  });
});
