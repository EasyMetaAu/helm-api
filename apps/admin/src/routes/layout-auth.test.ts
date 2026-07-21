import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('admin shell authentication controls', () => {
  it('uses a native same-origin logout form that clears the signed session', () => {
    const layout = readFileSync(
      resolve(process.cwd(), 'apps/admin/src/routes/+layout.svelte'),
      'utf8',
    );

    expect(layout).toContain('method="post"');
    expect(layout).toContain('action={`${base}/logout`}');
    expect(layout).toContain("aria-label={$t('Sign out')}");
  });
});
