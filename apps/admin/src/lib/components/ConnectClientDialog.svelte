<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import Modal from './Modal.svelte';

  // "Connect a client" guide: a tabbed, copy-paste integration reference shown on
  // the API Keys page. Its whole reason to exist is the ASYMMETRIC base-URL footgun
  // (the #1 onboarding mistake): Anthropic clients (Claude Code) append /v1/messages
  // themselves, so they take the BARE origin — a trailing /v1 yields /v1/v1/messages
  // → 404. Codex appends /responses, so it MUST get origin + /v1. Same gateway, two
  // conventions; we spell both out as ready-to-paste snippets so nobody has to read
  // the spec. (See docs/08 client recipes + the helm-claude-code-base-url memo.)
  //
  // The key in the snippets is a placeholder by default. When opened straight from
  // the create-key reveal, the freshly-minted plaintext is injected (one-time) so
  // the operator can copy a complete, working config — it is passed in as a prop,
  // never persisted or re-fetched here (CLAUDE.md 原则7 / docs/06).
  let { plaintextKey, onclose }: { plaintextKey?: string; onclose: () => void } = $props();

  type Tab = 'claude' | 'codex' | 'gemini' | 'openclaw' | 'sdk';
  let tab = $state<Tab>('claude');

  // The gateway is same-origin with this SPA (Hono serves the admin at /admin), so
  // window.location.origin IS the public base URL. SSR-safe default for the first
  // paint; resolved on mount. Caveat: under `pnpm dev` the admin runs on its own
  // Vite port, so this shows the dev URL — correct only when served by the gateway.
  let origin = $state('https://helm.example.com');
  onMount(() => {
    origin = window.location.origin;
  });

  // Anthropic path = bare origin (NO /v1); OpenAI/Responses path = origin + /v1.
  let baseBare = $derived(origin);
  let baseV1 = $derived(`${origin}/v1`);
  // Real minted key when injected post-creation, else a copy-and-replace placeholder.
  let keyShown = $derived(plaintextKey ?? '<your-helm-key>');

  // Snippet bodies are literal template strings, NOT i18n keys — translating a URL,
  // a flag, or TOML punctuation would silently break the config. Only the prose
  // around them is localized.
  let claudeEnv = $derived(
    `export ANTHROPIC_BASE_URL="${baseBare}"\nexport ANTHROPIC_AUTH_TOKEN="${keyShown}"`,
  );
  let codexToml = $derived(
    `# ~/.codex/config.toml\n[model_providers.helm]\nname = "Helm"\nbase_url = "${baseV1}"\nenv_key = "HELM_API_KEY"\nwire_api = "responses"\n\n# then, in your shell:\nexport HELM_API_KEY="${keyShown}"`,
  );
  let geminiCurl = $derived(
    `curl "${baseBare}/v1beta/models/auto:generateContent" \\\n  -H "Content-Type: application/json" \\\n  -H "x-goog-api-key: ${keyShown}" \\\n  -d '{"contents":[{"parts":[{"text":"Hello from Helm"}]}]}'`,
  );
  let openclawCfg = $derived(
    `base_url: ${baseV1}\napi_key: ${keyShown}\nmodel: auto`,
  );
  let sdkOpenai = $derived(
    `from openai import OpenAI\n\nclient = OpenAI(base_url="${baseV1}", api_key="${keyShown}")\nclient.chat.completions.create(model="auto", messages=[...])`,
  );
  let sdkAnthropic = $derived(
    `from anthropic import Anthropic\n\nclient = Anthropic(base_url="${baseBare}", auth_token="${keyShown}")\nclient.messages.create(model="auto", max_tokens=1024, messages=[...])`,
  );

  // Which code block last had its Copy pressed — drives the per-block "Copied" flip
  // without a sub-component or per-block state. Clipboard may be unavailable in an
  // insecure context; degrade silently and never surface the secret in an error.
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
    <div class="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1.5">
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

