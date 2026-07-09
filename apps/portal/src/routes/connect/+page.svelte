<script lang="ts">
  import { t } from "$lib/i18n";
  import { getKey } from "$lib/auth";

  // base_url is derived from the page origin — the whole point of this page is to
  // stop users guessing whether it needs /v1 (docs/12 §5). We surface BOTH forms.
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const baseNoV1 = origin; // Claude Code wants NO /v1
  const baseV1 = `${origin}/v1`; // Codex + OpenAI SDK want /v1
  const mcpUrl = `${origin}/mcp`;

  const key = getKey() ?? "helm_...";
  let showKey = $state(false);
  const keyForDisplay = $derived(showKey ? key : maskKey(key));
  function maskKey(k: string): string {
    if (k.length < 8) return k;
    return `${k.slice(0, 10)}…${k.slice(-3)}`;
  }

  let mcpEnabled = $state(false);
  $effect(() => {
    // Only show the MCP tab if the server has memory MCP on — /me doesn't carry
    // that flag, so probe /mcp with a harmless tools/list; a 404 means disabled.
    void probeMcp();
  });
  async function probeMcp() {
    try {
      const res = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      mcpEnabled = res.status !== 404;
    } catch {
      mcpEnabled = false;
    }
  }

  type Tab = "claude" | "codex" | "sdk" | "mcp";
  type McpTab = "chatgpt" | "claude" | "json" | "codex" | "curl";
  let tab = $state<Tab>("claude");
  let mcpTab = $state<McpTab>("chatgpt");

  // Client selector options; the MCP entry only appears when the gateway has it on.
  const clientTabs = $derived([
    { id: "claude" as const, label: "Claude Code" },
    { id: "codex" as const, label: "Codex" },
    { id: "sdk" as const, label: $t("OpenAI SDK") },
    ...(mcpEnabled ? [{ id: "mcp" as const, label: $t("Memory (MCP)") }] : []),
  ]);

  let copied = $state("");
  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text.replaceAll("<KEY>", key));
      copied = id;
      setTimeout(() => (copied = ""), 1500);
    } catch {
      copied = "";
    }
  }

  // Optional connection test: fire one /v1/models call.
  let testState = $state<"idle" | "ok" | "fail">("idle");
  async function testConnection() {
    testState = "idle";
    try {
      const res = await fetch(`${origin}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      testState = res.ok ? "ok" : "fail";
    } catch {
      testState = "fail";
    }
  }

  const claudeSnippet = `# 1) Set these two environment variables
export ANTHROPIC_BASE_URL="${baseNoV1}"
export ANTHROPIC_API_KEY="<KEY>"

# 2) Start Claude Code — it now routes through Helm
claude`;
  const codexSnippet = `# 1) Add this provider to ~/.codex/config.toml
[model_providers.helm]
base_url = "${baseV1}"
wire_api = "responses"
env_key = "HELM_API_KEY"

# 2) Set the key in your shell, then run codex
export HELM_API_KEY="<KEY>"`;
  const sdkPython = `from openai import OpenAI

client = OpenAI(base_url="${baseV1}", api_key="<KEY>")
resp = client.chat.completions.create(
    model="auto",  # let Helm route
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)`;
  const sdkNode = `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${baseV1}", apiKey: "<KEY>" });
const resp = await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(resp.choices[0].message.content);`;
  const mcpClaude = `claude mcp add --transport http helm-memory ${mcpUrl} \\
  --header "Authorization: Bearer <KEY>"`;
  const mcpJson = `{
  "mcpServers": {
    "helm-memory": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer <KEY>" }
    }
  }
}`;
  const mcpCodex = `# ~/.codex/config.toml
[mcp_servers.helm-memory]
command = "npx"
args = ["-y", "mcp-remote", "${mcpUrl}", "--header", "Authorization:Bearer <KEY>"]`;
  const mcpCurl = `curl -X POST "${mcpUrl}" \\
  -H "Authorization: Bearer <KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
</script>

<h1 class="page-title mb-1">{$t("Connect a client")}</h1>
<p class="section-desc mb-4">
  {$t(
    "Point your tool at Helm. The base URL is filled in for you — copy and go.",
  )}
</p>

<!-- Key row -->
<div class="card mb-4 flex items-center justify-between gap-3">
  <div>
    <div class="section-desc">{$t("Your API key")}</div>
    <div class="mt-1 font-mono text-sm">{keyForDisplay}</div>
  </div>
  <div class="flex gap-2">
    <button class="btn-secondary" onclick={() => (showKey = !showKey)}>
      {showKey ? $t("Hide") : $t("Show full key")}
    </button>
    <button class="btn-secondary" onclick={() => copy(key, "key")}>
      {copied === "key" ? $t("Copied") : $t("Copy")}
    </button>
  </div>
</div>

<!-- Client selector — a segmented control (active = white pill on a grey track)
     so the current choice is obvious at a glance. -->
<div
  class="mb-4 inline-flex flex-wrap gap-1 rounded-lg bg-canvas p-1"
  role="tablist"
  aria-label={$t("Client")}
>
  {#each clientTabs as ct (ct.id)}
    <button
      type="button"
      role="tab"
      aria-selected={tab === ct.id}
      class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
      class:bg-white={tab === ct.id}
      class:text-ink-1={tab === ct.id}
      class:shadow-sm={tab === ct.id}
      class:text-ink-2={tab !== ct.id}
      class:hover:text-ink-1={tab !== ct.id}
      onclick={() => (tab = ct.id)}
    >
      {ct.label}
    </button>
  {/each}
</div>

<div class="card space-y-4">
  {#if tab === "claude"}
    <p class="alert-warn">
      ⚠️ {$t(
        "Base URL must NOT include /v1 for Claude Code, or you will get a 404.",
      )}
    </p>
    {@render codeBlock(claudeSnippet, "claude")}
    <p class="field-help">
      {$t("Claude Code will route through Helm on its next run.")}
    </p>
  {:else if tab === "codex"}
    <p class="alert-warn">
      ⚠️ {$t(
        'Codex base URL MUST include /v1 (the opposite of Claude Code) and use wire_api = "responses".',
      )}
    </p>
    {@render codeBlock(codexSnippet, "codex")}
  {:else if tab === "sdk"}
    <p class="section-desc">
      {$t(
        'Any OpenAI-compatible client (SDKs, Cline, Roo, Cursor) works with this base URL + key. Use model "auto" to let Helm route.',
      )}
    </p>
    <div>
      <div class="section-header mb-1">Python</div>
      {@render codeBlock(sdkPython, "py")}
    </div>
    <div>
      <div class="section-header mb-1">Node</div>
      {@render codeBlock(sdkNode, "node")}
    </div>
  {:else if tab === "mcp"}
    <p class="section-desc">
      {$t(
        "Give an agent access to your Helm memory over MCP. The server URL is the bare origin plus /mcp.",
      )}
    </p>

    <div
      class="flex max-w-full gap-4 overflow-x-auto border-b border-border [scrollbar-width:thin]"
      role="tablist"
      aria-label={$t("Memory MCP setup")}
    >
      <button
        type="button"
        role="tab"
        class="tab-btn shrink-0 whitespace-nowrap"
        aria-selected={mcpTab === "chatgpt"}
        onclick={() => (mcpTab = "chatgpt")}>{$t("ChatGPT")}</button
      >
      <button
        type="button"
        role="tab"
        class="tab-btn shrink-0 whitespace-nowrap"
        aria-selected={mcpTab === "claude"}
        onclick={() => (mcpTab = "claude")}>{$t("Claude Code")}</button
      >
      <button
        type="button"
        role="tab"
        class="tab-btn shrink-0 whitespace-nowrap"
        aria-selected={mcpTab === "json"}
        onclick={() => (mcpTab = "json")}>{$t("JSON config")}</button
      >
      <button
        type="button"
        role="tab"
        class="tab-btn shrink-0 whitespace-nowrap"
        aria-selected={mcpTab === "codex"}
        onclick={() => (mcpTab = "codex")}>{$t("Codex CLI")}</button
      >
      <button
        type="button"
        role="tab"
        class="tab-btn shrink-0 whitespace-nowrap"
        aria-selected={mcpTab === "curl"}
        onclick={() => (mcpTab = "curl")}>{$t("curl")}</button
      >
    </div>

    <div class="space-y-3">
      {#if mcpTab === "chatgpt"}
        <p class="text-sm text-ink-body">
          {$t(
            "ChatGPT connects over OAuth, not a bearer key — you won't paste your key into ChatGPT. Instead, ChatGPT opens a Helm login page where you paste it to authorize.",
          )}
        </p>
        {@render codeBlock(mcpUrl, "mcp-chatgpt")}
        <ol class="list-decimal space-y-1.5 pl-5 text-sm text-ink-body">
          <li>
            {$t(
              "In ChatGPT, open Settings → Connectors and add a custom connector / MCP server (you may need to turn on developer mode).",
            )}
          </li>
          <li>
            {$t("Server URL: paste the URL above (it must end in /mcp).")}
          </li>
          <li>{$t("Authentication: choose OAuth.")}</li>
          <li>
            {$t(
              "Client registration: choose a predefined / custom OAuth client. Enter any Client ID (e.g. helm-mcp), leave the client secret empty, and set the token endpoint auth method to none.",
            )}
          </li>
          <li>
            {$t(
              "Leave the OAuth endpoints, Registration URL, and OIDC fields blank — Helm advertises them automatically via discovery.",
            )}
          </li>
          <li>
            {$t(
              "Save and connect. ChatGPT opens a Helm login page — paste a Helm API key to authorize; the connection is scoped to the account behind that key.",
            )}
          </li>
        </ol>
        <p class="section-desc">
          {$t(
            "This requires memory.mcp.oauth.enabled on the gateway, in addition to memory.mcp.enabled.",
          )}
        </p>
      {:else if mcpTab === "claude"}
        <p class="text-sm text-ink-body">
          {$t(
            "Register the server with one command. Claude Code connects over HTTP and sends your key as a bearer token.",
          )}
        </p>
        {@render codeBlock(mcpClaude, "mcp-claude")}
      {:else if mcpTab === "json"}
        <p class="text-sm text-ink-body">
          {$t(
            "Or add it to a .mcp.json file at project or user scope. The same entry works in other MCP-aware editors.",
          )}
        </p>
        {@render codeBlock(mcpJson, "mcp-json")}
      {:else if mcpTab === "codex"}
        <p class="text-sm text-ink-body">
          {$t(
            "Codex and other stdio-only clients reach the HTTP server through the mcp-remote bridge in ~/.codex/config.toml.",
          )}
        </p>
        {@render codeBlock(mcpCodex, "mcp-codex")}
      {:else}
        <p class="text-sm text-ink-body">
          {$t(
            "Check connectivity and auth with a raw JSON-RPC call. It lists the memory tools the server exposes.",
          )}
        </p>
        {@render codeBlock(mcpCurl, "mcp-curl")}
      {/if}
    </div>
  {/if}

  <div class="card-actions">
    <button class="btn-secondary" onclick={testConnection}
      >{$t("Test connection")}</button
    >
    {#if testState === "ok"}<span class="badge badge-ok">{$t("Connected")}</span
      >{/if}
    {#if testState === "fail"}<span class="badge badge-error"
        >{$t("Failed")}</span
      >{/if}
  </div>
</div>

{#snippet codeBlock(code: string, id: string)}
  <div class="relative">
    <pre
      class="overflow-x-auto rounded-lg border border-border bg-canvas p-3 pr-12 font-mono text-xs leading-relaxed"><code
        >{code.replaceAll("<KEY>", keyForDisplay)}</code
      ></pre>
    <button
      class="btn-secondary absolute right-2 top-2 px-2 py-1 text-xs"
      title={$t("Copy")}
      onclick={() => copy(code, id)}
    >
      {copied === id ? $t("Copied") : $t("Copy")}
    </button>
  </div>
{/snippet}
