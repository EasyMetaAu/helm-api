import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Wide management tables switch between stacked cards and a real table on the
// width of their own frame, not the viewport. A viewport `lg` switch turned them
// into tables at 1024px even though the sidebar leaves ~800px, so columns were
// squeezed until status badges wrapped one character per line.
const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(srcDir, 'app.css'), 'utf8');

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return svelteFiles(path);
    return name.endsWith('.svelte') ? [path] : [];
  });
}

describe('cards table', () => {
  it('switches layout with a container query on its frame', () => {
    const recipe = css.slice(css.indexOf('.cards-table {'), css.indexOf('/* — Tabs'));
    expect(recipe).not.toMatch(/\blg:/);
    expect(recipe).toMatch(/\btable-mode:/);
    expect(recipe).toMatch(/\.cards-table-frame\s*\{[^}]*container/);
    expect(css).toMatch(/@custom-variant table-mode[\s\S]*?@container cards-table/);
  });

  it('packs short request cells two to a line on phones', () => {
    expect(css).toMatch(/\.cards-table-frame\.dense \.cards-table tr\s*\{[^}]*minmax\(9rem/);
    const table = readFileSync(join(srcDir, 'lib/components/RequestsTable.svelte'), 'utf8');
    expect(table).toContain('class="cards-table-frame dense"');
  });

  it('keeps per-cell table styling on the same container switch', () => {
    const offenders = svelteFiles(srcDir).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const tables = source.match(/<table class="cards-table[\s\S]*?<\/table>/g) ?? [];
      // Touch sizing (min-h-0, h-4 w-4) follows the viewport on purpose.
      const layout = /[\s"'{]lg:(?!min-h-0|h-4|w-4)/;
      return tables.some((table) => layout.test(table)) ? [file.slice(srcDir.length)] : [];
    });
    expect(offenders).toEqual([]);
  });
});
