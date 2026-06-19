<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import Modal from './Modal.svelte';

  // "Connect via MCP" guide: a tabbed, copy-paste reference shown on the Memory
  // page, mirroring the API Keys "Connect a client" dialog. Helm's memory MCP
  // server (docs/13) speaks the MCP Streamable HTTP transport at POST /mcp on the
  // BARE origin — NOT /v1 (that path is the OpenAI/Responses chat surface). It is
  // authed by the SAME API key as /v1, sent as a bearer token, and a tool call is
  // scoped to that key's account + default project — so the agent reads and writes
  // the very facts/reflections shown on this page.
  //
  // The endpoint is fail-closed: it only exists when memory.mcp.enabled is set on
  // the gateway, otherwise /mcp returns 404 (server.ts). We say so in the prose.
  //
  // Snippet bodies are literal template strings, NOT i18n keys — translating a URL,
  // a CLI flag, or TOML/JSON punctuation would silently break the config. Only the
  // prose around them is localized. The key is a copy-and-replace placeholder by
  // default; a freshly-minted plaintext can be injected (one-time) like the sibling
  // dialog, but the Memory page opens this without one.
  let { plaintextKey, onclose }: { plaintextKey?: string; onclose: () => void } = $props();

  type Tab = 'claude' | 'json' | 'codex' | 'curl';
  let tab = $state<Tab>('claude');

  // Admin is same-origin with the gateway (Hono serves it at /admin), so
  // window.location.origin IS the public base URL. SSR-safe default; resolved on
  // mount. Under `pnpm dev` this shows the Vite port — correct only when served by
  // the gateway.
  let origin = $state('https://helm.example.com');
  onMount(() => {
    origin = window.location.origin;
  });

  // MCP endpoint = bare origin + /mcp (NOT /v1/mcp).
  let mcpUrl = $derived(`${origin}/mcp`);
  let keyShown = $derived(plaintextKey ?? '<your-helm-key>');

  let claudeCmd = $derived(
    `claude mcp add --transport http helm-memory ${mcpUrl} \\\n  --header "Authorization: Bearer ${keyShown}"`,
  );
  let jsonCfg = $derived(
    `{\n  "mcpServers": {\n    "helm-memory": {\n      "type": "http",\n      "url": "${mcpUrl}",\n      "headers": { "Authorization": "Bearer ${keyShown}" }\n    }\n  }\n}`,
  );
  // Codex (and any stdio-only client) reach the HTTP server through the mcp-remote
  // bridge — no space around the header colon, which trips Codex's arg parsing.
  let codexToml = $derived(
    `# ~/.codex/config.toml\n[mcp_servers.helm-memory]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "${mcpUrl}", "--header", "Authorization:Bearer ${keyShown}"]`,
  );
  let curlCmd = $derived(
    `curl -X POST "${mcpUrl}" \\\n  -H "Authorization: Bearer ${keyShown}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  );

  // Which code block last had its Copy pressed — drives the per-block "Copied" flip
  // without a sub-component. Clipboard may be unavailable in an insecure context;
  // degrade silently and never surface the secret in an error.
  let copiedId = $state<string | null>(null);
  async function copy(id: string, text: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(text);
      copiedId = id;
    } catch {
      copiedId = null;
    }
  }
</script>

{#snippet codeBlock(id: string, code: string, testid: string)}
  <div class="overflow-hidden rounded-lg border border-slate-200">
    <div
      class="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1.5"
    >
      <span class="font-mono text-xs text-ink-muted">{testid.replace('snippet-', '')}</span>
      <button type="button" class="btn-primary-sm" onclick={() => copy(id, code)}
        >{copiedId === id ? $t('Copied') : $t('Copy')}</button
      >
    </div>
    <pre
      data-testid={testid}
      class="overflow-auto whitespace-pre-wrap break-words bg-white p-3 font-mono text-xs leading-relaxed text-ink-strong [overflow-wrap:anywhere]">{code}</pre>
  </div>
{/snippet}

<Modal label={$t('Connect via MCP')} {onclose} wide>
  <div class="flex max-h-[80vh] flex-col">
    <h2 class="section-header">{$t('Connect via MCP')}</h2>
    <p class="mt-1 text-sm text-ink-muted">
      {$t(
        "Give an AI agent persistent memory. Helm's MCP server exposes the facts and reflections on this page as tools (memory_add, memory_search, memory_list, …), scoped to the account behind your API key.",
      )}
    </p>
    <p class="mt-1 text-sm text-ink-muted">
      {$t(
        'The server uses the MCP Streamable HTTP transport at the bare origin + /mcp and authenticates with your API key as a bearer token. Enable it on the gateway with memory.mcp.enabled — until then /mcp returns 404.',
      )}
    </p>

    {#if plaintextKey}
      <p data-testid="connect-secret-note" class="mt-2 text-sm text-amber-700">
        {$t(
          'These snippets include your new key, shown only this once. Copy what you need now — we store only a hash, so it cannot be recovered later.',
        )}
      </p>
    {/if}

    <!-- One tab per client; all hit the same POST /mcp endpoint with a bearer key. -->
    <div
      class="mt-4 flex max-w-full gap-4 overflow-x-auto border-b border-slate-200 [scrollbar-width:thin]"
      role="tablist"
      aria-label={$t('Connect via MCP')}
    >
      <button
        type="button"
        role="tab"
        class="tab-btn shrink-0 whitespace-nowrap"
        aria-selected={tab === 'claude'}
        onclick={() => (tab = 'claude')}>{$t('Claude Code')}</button
      >
      <button
        type="button"
        role="tab"
        class="tab-btn shrink-0 whitespace-nowrap"
        aria-selected={tab === 'json'}
        onclick={() => (tab = 'json')}>{$t('JSON config')}</button
      >
      <button
        type="button"
        role="tab"
        class="tab-btn shrink-0 whitespace-nowrap"
        aria-selected={tab === 'codex'}
        onclick={() => (tab = 'codex')}>{$t('Codex CLI')}</button
      >
      <button
        type="button"
        role="tab"
        class="tab-btn shrink-0 whitespace-nowrap"
        aria-selected={tab === 'curl'}
        onclick={() => (tab = 'curl')}>{$t('curl')}</button
      >
    </div>

    <div class="mt-4 min-h-0 flex-1 overflow-auto">
      {#if tab === 'claude'}
        <p class="mb-2 text-sm text-ink-body">
          {$t(
            'Register the server with one command. Claude Code connects over HTTP and sends your key as a bearer token.',
          )}
        </p>
        {@render codeBlock('mcp-claude', claudeCmd, 'snippet-mcp-claude')}
      {:else if tab === 'json'}
        <p class="mb-2 text-sm text-ink-body">
          {$t(
            'Or add it to a .mcp.json (project or user scope). The same entry works in other MCP-aware editors.',
          )}
        </p>
        {@render codeBlock('mcp-json', jsonCfg, 'snippet-mcp-json')}
      {:else if tab === 'codex'}
        <p class="mb-2 text-sm text-ink-body">
          {$t(
            'Codex and other stdio-only clients reach the HTTP server through the mcp-remote bridge in ~/.codex/config.toml.',
          )}
        </p>
        {@render codeBlock('mcp-codex', codexToml, 'snippet-mcp-codex')}
      {:else}
        <p class="mb-2 text-sm text-ink-body">
          {$t(
            'Check connectivity and auth with a raw JSON-RPC call. It lists the memory tools the server exposes.',
          )}
        </p>
        {@render codeBlock('mcp-curl', curlCmd, 'snippet-mcp-curl')}
      {/if}
    </div>

    <div class="mt-4 flex justify-end">
      <button type="button" class="btn-secondary" onclick={onclose}>{$t('Close')}</button>
    </div>
  </div>
</Modal>
