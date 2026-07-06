import { describe, expect, it } from 'vitest';

import en from '../../locales/en.json';
import ja from '../../locales/ja.json';
import ko from '../../locales/ko.json';
import zhHans from '../../locales/zh-hans.json';
import zhHant from '../../locales/zh-hant.json';

// ConnectMcpDialog (Memory page) ships localized prose around literal copy-paste
// snippets. These are static `$t('…')` calls so the extractor sees them — but a
// missing translation still silently falls back to English (the exact regression
// the Memory nav subtitle hit). Guard every translatable string.
const mcpKeys = [
  'Connect via MCP',
  "Give an AI agent persistent memory. Helm's MCP server exposes the facts and reflections on this page as tools (memory_add, memory_search, memory_list, …), scoped to the account behind your API key.",
  'The server uses the MCP Streamable HTTP transport at the bare origin + /mcp and authenticates with your API key as a bearer token. Enable it on the gateway with memory.mcp.enabled — until then /mcp returns 404.',
  'Register the server with one command. Claude Code connects over HTTP and sends your key as a bearer token.',
  'Or add it to a .mcp.json (project or user scope). The same entry works in other MCP-aware editors.',
  'Codex and other stdio-only clients reach the HTTP server through the mcp-remote bridge in ~/.codex/config.toml.',
  'Check connectivity and auth with a raw JSON-RPC call. It lists the memory tools the server exposes.',
  'JSON config',
  // ChatGPT OAuth walkthrough prose.
  "ChatGPT connects over OAuth, not a bearer key — you won't paste your key into ChatGPT. Instead, ChatGPT opens a Helm login page where you paste it to authorize.",
  'In ChatGPT, open Settings → Connectors and add a custom connector / MCP server (you may need to turn on developer mode).',
  'Server URL: paste the URL above (it must end in /mcp).',
  'Authentication: choose OAuth.',
  'Client registration: choose a predefined / custom OAuth client. Enter any Client ID (e.g. helm-mcp), leave the client secret empty, and set the token endpoint auth method to none.',
  'Leave the OAuth endpoints, Registration URL, and OIDC fields blank — Helm advertises them automatically via discovery.',
  'Save and connect. ChatGPT opens a Helm login page — paste a Helm API key to authorize; the connection is scoped to the account behind that key.',
  'This requires memory.mcp.oauth.enabled on the gateway, in addition to memory.mcp.enabled.',
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
