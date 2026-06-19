import { describe, expect, it } from 'vitest';

import en from '../../locales/en.json';
import ja from '../../locales/ja.json';
import ko from '../../locales/ko.json';
import zhHans from '../../locales/zh-hans.json';
import zhHant from '../../locales/zh-hant.json';

// ConnectMcpDialog (Memory page) ships localized prose around literal copy-paste
// snippets. These are static `$t('…')` calls so the extractor sees them — but a
// missing translation still silently falls back to English (the exact regression
// the Memory nav subtitle hit). Guard every translatable string. 'curl' is a proper
// noun (command name), identical across locales by design, so it is NOT asserted to
// differ from English.
const mcpKeys = [
  'Connect via MCP',
  "Give an AI agent persistent memory. Helm's MCP server exposes the facts and reflections on this page as tools (memory_add, memory_search, memory_list, …), scoped to the account behind your API key.",
  'The server uses the MCP Streamable HTTP transport at the bare origin + /mcp and authenticates with your API key as a bearer token. Enable it on the gateway with memory.mcp.enabled — until then /mcp returns 404.',
  'Register the server with one command. Claude Code connects over HTTP and sends your key as a bearer token.',
  'Or add it to a .mcp.json (project or user scope). The same entry works in other MCP-aware editors.',
  'Codex and other stdio-only clients reach the HTTP server through the mcp-remote bridge in ~/.codex/config.toml.',
  'Check connectivity and auth with a raw JSON-RPC call. It lists the memory tools the server exposes.',
  'JSON config',
] as const;

const translatedLocales = {
  'zh-hans': zhHans,
  'zh-hant': zhHant,
  ja,
  ko,
} as const;

describe('ConnectMcpDialog locale coverage', () => {
  it.each(Object.entries(translatedLocales))(
    '%s translates every MCP dialog string instead of falling back to English',
    (_locale, dict: Record<string, string>) => {
      for (const key of mcpKeys) {
        expect(dict).toHaveProperty(key);
        expect(dict[key]).toBeTruthy();
        expect(dict[key]).not.toBe((en as Record<string, string>)[key]);
      }
    },
  );
});
