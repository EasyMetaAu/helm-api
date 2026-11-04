<script lang="ts">
  import { base } from "$app/paths";
  import { t } from "$lib/i18n";
  import { getKey } from "$lib/auth";
  import { onDestroy } from "svelte";
  import {
    testInferenceConnection,
    type ConnectionResult,
  } from "$lib/connection-test";

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
  let configCopied = $state(false);
  let copyFailed = $state(false);
  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text.replaceAll("<KEY>", key));
      copied = id;
      copyFailed = false;
      if (["claude", "codex", "py", "node"].includes(id)) configCopied = true;
      setTimeout(() => (copied = ""), 1500);
    } catch {
      copyFailed = true;
      copied = "";
    }
  }

  let testRunning = $state(false);
  let testStage = $state<"auth" | "inference">("auth");
  let testResult = $state<ConnectionResult | null>(null);
  let testLane = $state("auto");
  let testAbort: AbortController | undefined;
  onDestroy(() => testAbort?.abort());
  async function testConnection() {
    if (testRunning || tab === "mcp" || !testLane.trim()) return;
    testRunning = true;
    testResult = null;
    testAbort = new AbortController();
    try {
      testResult = await testInferenceConnection({
        origin,
        key,
        client: tab,
        model: testLane.trim(),
        signal: testAbort.signal,
        onStage: (stage) => {
          testStage = stage;
        },
      });
    } finally {
      testRunning = false;
    }
  }

  function shellQuote(value: string): string {
    return "'" + value.replaceAll("'", "'\\''") + "'";
  }
  const claudeSnippet = $derived(`# 1) Set these environment variables
export ANTHROPIC_BASE_URL="${baseNoV1}"
export ANTHROPIC_API_KEY="<KEY>"
export ANTHROPIC_MODEL=${shellQuote(testLane.trim())}

# 2) Start Claude Code — it now routes through Helm
claude`);
  const codexSnippet = $derived(`# 1) Add this provider to ~/.codex/config.toml
[model_providers.helm]
base_url = "${baseV1}"
wire_api = "responses"
env_key = "HELM_API_KEY"

[profiles.helm]
model_provider = "helm"
model = ${JSON.stringify(testLane.trim())}

# 2) Set the key in your shell, then run codex
export HELM_API_KEY="<KEY>"
codex --profile helm`);
  const sdkPython = $derived(`from openai import OpenAI

client = OpenAI(base_url="${baseV1}", api_key="<KEY>")
resp = client.chat.completions.create(
    model=${JSON.stringify(testLane.trim())},
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)`);
  const sdkNode = $derived(`import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${baseV1}", apiKey: "<KEY>" });
const resp = await client.chat.completions.create({
  model: ${JSON.stringify(testLane.trim())},
  messages: [{ role: "user", content: "Hello" }],
});
console.log(resp.choices[0].message.content);`);
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

<h2 class="section-header mb-2">{$t("1. Choose a client")}</h2>

<!-- Client selector — a segmented control (active = white pill on a grey track)
     so the current choice is obvious at a glance. -->
<div
  class="mb-4 inline-flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1"
  role="tablist"
  aria-label={$t("Client")}
