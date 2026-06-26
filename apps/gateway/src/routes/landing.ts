import type { Hono } from "hono";
import type { AppEnv } from "../app.js";

// Public landing page at GET / — replaces the bare 404 a visitor used to hit. A
// self-contained status page (no framework, no build step, no auth, zero external
// assets): inline CSS + a tiny script that polls /healthz and /version so the page
// reflects the LIVE gateway state. Principle 1 (the gateway is headless-capable):
// this is presentation-only glue, never imports core routing.
//
// Design goal: visually CONTINUOUS with the admin UI (apps/admin/src/app.css) —
// same light slate canvas, white cards on slate-200 borders, the indigo brand
// square, emerald/amber status badges, two-tier radius. The values below are the
// admin's Tailwind tokens inlined (slate/indigo/emerald/amber), so a visitor
// clicking through to /admin sees one product, not two designs.

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Helm API</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%234f46e5'/%3E%3Cg fill='%23fff'%3E%3Crect x='15' y='16' width='7' height='32' rx='3.5'/%3E%3Crect x='42' y='16' width='7' height='32' rx='3.5'/%3E%3C/g%3E%3Cg fill='none' stroke='%23fff' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M22 32H38'/%3E%3Cpath d='M34 27l6 5-6 5'/%3E%3C/g%3E%3C/svg%3E" />
<style>
  /* Admin design tokens (apps/admin/src/app.css), inlined. */
  :root {
    --canvas: #f8fafc;        /* slate-50  — app shell */
    --surface: #ffffff;       /* white     — cards */
    --border: #e2e8f0;        /* slate-200 — container outline */
    --border-hair: #f1f5f9;   /* slate-100 — row divider */
    --ink: #0f172a;           /* slate-900 — titles */
    --ink-strong: #334155;    /* slate-700 — labels */
    --ink-body: #475569;      /* slate-600 — body */
    --ink-muted: #64748b;     /* slate-500 — descriptions */
    --ink-faint: #94a3b8;     /* slate-400 — muted glyphs */
    --brand: #4f46e5;         /* indigo-600 — logo + accents ONLY */
    --ok-bg: #d1fae5; --ok-fg: #047857;     /* emerald-100 / emerald-700 */
    --warn-bg: #fef3c7; --warn-fg: #92400e; /* amber-100 / amber-800 */
    --neutral-bg: #e2e8f0; --neutral-fg: #475569; /* slate badge */
    --radius-control: 0.25rem; --radius-container: 0.5rem;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--canvas); color: var(--ink-body);
    font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
    display: flex; justify-content: center; padding: 10vh 24px 8vh;
  }
  .mono { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; }
  main { width: 100%; max-width: 560px; }

  /* Brand mark — identical recipe to the admin sidebar header. */
  .mark { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; }
  .mark .tile {
    display: flex; align-items: center; justify-content: center; flex: none;
    width: 32px; height: 32px; border-radius: var(--radius-container);
    background: var(--brand); color: #fff;
  }
  .mark .tile svg { width: 18px; height: 18px; display: block; }
  .mark .name { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; color: var(--ink); line-height: 1.3; }
  .mark .sub { font-size: 12px; color: var(--ink-faint); line-height: 1.3; }

  h1 { font-size: 28px; line-height: 1.25; font-weight: 600; letter-spacing: -0.025em; color: var(--ink); margin: 0 0 12px; }
  .lede { color: var(--ink-muted); font-size: 15px; margin: 0 0 22px; max-width: 480px; }

  /* Status badge — admin .badge-ok / .badge-fallback / .badge-neutral. */
  .status { display: inline-flex; align-items: center; margin-bottom: 36px; }
  .badge {
    display: inline-flex; align-items: center; gap: 7px;
    border-radius: var(--radius-control); padding: 3px 9px;
    font-size: 12px; font-weight: 500;
    background: var(--neutral-bg); color: var(--neutral-fg);
  }
  .badge.ok { background: var(--ok-bg); color: var(--ok-fg); }
  .badge.bad { background: var(--warn-bg); color: var(--warn-fg); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
  .status .ver { margin-left: 10px; font-size: 12px; color: var(--ink-faint); }

  /* Link list — an admin card: white, slate-200 border, hairline-divided rows. */
  nav { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-container); overflow: hidden; }
  nav a {
    display: flex; align-items: baseline; gap: 14px; padding: 14px 16px;
    text-decoration: none; color: inherit; transition: background .15s ease;
  }
  nav a + a { border-top: 1px solid var(--border-hair); }
  nav a:hover { background: var(--canvas); }
  nav .label { font-weight: 500; font-size: 14px; color: var(--ink); }
  nav .desc { color: var(--ink-muted); font-size: 13px; flex: 1; }
  nav .path { color: var(--ink-faint); font-size: 12px; transition: color .15s; }
  nav a:hover .path { color: var(--brand); }

  footer { margin-top: 28px; color: var(--ink-faint); font-size: 12px; }
  footer .mono { color: var(--ink-muted); }

  @media (max-width: 480px) {
    body { padding: 7vh 20px; }
    h1 { font-size: 23px; }
    nav a { flex-direction: column; gap: 3px; }
    nav .desc { flex: none; }
  }
</style>
</head>
<body>
  <main>
    <div class="mark">
      <span class="tile"><svg viewBox="0 0 64 64" aria-hidden="true"><g fill="currentColor"><rect x="15" y="16" width="7" height="32" rx="3.5"/><rect x="42" y="16" width="7" height="32" rx="3.5"/></g><g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 32H38"/><path d="M34 27l6 5-6 5"/></g></svg></span>
      <span>
        <span class="name">Helm&nbsp;API</span>
        <br /><span class="sub">LLM Gateway</span>
      </span>
    </div>

    <h1>One gateway in front of<br />all your LLM providers.</h1>
    <p class="lede">Open-source, self-hosted routing for OpenAI, Anthropic, and Gemini traffic — pick models by config, not code.</p>

    <div class="status">
      <span id="badge" class="badge"><span class="dot"></span><span id="status-text">Checking status…</span></span>
      <span class="ver mono" id="version" hidden></span>
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
      const badge = document.getElementById('badge');
      const text = document.getElementById('status-text');
      try {
        const r = await fetch('/healthz', { headers: { accept: 'application/json' } });
        const j = await r.json();
        if (r.ok && j.ready) { badge.className = 'badge ok'; text.textContent = 'All systems operational'; }
        else { badge.className = 'badge bad'; text.textContent = 'Degraded'; }
      } catch { badge.className = 'badge bad'; text.textContent = 'Unreachable'; }
      try {
        const v = await (await fetch('/version', { headers: { accept: 'application/json' } })).json();
        const ver = v.version && v.version !== 'unknown' ? 'v' + v.version : (v.gitSha && v.gitSha !== 'unknown' ? v.gitSha.slice(0, 7) : '');
        if (ver) { const el = document.getElementById('version'); el.textContent = ver; el.hidden = false; }
      } catch { /* version is best-effort */ }
    })();
  </script>
</body>
</html>`;

export function registerLandingRoute(app: Hono<AppEnv>): void {
  app.get("/", (c) => c.html(PAGE));
}
