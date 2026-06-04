import type { Hono } from "hono";
import type { AppEnv } from "../app.js";

// Public landing page at GET / — replaces the bare 404 a visitor used to hit. A
// self-contained status page (no framework, no build step, no auth, zero external
// assets): inline CSS + a tiny script that polls /healthz and /version so the page
// reflects the LIVE gateway state. Principle 1 (the gateway is headless-capable):
// this is presentation-only glue, never imports core routing.
//
// Design goal: calm, minimal, trustworthy — a status-page aesthetic (generous
// whitespace, hairline-divided rows, one restrained accent), not a busy template.
// It is intentionally ONE string constant so it costs nothing to serve and can
// never drift from a separate file.

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Helm API</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230b0c0e'/%3E%3Cpath d='M11 9v14M21 9v14M11 16h10' stroke='%23e6e8eb' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E" />
<style>
  :root {
    --bg: #0a0b0d; --fg: #e9ebee; --muted: #8b929b; --faint: #5a616b;
    --line: #1b1e23; --line-strong: #262a31; --accent: #5b87f5; --ok: #2ea043; --warn: #d29922;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
    display: flex; justify-content: center; padding: 12vh 24px 8vh;
  }
  .mono { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; }
  main { width: 100%; max-width: 540px; }

  .mark { display: flex; align-items: center; gap: 11px; margin-bottom: 26px; }
  .mark svg { width: 26px; height: 26px; display: block; }
  .mark .name { font-size: 16px; font-weight: 600; letter-spacing: 0.02em; }

  h1 { font-size: 30px; line-height: 1.25; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 14px; }
  .lede { color: var(--muted); font-size: 16px; margin: 0 0 26px; max-width: 460px; }

  .status {
    display: inline-flex; align-items: center; gap: 9px; margin-bottom: 44px;
    font-size: 13px; color: var(--muted);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; transition: background .2s; }
  .dot.ok { background: var(--ok); box-shadow: 0 0 0 4px rgba(46,160,67,.15); }
  .dot.bad { background: var(--warn); box-shadow: 0 0 0 4px rgba(210,153,34,.15); }
  .status .sep { color: var(--line-strong); }

  nav { border-top: 1px solid var(--line); }
  nav a {
    display: flex; align-items: baseline; gap: 16px; padding: 17px 4px;
    border-bottom: 1px solid var(--line); text-decoration: none; color: inherit;
    transition: padding-left .18s ease, border-color .18s ease;
  }
  nav a:hover { padding-left: 10px; border-color: var(--line-strong); }
  nav .label { font-weight: 540; font-size: 15px; }
  nav .desc { color: var(--muted); font-size: 13.5px; flex: 1; }
  nav .path { color: var(--faint); font-size: 12.5px; transition: color .18s; }
  nav a:hover .path { color: var(--accent); }

  footer { margin-top: 40px; color: var(--faint); font-size: 12.5px; }
  footer .mono { color: var(--muted); }

  @media (max-width: 480px) {
    body { padding: 8vh 20px; }
    h1 { font-size: 25px; }
    nav a { flex-direction: column; gap: 4px; }
    nav .desc { flex: none; }
  }
</style>
</head>
<body>
  <main>
    <div class="mark">
      <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M11 9v14M21 9v14M11 16h10" stroke="#e6e8eb" stroke-width="2.4" stroke-linecap="round"/></svg>
      <span class="name">Helm&nbsp;API</span>
    </div>

    <h1>One gateway in front of<br />all your LLM providers.</h1>
    <p class="lede">Open-source, self-hosted routing for OpenAI, Anthropic, and Gemini traffic — pick models by config, not code.</p>

    <div class="status">
      <span id="dot" class="dot"></span>
      <span id="status-text">Checking status…</span>
      <span class="sep" id="ver-sep" hidden>·</span>
      <span class="mono" id="version" hidden></span>
    </div>

    <nav>
      <a href="/docs">
        <span class="label">Documentation</span>
        <span class="desc">Interactive API reference &amp; playground</span>
        <span class="path mono">/docs</span>
      </a>
      <a href="/v1/models">
        <span class="label">Models</span>
        <span class="desc">Models your key can route to</span>
        <span class="path mono">/v1/models</span>
      </a>
      <a href="/admin">
        <span class="label">Dashboard</span>
        <span class="desc">Lanes, keys &amp; request telemetry</span>
        <span class="path mono">/admin</span>
      </a>
      <a href="/healthz">
        <span class="label">Health</span>
        <span class="desc">Readiness &amp; build info</span>
        <span class="path mono">/healthz</span>
      </a>
    </nav>

    <footer>OpenAI · Anthropic · Gemini compatible &nbsp;·&nbsp; <span class="mono">/v1/chat/completions</span></footer>
  </main>

  <script>
    (async () => {
      const dot = document.getElementById('dot');
      const text = document.getElementById('status-text');
      try {
        const r = await fetch('/healthz', { headers: { accept: 'application/json' } });
        const j = await r.json();
        if (r.ok && j.ready) { dot.className = 'dot ok'; text.textContent = 'All systems operational'; }
        else { dot.className = 'dot bad'; text.textContent = 'Degraded'; }
      } catch { dot.className = 'dot bad'; text.textContent = 'Unreachable'; }
      try {
        const v = await (await fetch('/version', { headers: { accept: 'application/json' } })).json();
        const ver = v.version && v.version !== 'unknown' ? 'v' + v.version : (v.gitSha && v.gitSha !== 'unknown' ? v.gitSha.slice(0, 7) : '');
        if (ver) {
          const el = document.getElementById('version'); el.textContent = ver;
          el.hidden = false; document.getElementById('ver-sep').hidden = false;
        }
      } catch { /* version is best-effort */ }
    })();
  </script>
</body>
</html>`;

export function registerLandingRoute(app: Hono<AppEnv>): void {
  app.get("/", (c) => c.html(PAGE));
}