<Modal label={$t('Connect a client')} {onclose} wide>
  <div class="flex max-h-[80vh] flex-col">
    <h2 class="section-header">{$t('Connect a client')}</h2>
    <p class="mt-1 text-sm text-ink-muted">
      {$t(
        'Point your tool at Helm by setting its base URL and API key, then send model "auto" (or a lane name) — the gateway picks the model.',
      )}
    </p>

    {#if plaintextKey}
      <p data-testid="connect-secret-note" class="mt-2 text-sm text-amber-700">
        {$t(
          'These snippets include your new key, shown only this once. Copy what you need now — we store only a hash, so it cannot be recovered later.',
        )}
      </p>
    {/if}

    <!-- One tab per client; the base-URL convention differs across them by design. -->
    <div class="mt-4 flex gap-4 border-b border-slate-200" role="tablist" aria-label={$t('Connect a client')}>
      <button type="button" role="tab" class="tab-btn" aria-selected={tab === 'claude'}
        onclick={() => (tab = 'claude')}>{$t('Claude Code')}</button
      >
      <button type="button" role="tab" class="tab-btn" aria-selected={tab === 'codex'}
        onclick={() => (tab = 'codex')}>{$t('Codex CLI')}</button
      >
      <button type="button" role="tab" class="tab-btn" aria-selected={tab === 'gemini'}
        onclick={() => (tab = 'gemini')}>{$t('Gemini')}</button
      >
      <button type="button" role="tab" class="tab-btn" aria-selected={tab === 'openclaw'}
        onclick={() => (tab = 'openclaw')}>{$t('OpenClaw')}</button
      >
      <button type="button" role="tab" class="tab-btn" aria-selected={tab === 'sdk'}
        onclick={() => (tab = 'sdk')}>{$t('OpenAI / Anthropic SDK')}</button
      >
    </div>

    <div class="mt-4 min-h-0 flex-1 overflow-auto">
      {#if tab === 'claude'}
        <p class="mb-2 text-sm text-ink-body">
          {$t('Set these environment variables. The base URL is the bare origin — do NOT add /v1 (Anthropic clients append /v1/messages themselves).')}
        </p>
        {@render codeBlock('claude-env', claudeEnv, 'snippet-claude')}
      {:else if tab === 'codex'}
        <p class="mb-2 text-sm text-ink-body">
          {$t('Add a provider to ~/.codex/config.toml. The base URL MUST end in /v1 (Codex appends /responses).')}
        </p>
        {@render codeBlock('codex-toml', codexToml, 'snippet-codex')}
      {:else if tab === 'gemini'}
        <p class="mb-2 text-sm text-ink-body">
          {$t('Use Helm\'s native Gemini route. The base URL is the bare origin; the request path adds /v1beta/models/{model}:generateContent, and auth uses x-goog-api-key.')}
        </p>
        {@render codeBlock('gemini-curl', geminiCurl, 'snippet-gemini')}
      {:else if tab === 'openclaw'}
        <p class="mb-2 text-sm text-ink-body">
          {$t('Configure an OpenAI-compatible provider. The base URL ends in /v1; for the Anthropic path, use the bare origin instead.')}
        </p>
        {@render codeBlock('openclaw-cfg', openclawCfg, 'snippet-openclaw')}
      {:else}
        <p class="mb-2 text-sm text-ink-body">
          {$t('Any OpenAI- or Anthropic-compatible SDK works — only the base URL and key change. Note the /v1 on the OpenAI base URL and its absence on the Anthropic one.')}
        </p>
        <div class="flex flex-col gap-3">
          {@render codeBlock('sdk-openai', sdkOpenai, 'snippet-sdk-openai')}
          {@render codeBlock('sdk-anthropic', sdkAnthropic, 'snippet-sdk-anthropic')}
        </div>
      {/if}
    </div>

    <div class="mt-4 flex justify-end">
      <button type="button" class="btn-secondary" onclick={onclose}>{$t('Close')}</button>
    </div>
  </div>
</Modal>
