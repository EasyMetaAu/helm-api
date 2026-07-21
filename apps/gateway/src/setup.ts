import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./app.js";
import { readBuildInfo } from "./build-info.js";
import type { ServerHandle } from "./server.js";

const MANAGED_ENV_FILE = "helm-managed-env.json";
const SETUP_TOKEN_FILE = "helm-setup-token";
const MANAGED_KEYS = new Set([
  "HELM_ADMIN_ENABLED",
  "HELM_ADMIN_USER",
  "HELM_ADMIN_PASSWORD",
  "HELM_OAUTH_ENC_KEY",
]);

const ManagedEnvironmentSchema = z.record(z.string(), z.string());
const TestProviderSchema = z
  .object({ providerId: z.string().min(1).max(128), apiKey: z.string().max(8192).default("") })
  .strict();
const CompleteSetupSchema = z
  .object({
    username: z.string().trim().min(1).max(128),
    password: z.string().max(512),
    providerKeys: z.record(z.string(), z.string().max(8192)),
  })
  .strict();

export interface SetupProvider {
  id: string;
  label: string;
  envName: string;
  configured: boolean;
}

export interface SetupServerOptions {
  dataDir: string;
  host: string;
  port: number;
  providers: SetupProvider[];
  env: Record<string, string | undefined>;
  testProvider: (providerId: string, apiKey: string) => Promise<void>;
  buildFullServer: () => Promise<ServerHandle>;
  activate: (handle: ServerHandle) => void;
  readRootKey: () => Promise<string | null>;
  log: (line: string) => void;
}

export interface SetupServerResult {
  handle: ServerHandle;
  token: string;
}

export function managedEnvironmentPath(dataDir: string): string {
  return join(dataDir, MANAGED_ENV_FILE);
}

function setupTokenPath(dataDir: string): string {
  return join(dataDir, SETUP_TOKEN_FILE);
}

function flag(value: string | undefined): boolean | null {
  if (value === undefined || value.trim() === "") return null;
  if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
  if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  return null;
}

export function setupRequired(env: Record<string, string | undefined>): boolean {
  if (flag(env.HELM_SETUP_DISABLED) === true) return false;
  if (flag(env.HELM_ADMIN_ENABLED) === false) return false;
  return !env.HELM_ADMIN_USER?.trim() || !env.HELM_ADMIN_PASSWORD;
}

async function assertPrivateFile(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${path} contains secrets and must use mode 0600 (current ${mode.toString(8)})`,
    );
  }
}

export async function loadManagedEnvironment(input: {
  dataDir: string;
  env: Record<string, string | undefined>;
  allowedProviderEnvNames: readonly string[];
}): Promise<boolean> {
  const path = managedEnvironmentPath(input.dataDir);
  try {
    await access(path, constants.F_OK);
  } catch {
    return false;
  }
  await assertPrivateFile(path);
  const parsed = ManagedEnvironmentSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const allowed = new Set([...MANAGED_KEYS, ...input.allowedProviderEnvNames]);
  for (const [name, value] of Object.entries(parsed)) {
    if (!allowed.has(name)) throw new Error(`unsupported key in ${path}: ${name}`);
    if (!input.env[name]) input.env[name] = value;
  }
  return true;
}

function sameSecret(actual: string, expected: string): boolean {
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function testMarker(providerId: string, apiKey: string): string {
  return `${providerId}:${createHash("sha256").update(apiKey).digest("hex")}`;
}

function redact(message: string, secrets: readonly string[]): string {
  let safe = message;
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join("[redacted]");
  }
  return safe.slice(0, 500);
}

async function readOrCreateSetupToken(
  dataDir: string,
  port: number,
  log: (line: string) => void,
): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = setupTokenPath(dataDir);
  try {
    const token = (await readFile(path, "utf8")).trim();
    await assertPrivateFile(path);
    if (!token) throw new Error(`${path} is empty`);
    log(`Open http://127.0.0.1:${port}/setup#token=${token} to finish setup.`);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  log(`First-run setup token: ${token}`);
  log(`Open http://127.0.0.1:${port}/setup#token=${token} to finish setup.`);
  return token;
}

