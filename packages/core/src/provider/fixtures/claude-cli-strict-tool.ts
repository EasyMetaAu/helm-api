export const STRICT_CLAUDE_CLI_TOOL_GOLDEN = {
  bodyKeys: ["model", "messages", "system", "tools", "tool_choice", "metadata", "max_tokens"],
  headerPrefix: [
    "Accept",
    "Authorization",
    "Content-Type",
    "User-Agent",
    "X-Claude-Code-Session-Id",
    "X-Stainless-Arch",
    "X-Stainless-Lang",
    "X-Stainless-OS",
    "X-Stainless-Package-Version",
    "X-Stainless-Retry-Count",
    "X-Stainless-Runtime",
    "X-Stainless-Runtime-Version",
    "X-Stainless-Timeout",
    "anthropic-beta",
  ],
  toolAliases: {
    read_file: "Read",
    mcp__codegraph__codegraph_context: "McpCodegraphCodegraphContext",
  },
  maxCacheControlBlocks: 4,
} as const;
