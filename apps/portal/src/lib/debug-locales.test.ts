import { expect, it } from "vitest";
import { loadLocaleDict } from "./i18n/loaders";

it("keeps the Portal debug strings and placeholders in all seven locales", async () => {
  const english = await loadLocaleDict("en");
  const keys = [
    "Find by trace ID",
    "Session name or ID",
    "Request not found — it may have been cleaned up by the retention policy or belong to another key.",
    "This request is still being recorded",
    "Open new request",
    "Too many replays. Try again in {seconds} seconds.",
    "Concurrency limit",
    "Kept {days} days",
    "{count} taking too long",
    "{value} tokens/s",
  ];
  for (const locale of [
    "en",
    "zh-hans",
    "zh-hant",
    "ja",
    "ko",
    "es",
    "pt",
  ] as const) {
    const dict = await loadLocaleDict(locale);
    expect(Object.keys(dict).sort()).toEqual(Object.keys(english).sort());
    for (const key of keys) {
      expect(dict[key], `${locale}: ${key}`).toBeTruthy();
      expect(dict[key]?.match(/\{\w+\}/g) ?? []).toEqual(
        key.match(/\{\w+\}/g) ?? [],
      );
      if (locale === "zh-hans" || locale === "zh-hant") {
        expect(dict[key]).not.toBe(key);
      }
    }
  }
});
