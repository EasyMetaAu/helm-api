import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function appHtmlPath(): string {
  const fromAdminCwd = join(process.cwd(), "src/app.html");
  if (existsSync(fromAdminCwd)) return fromAdminCwd;
  return join(process.cwd(), "apps/admin/src/app.html");
}

describe("admin app shell", () => {
  it("declares a single favicon so browsers do not fetch duplicate icon assets", () => {
    const html = readFileSync(appHtmlPath(), "utf8");
    const iconLinks = html.match(/rel="icon"/g) ?? [];

    expect(iconLinks).toHaveLength(1);
    expect(html).toContain('href="%sveltekit.assets%/favicon.svg"');
    expect(html).not.toContain('href="%sveltekit.assets%/favicon.png"');
  });
});
