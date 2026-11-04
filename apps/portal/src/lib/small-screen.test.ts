import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Small-screen guards for the key-holder portal: tables switch layout on their
// own frame width, controls share one touch height, and every ink class used in
// markup is a real @theme token (an undefined `text-ink-2` generates nothing, so
// inactive nav items rendered the same as active ones).
const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(srcDir, "app.css"), "utf8");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return ext.test(name) ? [path] : [];
  });
}

const svelte = files(srcDir, /\.svelte$/);

function recipe(name: string): string {
  return new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

describe("cards table", () => {
  it("switches layout with a container query on its frame", () => {
    const start = css.indexOf(".cards-table {");
    const body = css.slice(start, css.indexOf("/* — Tabs", start));
    expect(body).not.toMatch(/\blg:/);
    expect(body).toMatch(/\btable-mode:/);
    expect(body).toMatch(/\.cards-table-frame\s*\{[^}]*container/);
    expect(css).toMatch(
      /@custom-variant table-mode[\s\S]*?@container cards-table/,
    );
  });

  it("packs short request cells two to a line on phones", () => {
    expect(css).toMatch(
      /\.cards-table-frame\.dense \.cards-table tr\s*\{[^}]*minmax\(9rem/,
    );
    for (const page of [
      "routes/+page.svelte",
      "routes/requests/+page.svelte",
    ]) {
      const source = readFileSync(join(srcDir, page), "utf8");
      expect(source, page).toContain('class="cards-table-frame dense"');
    }
  });

  it("keeps per-cell table styling on the same container switch", () => {
    const offenders = svelte.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const tables =
        source.match(/<table class="cards-table[\s\S]*?<\/table>/g) ?? [];
      return tables.some((table) => /[\s"'{]lg:/.test(table))
        ? [file.slice(srcDir.length)]
        : [];
    });
    expect(offenders).toEqual([]);
  });

  it("uses cards-table (not the nowrap table-wrap) for the data tables", () => {
    for (const route of ["+page.svelte", "requests/+page.svelte"]) {
      const source = readFileSync(join(srcDir, "routes", route), "utf8");
      expect(source, route).not.toContain("table-wrap");
      expect(source, route).toContain("cards-table-frame");
      // Every cell labels itself for the stacked layout.
      const body = source.match(/<tbody>[\s\S]*?<\/tbody>/g) ?? [];
      for (const tbody of body) {
        expect(tbody.match(/<td(?![^>]*data-label)/g) ?? [], route).toEqual([]);
      }
    }
  });
});

describe("touch targets", () => {
  it("gives form controls the same touch height as buttons, until the nav goes desktop", () => {
    for (const name of [
      "input",
      "input-sm",
      "select",
      "btn-primary",
      "btn-secondary",
    ]) {
      expect(recipe(name), name).toMatch(/\bmin-h-11\b[\s\S]*\bmd:min-h-0\b/);
    }
  });

  it("never wraps button labels", () => {
    for (const name of ["btn-primary", "btn-secondary", "btn-danger"]) {
      expect(recipe(name), name).toMatch(/\bwhitespace-nowrap\b/);
    }
  });
});

describe("ink tokens", () => {
  it("only uses ink-* colors that @theme defines", () => {
    const defined = new Set(
      [...css.matchAll(/--color-(ink[\w-]*):/g)].map((m) => m[1]),
    );
    const used = svelte.flatMap((file) =>
      [
        ...readFileSync(file, "utf8").matchAll(
          /(?:text|bg|border|fill|stroke)-(ink[\w-]*)/g,
        ),
      ].map((m) => `${file.slice(srcDir.length)}: ${m[1]}`),
    );
    const undefinedUses = used.filter(
      (entry) => !defined.has(entry.split(": ")[1]),
    );
    expect(undefinedUses).toEqual([]);
  });
});

describe("header", () => {
  const layout = readFileSync(join(srcDir, "routes/+layout.svelte"), "utf8");
  const switcher = readFileSync(
    join(srcDir, "lib/components/LocaleSwitcher.svelte"),
    "utf8",
  );

  it("gives each locale switcher its own id", () => {
    expect(switcher).not.toContain('id="locale-switcher"');
    expect(switcher).toMatch(/\bid\b[^;]*=/);
    const ids = [...layout.matchAll(/<LocaleSwitcher[^>]*\bid="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(layout.match(/<LocaleSwitcher/g)?.length);
  });

  it("uses an icon button, not a unicode glyph, for the hamburger", () => {
    expect(layout).not.toContain("☰");
    expect(layout).toMatch(/aria-label=\{\$t\("Menu"\)\}[\s\S]*?<svg/);
  });

  it("does not repeat the header locale switcher inside the drawer from sm up", () => {
    const drawer = layout.slice(layout.indexOf("Mobile nav drawer"));
    expect(drawer).toMatch(
      /<div class="[^"]*\bsm:hidden\b[^"]*">\s*<LocaleSwitcher/,
    );
  });
});
