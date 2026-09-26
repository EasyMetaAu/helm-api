import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every admin page fills the window: a max-width page container looks cramped
// and off-center on a full-screen external monitor. Tables stay readable on a
// laptop through column grouping, not by capping the container.
// Runs from either the admin package or the repo root.
const routesDir = existsSync(join(process.cwd(), 'src/routes'))
  ? join(process.cwd(), 'src/routes')
  : join(process.cwd(), 'apps/admin/src/routes');

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === '+page.svelte' ? [path] : [];
  });
}

describe('admin page width', () => {
  it('never caps the page container width', () => {
    const offenders = pages(routesDir).filter((file) => {
      const root = readFileSync(file, 'utf8').split('</script>').pop() ?? '';
      const firstTag = /<(section|div)\s+class="([^"]*)"/.exec(root)?.[2] ?? '';
      return /\bmax-w-|\bmx-auto\b/.test(firstTag);
    });
    expect(offenders).toEqual([]);
  });

  it('defines the shared page shell without a max width', () => {
    const css = readFileSync(join(routesDir, '../app.css'), 'utf8');
    const shell = /\.page\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(shell).toContain('w-full');
    expect(shell).not.toMatch(/max-w-/);
  });
});
