import { createNativePassthroughCarrier, nativePassthroughBody } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { applyEnvironmentTimezone, rewriteEnvironmentInput } from "./environment-timezone.js";

const codex = (date = "2026-10-15", zone = "Asia/Shanghai") =>
  `<environment_context>\n  <cwd>/work</cwd>\n  <current_date>${date}</current_date>\n  <timezone>${zone}</timezone>\n</environment_context>`;
const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const instant = new Date("2026-10-15T02:00:00Z");
const transform = (body: Record<string, unknown>, zone = "America/Los_Angeles") =>
  nativePassthroughBody(rewriteEnvironmentInput(body, zone, instant));

describe("verified client environment timezone", () => {
  it("rewrites the latest standalone Codex environment, preserves history and business fields", () => {
    const body = {
      input: [user(codex("2026-10-01")), user(codex()), user("Meeting 2026-10-15 Asia/Shanghai")],
      tools: [{ user_location: { timezone: "Asia/Shanghai" } }],
      previous_response_id: "resp_1",
    };
    const before = JSON.stringify(body);
    const result = transform(body);
    expect(JSON.stringify(result)).toContain("America/Los_Angeles");
    expect(JSON.stringify(result)).toContain("2026-10-14");
    expect(result.input).toEqual([
      body.input[0],
      user(codex("2026-10-14", "America/Los_Angeles")),
      body.input[2],
    ]);
    expect(result.tools).toBe(body.tools);
    expect(result.previous_response_id).toBe("resp_1");
    expect(JSON.stringify(body)).toBe(before);
  });
  it.each([
    ["2026-03-08T07:30:00Z", "America/Los_Angeles", "2026-03-07"],
    ["2026-03-08T07:30:00Z", "America/New_York", "2026-03-08"],
    ["2026-11-01T06:30:00Z", "America/Los_Angeles", "2026-10-31"],
    ["2026-11-01T06:30:00Z", "America/New_York", "2026-11-01"],
  ])("uses IANA rules at %s in %s", (now, zone, date) => {
    const body = { input: [user(codex())] };
    expect(JSON.stringify(rewriteEnvironmentInput(body, zone, new Date(now)))).toContain(date);
  });
  it("supports exact Claude date reminder and Grok user_info prefix without changing the prompt", () => {
    const claude = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>Today's date is 2026-10-15.</system-reminder>",
            },
          ],
        },
      ],
    };
    expect(JSON.stringify(transform(claude))).toContain("Today's date is 2026-10-14.");
    const grok =
      "<user_info>\nOS Version: macOS\nShell: zsh\nWorkspace Path: /work\nToday's date: 2026-10-15\n</user_info>\nPlan 2026-10-15 at 08:00";
    expect(JSON.stringify(transform({ input: [user(grok)] }))).toContain(
      "Today's date: 2026-10-14",
    );
    expect(JSON.stringify(transform({ input: [user(grok)] }))).toContain(
      "Plan 2026-10-15 at 08:00",
    );
  });
  it("updates the exact Grok rollover reminder with both dates, preserving previous environment history", () => {
    const reminder =
      "<system-reminder>\nThe local date has changed since this session started. Today's date is now 2026-10-15. Any date shown earlier in this session was set at startup and is now stale; use 2026-10-15 as the current date.\n</system-reminder>";
    const result = JSON.stringify(transform({ input: [user(reminder)] }));
    expect(result.match(/2026-10-14/g)).toHaveLength(2);
    expect(result).not.toContain("2026-10-15");
  });
  it("does not rewrite quoted examples, assistant output, tool results, schedules, or unknown fields", () => {
    const body = {
      input: [
        user(`Example:\n${codex()}`),
        { role: "assistant", content: codex() },
        { type: "function_call_output", output: codex() },
        user("The user's local timezone is **Asia/Shanghai**"),
      ],
      instructions: codex(),
      metadata: { timezone: "Asia/Shanghai" },
    };
    expect(transform(body)).toBe(body);
  });
  it("invalidates raw bytes and isolates account retries", () => {
    const body = { input: [user(codex())] };
    const original = createNativePassthroughCarrier({
      protocol: "openai_responses",
      body,
      rawBody: JSON.stringify(body),
      headers: { "x-test": "unchanged" },
    });
    const west = rewriteEnvironmentInput(original, "America/Los_Angeles", instant);
    const east = rewriteEnvironmentInput(original, "Asia/Tokyo", instant);
    expect(west).toMatchObject({
      raw_body: undefined,
      mutations: { body_shims_applied: ["client_environment_timezone"] },
    });
    expect(JSON.stringify(east)).toContain("Asia/Tokyo");
    expect(original.raw_body).toBe(JSON.stringify(body));
    expect(original.mutations).toEqual({});
  });
  it("fails open without guessing and avoids lookup without a supported field", async () => {
    const resolver = vi.fn(async () => null);
    const body = { input: [user("hello")] };
    expect(await applyEnvironmentTimezone(body, resolver)).toBe(body);
    expect(resolver).not.toHaveBeenCalled();
    const env = { input: [user(codex())] };
    expect(await applyEnvironmentTimezone(env, resolver)).toBe(env);
    expect(rewriteEnvironmentInput(env, "US", instant)).toBe(env);
  });
});
