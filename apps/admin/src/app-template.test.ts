import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('admin app template', () => {
  it('preloads route code on hover but waits for a tap before loading route data', () => {
    const template = readFileSync(resolve(process.cwd(), 'apps/admin/src/app.html'), 'utf8');

    expect(template).toContain('data-sveltekit-preload-code="hover"');
    expect(template).toContain('data-sveltekit-preload-data="tap"');
    expect(template).not.toContain('data-sveltekit-preload-data="hover"');
  });
});
