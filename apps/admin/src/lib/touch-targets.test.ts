import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Below `lg` the sidebar is a drawer and the layout is a touch layout, so every
// control keeps a 44px hit area until then. Shrinking at `md` left 768px tablets
// with 32px inputs next to 44px buttons.
const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(srcDir, 'app.css'), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(svelte|css)$/.test(name) ? [path] : [];
  });
}

function recipe(name: string): string {
  return new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
}

describe('touch targets', () => {
  it('gives form controls the same touch height as buttons', () => {
    for (const name of ['input', 'input-sm', 'select', 'btn-primary', 'btn-secondary']) {
      expect(recipe(name), name).toMatch(/\bmin-h-11\b[\s\S]*\blg:min-h-0\b/);
    }
    expect(recipe('menu-trigger')).toMatch(/\bh-11 w-11\b[\s\S]*\blg:h-9 lg:w-9\b/);
  });

  it('never shrinks a touch target before the sidebar breakpoint', () => {
    const offenders = sources(srcDir).filter((file) =>
      /\bmd:(min-h-0|h-4 md:w-4|h-7 md:w-7)\b/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => file.slice(srcDir.length))).toEqual([]);
  });
});
