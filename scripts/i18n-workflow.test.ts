import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{[A-Za-z0-9_]+\}/g)]
    .map(([match]) => match)
    .sort();
}

describe("i18n maintenance workflow", () => {
  it.each(["admin", "portal"])(
    "keeps every %s locale structurally aligned",
    (app) => {
      const english = JSON.parse(
        read(`apps/${app}/src/locales/en.json`),
      ) as Record<string, string>;
      const englishKeys = Object.keys(english).sort();

      for (const locale of ["zh-hans", "zh-hant", "ja", "ko", "es", "pt"]) {
        const translated = JSON.parse(
          read(`apps/${app}/src/locales/${locale}.json`),
        ) as Record<string, string>;
        expect(Object.keys(translated).sort(), `${app}:${locale}:keys`).toEqual(
          englishKeys,
        );
        for (const key of englishKeys) {
          expect(translated[key], `${app}:${locale}:${key}`).not.toBe("");
          expect(
            placeholders(translated[key] ?? ""),
            `${app}:${locale}:${key}`,
          ).toEqual(placeholders(english[key] ?? ""));
        }
      }
    },
  );

  it("keeps Portal-only dynamic translation keys visible to the extractor", () => {
    const path = "apps/portal/src/lib/i18n/extraction-anchors.svelte";
    expect(existsSync(join(root, path))).toBe(true);

    const anchors = existsSync(join(root, path)) ? read(path) : "";
    for (const key of ["Connect", "Today", "Yesterday", "pruned"]) {
      expect(anchors).toContain(`$t("${key}")`);
    }
  });

  it("has a localized value for every Portal extraction anchor", () => {
    const keys = ["Connect", "Today", "Yesterday", "pruned"];
    const english = JSON.parse(
      read("apps/portal/src/locales/en.json"),
    ) as Record<string, string>;

    for (const locale of ["zh-hans", "zh-hant", "ja", "ko", "es", "pt"]) {
      const translated = JSON.parse(
        read(`apps/portal/src/locales/${locale}.json`),
      ) as Record<string, string>;
      for (const key of keys) {
        expect(translated[key], `${locale}:${key}`).toBeTruthy();
        expect(translated[key], `${locale}:${key}`).not.toBe(english[key]);
      }
    }
  });

  it.each(["admin", "portal"])(
    "translates every supported %s locale",
    (app) => {
      const script = read(`apps/${app}/tools/translate-all.sh`);
      for (const pair of [
        "en:zh-hans",
        "zh-hans:zh-hant",
        "en:ja",
        "en:ko",
        "en:es",
        "en:pt",
      ]) {
        expect(script).toContain(`"${pair}"`);
      }
      expect(script).toContain("ships 7 locales");
    },
  );

  it("runs every root i18n command for both Admin and Portal", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    for (const command of [
      "i18n:extract",
      "i18n:update",
      "i18n:translate",
      "i18n:sync",
    ]) {
      expect(pkg.scripts[command]).toContain("@helm/admin");
      expect(pkg.scripts[command]).toContain("@helm/portal");
    }
  });

  it("keeps the English setup page consistently English", () => {
    const setup = read("apps/gateway/src/setup.ts");
    expect(setup).toContain("<small>First-run setup</small>");
    expect(setup).not.toContain("First-run setup / 首次初始化");
  });

  it.each(["admin", "portal"])(
    "uses 通道 consistently in the %s Chinese UI",
    (app) => {
      for (const locale of ["zh-hans", "zh-hant"]) {
        const dict = JSON.parse(
          read(`apps/${app}/src/locales/${locale}.json`),
        ) as Record<string, string>;
        const inconsistent = Object.entries(dict).filter(
          ([, value]) => /\blane\b/i.test(value) || /[車车]道/.test(value),
        );
        expect(inconsistent, `${app}:${locale}`).toEqual([]);
      }
    },
  );

  it.each([
    ["zh-hans", "兜底", /回退|备用/],
    ["zh-hant", "備援", /回退|備用/],
  ] as const)(
    "uses one execution-fallback term in %s",
    (locale, expected, rejected) => {
      const executionFallbackKeys = [
        "Add fallback",
        "drag to reorder fallback",
        "Each provider/model actually tried, in order. If one fails, Helm falls back to the next.",
        "Execution fallback count",
        "fallback",
        "Fallback (ordered)",
        "Fallbacks",
        "How many fallback models were tried before one succeeded.",
        "No fallback models yet. Add one below.",
        "Provider attempts (execution fallback)",
        "Provider, account, and execution fallback count.",
        "Quality tiers and fallback models",
        "Server-side routing rules. Each is a condition → action (force a lane). Policies override task lanes but never the execution fallback chain.",
        "Set the primary model and fallback chain for each quality and cost tier.",
        "The model this lane uses first. Tried before any fallback.",
      ];

      for (const app of ["admin", "portal"]) {
        const dict = JSON.parse(
          read(`apps/${app}/src/locales/${locale}.json`),
        ) as Record<string, string>;
        for (const key of executionFallbackKeys) {
          if (!(key in dict)) continue;
          expect(dict[key], `${app}:${locale}:${key}`).toContain(expected);
          expect(dict[key], `${app}:${locale}:${key}`).not.toMatch(rejected);
        }
      }
    },
  );
});