>
  {#each clientTabs as ct (ct.id)}
    <button
      type="button"
      role="tab"
      aria-selected={tab === ct.id}
      class="min-h-11 rounded-md px-3 py-1.5 text-sm font-medium transition-colors md:min-h-0"
      class:bg-white={tab === ct.id}
      class:text-ink={tab === ct.id}
      class:shadow-sm={tab === ct.id}
      class:text-ink-body={tab !== ct.id}
      class:hover:text-ink={tab !== ct.id}
      disabled={testRunning}
      onclick={() => {
        tab = ct.id;
        testResult = null;
        configCopied = false;
        copied = "";
        copyFailed = false;
      }}
    >
      {ct.label}
    </button>
  {/each}
</div>

<div class="mb-3 flex flex-wrap items-center gap-2">
  <h2 class="section-header">{$t("2. Apply the configuration")}</h2>
  {#if tab !== "mcp"}<span class="badge badge-neutral"
      >{configCopied
        ? $t("Configuration copied")
        : $t("Configuration ready to copy")}</span
    >{/if}
</div>
<p class="field-help mb-3">
  {$t(
    "Copying does not change files on your computer. Apply the settings below in your client.",
  )}
</p>
<!-- Key row -->
<div
  class="card mb-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"
>
  <div class="min-w-0">
    <div class="section-desc">{$t("Your API key")}</div>
    <div class="mt-1 break-all font-mono text-sm">{keyForDisplay}</div>
  </div>
  <div class="flex shrink-0 gap-2">
    <button class="btn-secondary" onclick={() => (showKey = !showKey)}>
      {showKey ? $t("Hide") : $t("Show full key")}
    </button>
    <button class="btn-secondary" onclick={() => copy(key, "key")}>
      {copied === "key" ? $t("Copied") : $t("Copy")}
    </button>
  </div>
</div>

{#if tab !== "mcp"}
  <div class="mb-4 max-w-sm">
    <label class="block text-sm" for="connection-lane">{$t("Lane")}</label>
    <input
      id="connection-lane"
      class="input mt-1"
      bind:value={testLane}
      oninput={() => {
        testResult = null;
        configCopied = false;
        copied = "";
      }}
      disabled={testRunning}
    />
  </div>
{/if}
{#if copyFailed}<p role="alert" class="alert-error mb-3">
    {$t("Copy failed. Select and copy the configuration manually.")}
  </p>{/if}
<div class="card space-y-4 p-3 sm:p-4">
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
        class="tab-btn min-h-11 shrink-0 whitespace-nowrap md:min-h-0"
        aria-selected={mcpTab === "chatgpt"}
        onclick={() => (mcpTab = "chatgpt")}>{$t("ChatGPT")}</button
      >
      <button
        type="button"
        role="tab"
        class="tab-btn min-h-11 shrink-0 whitespace-nowrap md:min-h-0"
        aria-selected={mcpTab === "claude"}
        onclick={() => (mcpTab = "claude")}>{$t("Claude Code")}</button
      >
      <button
        type="button"
        role="tab"
        class="tab-btn min-h-11 shrink-0 whitespace-nowrap md:min-h-0"
        aria-selected={mcpTab === "json"}
        onclick={() => (mcpTab = "json")}>{$t("JSON config")}</button
      >
      <button
        type="button"
        role="tab"
        class="tab-btn min-h-11 shrink-0 whitespace-nowrap md:min-h-0"
        aria-selected={mcpTab === "codex"}
        onclick={() => (mcpTab = "codex")}>{$t("Codex CLI")}</button
      >
      <button
        type="button"
        role="tab"
        class="tab-btn min-h-11 shrink-0 whitespace-nowrap md:min-h-0"
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
</div>
{#if tab !== "mcp"}
  <div class="mt-5 grid items-start gap-5 lg:grid-cols-2">
    <section class="card" aria-labelledby="test-heading">
      <h2 id="test-heading" class="section-header">
        {$t("3. Test through this browser")}
      </h2>
      <p class="field-help">
        {$t("Browser checks do not verify your local client configuration.")}
      </p>
      <p class="mt-2 text-sm text-ink-muted">
        {$t(
          "Sends one short model request using this key's permissions and budget. Provider charges may apply.",
        )}
      </p>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button
          class="btn-primary shrink-0"
          onclick={testConnection}
          disabled={testRunning || !testLane.trim()}
        >
          {testRunning ? $t("Testing…") : $t("Test inference")}
        </button>
        {#if testRunning}<button
            class="btn-secondary"
            onclick={() => testAbort?.abort()}>{$t("Cancel")}</button
          >{/if}
        <div aria-live="polite" class="flex flex-wrap items-center gap-2">
          {#if testRunning}<span class="text-sm"
              >{testStage === "auth"
                ? $t("Checking authentication…")
                : $t(
                    "Authentication passed. Waiting for a complete response…",
                  )}</span
            >{/if}
          {#if testResult}
            <span
              class:badge-ok={testResult.auth}
              class:badge-error={testResult.failure === "authentication"}
              class:badge-neutral={!testResult.auth &&
                testResult.failure !== "authentication"}
              class="badge"
              >{testResult.auth
                ? $t("Authentication passed")
                : testResult.failure === "authentication"
                  ? $t("Authentication failed")
                  : $t("Authentication not confirmed")}</span
            >
            <span
              class:badge-ok={testResult.inference}
              class:badge-error={!testResult.inference &&
                testResult.failure !== "cancelled"}
              class:badge-neutral={testResult.failure === "cancelled"}
              class="badge"
              >{testResult.inference
                ? $t("Inference completed")
                : $t("Inference not confirmed")}</span
            >
            {#if testResult.status !== null}<span class="text-sm"
                >HTTP {testResult.status}</span
              >{/if}
            {#if testResult.firstOutputMs !== null}<span class="text-sm"
                >{$t("First output")}: {testResult.firstOutputMs} ms</span
              >{/if}
          {/if}
        </div>
      </div>
      {#if testResult}
        <div class="mt-3 space-y-2 text-sm" role="status">
          {#if testResult.failure === "authentication"}
            <p>
              {$t(
                "Check your key and its permissions, then sign in again if needed.",
              )}
            </p>
          {:else if testResult.failure === "cancelled"}
            <p>{$t("Test cancelled. Run it again when ready.")}</p>
          {:else if testResult.failure === "timeout"}
            <p>
              {$t(
                "The test timed out after 30 seconds. Check request details before retrying.",
              )}
            </p>
          {:else if testResult.failure === "network"}
            <p>
              {$t(
                "The connection was interrupted. Check your network and retry.",
              )}
            </p>
          {:else if testResult.failure === "http"}
            <p>
              {$t(
                "Check the lane and available capacity, then retry. An administrator can inspect the request details.",
              )}
            </p>
          {:else if testResult.failure === "stream"}
            <p>
              {$t(
                "No complete answer was received. Open request details to investigate.",
              )}
            </p>
          {/if}
          {#if testResult.requestId}
            <a
              class="text-link underline underline-offset-2"
              href={`${base}/requests/${encodeURIComponent(testResult.requestId)}`}
              >{$t("View test request")}</a
            >
            <p class="field-help">
              {$t("The request record may take a moment to appear.")}
            </p>
          {/if}
        </div>
      {/if}
    </section>
    <section class="card space-y-2" aria-labelledby="client-check-heading">
      <div class="flex flex-wrap items-center gap-2">
        <h2 id="client-check-heading" class="section-header">
          {$t("4. Verify in your client")}
        </h2>
        <span class="badge badge-neutral"
          >{$t("Local client not verified")}</span
        >
      </div>
      <p class="text-sm text-ink-body">
        {#if tab === "claude"}
          {$t(
            "Start a new Claude Code session in the configured terminal and send a short message.",
          )}
        {:else if tab === "codex"}
          {$t(
            "Start Codex with the helm profile in the configured terminal and send a short message.",
          )}
        {:else}
          {$t(
            "Run the configured SDK example once to send a real client request.",
          )}
        {/if}
      </p>
      <p class="field-help">
        {$t(
          "Find that request in your history and check its time and result. Browser test requests also appear there.",
        )}
      </p>
      <a
        class="text-sm text-link underline underline-offset-2"
        href={`${base}/requests`}>{$t("Open request history")}</a
      >
    </section>
  </div>
{/if}

{#snippet codeBlock(code: string, id: string)}
  <div>
    <div class="mb-1 flex justify-end">
      <button
        class="btn-secondary px-2 py-1 text-xs"
        onclick={() => copy(code, id)}
      >
        {copied === id ? $t("Copied") : $t("Copy")}
      </button>
    </div>
    <pre
      class="overflow-x-auto rounded-lg border border-border bg-canvas p-3 font-mono text-xs leading-relaxed"><code
        >{code.replaceAll("<KEY>", keyForDisplay)}</code
      ></pre>
  </div>
{/snippet}