function setupPage(
  providers: readonly SetupProvider[],
  defaultUsername: string,
  passwordConfigured: boolean,
  nonce: string,
): string {
  const providerJson = JSON.stringify(providers).replaceAll("<", "\\u003c");
  const usernameJson = JSON.stringify(defaultUsername).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Set up Helm</title>
<style nonce="${nonce}">
:root{color-scheme:light;--brand:#4f46e5;--ink:#0f172a;--body:#475569;--muted:#64748b;--line:#e2e8f0;--bg:#f8fafc;--ok:#047857;--bad:#b91c1c}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--body);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}main{width:min(760px,calc(100% - 32px));margin:48px auto}.brand{display:flex;align-items:center;gap:10px;margin-bottom:24px}.logo{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--brand);color:#fff;font-weight:800}.brand strong,h1,h2{color:var(--ink)}h1{font-size:30px;line-height:1.2;margin:0 0 8px}.lead{margin:0 0 24px;color:var(--muted)}.steps{display:flex;gap:8px;margin:0 0 16px}.step{flex:1;height:4px;border-radius:99px;background:var(--line)}.step.on{background:var(--brand)}.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:24px;box-shadow:0 1px 2px #0f172a0a}.section+.section{margin-top:26px;padding-top:24px;border-top:1px solid var(--line)}h2{font-size:18px;margin:0 0 6px}.hint{font-size:13px;color:var(--muted);margin:0 0 14px}label{display:block;font-weight:600;color:#334155;margin:12px 0 5px}input{width:100%;min-height:44px;border:1px solid #cbd5e1;border-radius:7px;padding:9px 11px;font:inherit;color:var(--ink);background:#fff}input:focus{outline:3px solid #c7d2fe;border-color:var(--brand)}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.provider{border:1px solid var(--line);border-radius:9px;padding:14px;margin-top:10px}.row{display:flex;align-items:center;gap:10px}.row input{flex:1}.row button{flex:none}.status{min-height:21px;margin-top:7px;font-size:13px}.ok{color:var(--ok)}.bad{color:var(--bad)}button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;border:0;border-radius:7px;padding:9px 15px;font:600 14px/1 system-ui;cursor:pointer;text-decoration:none}.primary{background:var(--brand);color:#fff}.secondary{background:#eef2ff;color:#3730a3}.finish{margin-top:24px;display:flex;justify-content:flex-end}button:disabled{opacity:.55;cursor:wait}.error{margin-top:12px;padding:10px 12px;border-radius:7px;background:#fef2f2;color:var(--bad)}.success{display:none}.success.show{display:block}.secret{position:relative;background:#0f172a;color:#e2e8f0;padding:14px;border-radius:8px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace}.actions{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}.guides{display:grid;gap:10px}.guide{border:1px solid var(--line);border-radius:8px;padding:13px}.guide strong{color:var(--ink)}@media(max-width:620px){main{margin:24px auto}.card{padding:18px}.grid{grid-template-columns:1fr}.row{align-items:stretch;flex-direction:column}.row button{width:100%}}
.hint a{color:#4338ca}details{margin-top:14px}summary{cursor:pointer;color:#3730a3;font-weight:600}.subscription{margin-top:18px;padding:14px;border:1px solid var(--line);border-radius:9px;background:#f8fafc}.subscription p{margin:5px 0 0}.subscription strong{color:var(--ink)}
</style>
</head>
<body><main>
  <div class="brand"><span class="logo">H</span><span><strong>Helm API</strong><br><small>First-run setup / 首次初始化</small></span></div>
  <div id="setup-ui">
    <h1>Set up Helm</h1><p class="lead">Create the administrator, optionally add OpenRouter or DeepSeek, then copy the automatically generated administrator token.</p>
    <div class="steps"><span class="step on"></span><span class="step on"></span><span class="step"></span></div>
    <div class="card">
      <section class="section"><h2>1. Administrator</h2><p id="admin-hint" class="hint">These credentials protect the operations dashboard. Use a unique password of at least 12 characters.</p><div class="grid"><div><label for="username">Username</label><input id="username" autocomplete="username" /></div><div><label for="password">Password</label><input id="password" type="password" autocomplete="new-password" /></div></div><label for="confirm">Confirm password</label><input id="confirm" type="password" autocomplete="new-password" /></section>
      <section class="section"><h2>2. Provider access</h2><p class="hint">All API keys are optional. Start with OpenRouter or DeepSeek, leave either one blank, or skip every key and bind a subscription after setup. Testing a key sends one tiny real request and may have a very small cost.</p><div id="providers"></div><details id="other-providers"><summary>Other API key providers (optional)</summary><div id="other-provider-list"></div></details><div class="subscription"><strong>Use a subscription instead</strong><p class="hint">No API key is needed for ChatGPT Plus/Pro (Codex), Claude Pro/Max, GitHub Copilot, or experimental Grok. Finish setup, then choose <b>Bind a subscription</b>. Use only accounts you are authorized to connect and review the provider terms.</p></div></section>
      <div id="error" class="error" hidden></div><div class="finish"><button id="complete" class="primary">Finish setup</button></div>
    </div>
  </div>
  <div id="success" class="success">
    <h1>Helm is ready</h1><p class="lead">The full gateway is running. Helm automatically created the administrator API token below; save it now because it is shown only once.</p>
    <div class="card"><h2>Administrator API token</h2><pre id="root-key" class="secret"></pre><div class="actions"><button id="copy-key" class="secondary">Copy administrator token</button><a class="button primary" href="/admin/providers">Bind a subscription</a><a class="button secondary" href="/admin/keys">API keys & client guide</a></div><p class="hint">Subscription-only setup: bind an account, run its Test action, and enable the models you want. Until one provider is usable, inference calls return a structured 503 instead of crashing the service.</p><div class="guides"><div class="guide"><strong>Claude Code</strong><pre id="guide-claude" class="secret"></pre></div><div class="guide"><strong>Codex CLI</strong><pre id="guide-codex" class="secret"></pre></div><div class="guide"><strong>OpenAI-compatible SDK</strong><pre id="guide-openai" class="secret"></pre></div><div class="guide"><strong>Portal & Memory MCP</strong><p>Open <a href="/portal/connect">/portal/connect</a> for Portal, SDK, Claude Code, Codex, and MCP instructions.</p></div></div></div>
  </div>
</main>
<script nonce="${nonce}">
const providers=${providerJson};const defaultUsername=${usernameJson};const passwordConfigured=${JSON.stringify(passwordConfigured)};const setupToken=new URLSearchParams(location.hash.slice(1)).get('token')||'';const byId=new Map(providers.map(p=>[p.id,p]));const tested=new Set();const featuredProviderIds=new Set(['OPENROUTER_API_KEY','DEEPSEEK_API_KEY']);const providerMeta={OPENROUTER_API_KEY:{label:'OpenRouter',signupUrl:'https://openrouter.ai/settings/keys'},DEEPSEEK_API_KEY:{label:'DeepSeek',signupUrl:'https://platform.deepseek.com/api_keys'}};
const $=id=>document.getElementById(id);$('username').value=defaultUsername;if(passwordConfigured){$('password').disabled=true;$('confirm').disabled=true;$('password').placeholder='Managed by environment';$('confirm').placeholder='Managed by environment';$('admin-hint').textContent='The password is already supplied by the external environment. Choose the missing username to finish setup.'}
function showError(message){const e=$('error');e.textContent=message;e.hidden=!message}
async function call(path,body){if(!setupToken)throw new Error('Open the complete setup link printed by Docker or quickstart.');const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-helm-setup-token':setupToken},body:JSON.stringify(body)});let data={};try{data=await r.json()}catch{}if(!r.ok)throw new Error(data.message||data.error||('HTTP '+r.status));return data}
const holder=$('providers');const otherHolder=$('other-provider-list');for(const p of providers){const meta=providerMeta[p.envName]||{};const box=document.createElement('div');box.className='provider';box.innerHTML='<strong></strong><p class="hint"></p><div class="row"><input type="password" autocomplete="off" /><button class="secondary">Test key</button></div><div class="status"></div>';box.querySelector('strong').textContent=meta.label||p.label;const hint=box.querySelector('.hint');hint.textContent=p.configured?'A key is already supplied by the environment. Leave this blank to test it.':'Optional. Stored privately after a successful test.';if(meta.signupUrl&&!p.configured){const link=document.createElement('a');link.href=meta.signupUrl;link.target='_blank';link.rel='noopener';link.textContent='Register / get a key ↗';hint.append(' ',link)}const input=box.querySelector('input');input.placeholder=p.configured?'Configured by environment':'Paste '+p.envName+' or leave blank';input.dataset.provider=p.id;const button=box.querySelector('button');const status=box.querySelector('.status');button.addEventListener('click',async()=>{button.disabled=true;status.className='status';status.textContent='Testing…';showError('');try{await call('/setup/api/test-provider',{providerId:p.id,apiKey:input.value});tested.add(p.id+':'+input.value);status.className='status ok';status.textContent='Connection passed'}catch(e){status.className='status bad';status.textContent=e.message}finally{button.disabled=false}});(featuredProviderIds.has(p.envName)?holder:otherHolder).append(box)}$('other-providers').hidden=otherHolder.childElementCount===0;
$('complete').addEventListener('click',async()=>{showError('');const password=$('password').value;if(password!==$('confirm').value){showError('Passwords do not match.');return}const providerKeys={};for(const input of document.querySelectorAll('input[data-provider]'))if(input.value)providerKeys[input.dataset.provider]=input.value;const button=$('complete');button.disabled=true;button.textContent='Starting Helm…';try{const data=await call('/setup/api/complete',{username:$('username').value,password,providerKeys});history.replaceState(null,'',location.pathname+location.search);$('setup-ui').hidden=true;$('success').classList.add('show');const key=data.apiKey||'Administrator token already existed. Read the configured recovery file.';$('root-key').textContent=key;const origin=location.origin;$('guide-claude').textContent='export ANTHROPIC_BASE_URL="'+origin+'"\\nexport ANTHROPIC_AUTH_TOKEN="'+key+'"';$('guide-codex').textContent='[model_providers.helm]\\nname = "Helm"\\nbase_url = "'+origin+'/v1"\\nenv_key = "HELM_API_KEY"\\nwire_api = "responses"\\n\\nexport HELM_API_KEY="'+key+'"';$('guide-openai').textContent='OpenAI(base_url="'+origin+'/v1", api_key="'+key+'")';window.scrollTo({top:0,behavior:'smooth'})}catch(e){showError(e.message);button.disabled=false;button.textContent='Finish setup'}});
$('copy-key').addEventListener('click',()=>navigator.clipboard?.writeText($('root-key').textContent||''));
</script></body></html>`;
}

export async function createSetupServer(opts: SetupServerOptions): Promise<SetupServerResult> {
  const token = await readOrCreateSetupToken(opts.dataDir, opts.port, opts.log);
  const app = new Hono<AppEnv>();
  const tested = new Set<string>();
  let completing = false;
  const providerById = new Map(opts.providers.map((provider) => [provider.id, provider]));

  app.get("/", (c) => c.redirect("/setup", 302));
  app.get("/healthz", (c) =>
    c.json({ status: "setup_required", ready: true, checks: { setup: "required" } }, 200),
  );
  app.get("/version", (c) => c.json(readBuildInfo(), 200));
  app.get("/setup", (c) => {
    const nonce = randomBytes(18).toString("base64");
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    );
    c.header("Cache-Control", "no-store");
    return c.html(
      setupPage(
        opts.providers,
        opts.env.HELM_ADMIN_USER?.trim() || "admin",
        Boolean(opts.env.HELM_ADMIN_PASSWORD),
        nonce,
      ),
    );
  });

  const authorized = (header: string | undefined): boolean =>
    typeof header === "string" && sameSecret(header, token);

  app.post("/setup/api/test-provider", async (c) => {
    if (!authorized(c.req.header("x-helm-setup-token")))
      return c.json({ error: "unauthorized" }, 401);
    const parsed = TestProviderSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const provider = providerById.get(parsed.data.providerId);
    if (!provider) return c.json({ error: "unknown_provider" }, 404);
    const apiKey = parsed.data.apiKey || opts.env[provider.envName] || "";
    if (!apiKey) {
      return c.json(
        { error: "api_key_required", message: "Enter an API key before testing." },
        400,
      );
    }
    if (provider.configured && parsed.data.apiKey) {
      return c.json(
        {
          error: "external_env_wins",
          message:
            "This key is supplied by the external environment. Update .env or the container secret instead.",
        },
        409,
      );
    }
    try {
      await opts.testProvider(provider.id, apiKey);
      tested.add(testMarker(provider.id, apiKey));
      return c.json({ ok: true }, 200);
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error), [apiKey]);
      return c.json({ error: "provider_test_failed", message }, 422);
    }
  });

  app.post("/setup/api/complete", async (c) => {
    if (!authorized(c.req.header("x-helm-setup-token")))
      return c.json({ error: "unauthorized" }, 401);
    if (completing) return c.json({ error: "setup_in_progress" }, 409);
    const parsed = CompleteSetupSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", message: "Use a username and a 12+ character password." },
        400,
      );
    }
    const existingUsername = opts.env.HELM_ADMIN_USER?.trim();
    const existingPassword = opts.env.HELM_ADMIN_PASSWORD;
    if (existingUsername && existingUsername !== parsed.data.username) {
      return c.json(
        {
          error: "external_env_wins",
          message: `The external environment fixes the username as ${existingUsername}.`,
        },
        409,
      );
    }
    if (!existingPassword && parsed.data.password.length < 12) {
      return c.json(
        { error: "invalid_request", message: "Use a password with at least 12 characters." },
        400,
      );
    }

    const suppliedKeys: Record<string, string> = {};
    for (const [providerId, apiKey] of Object.entries(parsed.data.providerKeys)) {
      if (!apiKey) continue;
      const provider = providerById.get(providerId);
      if (!provider) return c.json({ error: "unknown_provider" }, 400);
      if (provider.configured) {
        return c.json(
          { error: "external_env_wins", message: `${provider.label} is managed outside Helm.` },
          409,
        );
      }
      if (!tested.has(testMarker(providerId, apiKey))) {
        return c.json(
          { error: "provider_test_required", message: `Test ${provider.label} before finishing.` },
          409,
        );
      }
      suppliedKeys[provider.envName] = apiKey;
    }

    completing = true;
    const generatedOAuthKey = opts.env.HELM_OAUTH_ENC_KEY || randomBytes(32).toString("base64");
    const managed: Record<string, string> = {
      ...(opts.env.HELM_ADMIN_ENABLED ? {} : { HELM_ADMIN_ENABLED: "true" }),
      ...(existingUsername ? {} : { HELM_ADMIN_USER: parsed.data.username }),
      ...(existingPassword ? {} : { HELM_ADMIN_PASSWORD: parsed.data.password }),
      ...(opts.env.HELM_OAUTH_ENC_KEY ? {} : { HELM_OAUTH_ENC_KEY: generatedOAuthKey }),
      ...suppliedKeys,
    };
    const overlay: Record<string, string> = {
      HELM_ADMIN_ENABLED: "true",
      HELM_ADMIN_USER: existingUsername || parsed.data.username,
      HELM_ADMIN_PASSWORD: existingPassword || parsed.data.password,
      HELM_OAUTH_ENC_KEY: generatedOAuthKey,
      ...suppliedKeys,
    };
    const previous = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(overlay)) {
      previous.set(name, opts.env[name]);
      opts.env[name] = value;
    }

    const finalPath = managedEnvironmentPath(opts.dataDir);
    const tempPath = `${finalPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    let full: ServerHandle | null = null;
    try {
      await writeFile(tempPath, `${JSON.stringify(managed, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await chmod(tempPath, 0o600);
      full = await opts.buildFullServer();
      await rename(tempPath, finalPath);
      await unlink(setupTokenPath(opts.dataDir)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      const apiKey = await opts.readRootKey();
      opts.activate(full);
      return c.json({ ok: true, apiKey, adminPath: "/admin/providers" }, 200);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      await full?.dispose?.();
      for (const [name, value] of previous) {
        if (value === undefined) delete opts.env[name];
        else opts.env[name] = value;
      }
      completing = false;
      const message = redact(error instanceof Error ? error.message : String(error), [
        parsed.data.password,
        generatedOAuthKey,
        ...Object.values(suppliedKeys),
      ]);
      opts.log(`Setup failed: ${message}`);
      return c.json({ error: "startup_failed", message }, 500);
    }
  });

  return {
    token,
    handle: { app, host: opts.host, port: opts.port },
  };
}
