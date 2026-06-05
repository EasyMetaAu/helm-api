#!/usr/bin/env node
// Live integration suite — runs against a RUNNING Helm gateway (Docker or local)
// with real provider keys configured. Exercises every spec'd surface end-to-end
// and prints a coverage matrix. NOT a unit test (those are Vitest) — this hits the
// real server + real upstreams.
//
//   BASE=localhost:8080 KEY=helm_live_... AUSER=admin APASS=... node scripts/integration-live.mjs
//
// Env: BASE (default localhost:8080), KEY (an API key), AUSER/APASS (admin basic auth).

const BASE = `http://${process.env.BASE ?? 'localhost:8080'}`;
const KEY = process.env.KEY ?? '';
const AUSER = process.env.AUSER ?? 'admin';
const APASS = process.env.APASS ?? '';
const adminAuth = 'Basic ' + Buffer.from(`${AUSER}:${APASS}`).toString('base64');

const results = [];
let curCat = '';
const cat = (c) => (curCat = c);
function check(name, ok, info = '') {
  results.push({ cat: curCat, name, ok: ok === true, skip: ok === 'skip', info });
  const tag = ok === 'skip' ? '○ SKIP' : ok ? '✓ PASS' : '✗ FAIL';
  console.log(`  ${tag}  ${name}${info ? '  — ' + info : ''}`);
}

async function http(method, path, { auth = false, admin = false, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
  if (auth) h['authorization'] = `Bearer ${KEY}`;
  if (admin) h['authorization'] = adminAuth;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  if (!raw) try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

const userMsg = (content) => ({ model: 'auto', messages: [{ role: 'user', content }], max_tokens: 24 });

async function main() {
  console.log(`\n=== Helm live integration suite → ${BASE} ===`);

  // ── Health / version (docs/10) ──────────────────────────────────────────────
  cat('Health & version');
  {
    const h = await http('GET', '/healthz');
    check('/healthz → 200 ok+ready', h.status === 200 && h.json?.status === 'ok' && h.json?.ready === true);
    const v = await http('GET', '/version');
    check('/version → 200', v.status === 200, JSON.stringify(v.json));
  }

  // ── Auth (docs/06) ──────────────────────────────────────────────────────────
  cat('API auth');
  {
    const noKey = await http('POST', '/v1/chat/completions', { body: userMsg('hi') });
    check('no key → 401', noKey.status === 401);
    const badKey = await http('POST', '/v1/chat/completions', { headers: { authorization: 'Bearer helm_live_bogus' }, body: userMsg('hi') });
    check('invalid key → 401', badKey.status === 401);
  }

  // ── OpenAI Chat Completions (docs/01,05) ────────────────────────────────────
  cat('OpenAI Chat Completions');
  let chatTrace = null;
  {
    const r = await http('POST', '/v1/chat/completions', { auth: true, body: userMsg('Reply with one word: pong') });
    chatTrace = r.headers.get('x-trace-id');
    const okShape = r.json?.object === 'chat.completion' && Array.isArray(r.json?.choices) && r.json.choices[0]?.message?.role === 'assistant';
    check('non-stream → 200 + chat.completion shape', r.status === 200 && okShape, `model=${r.json?.model}`);
    check('routing debug headers present (x-helm-lane / x-helm-decided-by)', !!r.headers.get('x-helm-lane') && !!r.headers.get('x-helm-decided-by'),
      `lane=${r.headers.get('x-helm-lane')} decided_by=${r.headers.get('x-helm-decided-by')}`);
    check('final upstream model present (x-helm-final-model)', !!r.headers.get('x-helm-final-model'), r.headers.get('x-helm-final-model') || '');
  }
  {
    const r = await http('POST', '/v1/chat/completions', { auth: true, raw: true, body: { ...userMsg('count 1 to 3'), stream: true } });
    const lines = r.text.split('\n').filter((l) => l.startsWith('data:'));
    const hasDone = r.text.includes('[DONE]');
    let chunkOk = false;
    for (const l of lines) {
      const d = l.slice(5).trim();
      if (d === '[DONE]') continue;
      try { const o = JSON.parse(d); if (o.object === 'chat.completion.chunk' || o.choices) { chunkOk = true; break; } } catch {}
    }
    check('streaming → SSE data chunks', r.status === 200 && lines.length > 0 && chunkOk, `${lines.length} data lines`);
    check('streaming → terminates with [DONE]', hasDone);
  }
  {
    const tools = [{ type: 'function', function: { name: 'get_weather', description: 'get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
    const r = await http('POST', '/v1/chat/completions', { auth: true, body: { model: 'auto', max_tokens: 40, tools, messages: [{ role: 'user', content: 'What is the weather in Tokyo? Use the tool.' }] } });
    check('tool-calling request → 200 (real upstream)', r.status === 200, `finish=${r.json?.choices?.[0]?.finish_reason}`);
  }

  // ── Anthropic Messages translation (docs/05) ────────────────────────────────
  cat('Anthropic /v1/messages translation');
  {
    const r = await http('POST', '/v1/messages', { auth: true, body: { model: 'auto', max_tokens: 24, messages: [{ role: 'user', content: 'Say hello' }] } });
    const okShape = r.json?.type === 'message' && r.json?.role === 'assistant' && Array.isArray(r.json?.content) && 'stop_reason' in (r.json ?? {});
    check('non-stream → 200 + Anthropic message shape', r.status === 200 && okShape, `stop_reason=${r.json?.stop_reason}`);
  }
  {
    // max_tokens generous: auto may pick a reasoning model that spends a small
    // budget entirely on `reasoning` (no `content`) and finish_reason=length — a
    // real upstream behavior, not a translation bug. Give it room to emit text.
    const r = await http('POST', '/v1/messages', { auth: true, raw: true, body: { model: 'auto', max_tokens: 400, stream: true, messages: [{ role: 'user', content: 'Reply with exactly: one two three' }] } });
    const ev = (name) => r.text.includes(`event: ${name}`) || r.text.includes(`"type":"${name}"`) || r.text.includes(`"type": "${name}"`);
    check('streaming → Anthropic SSE (message_start)', r.status === 200 && ev('message_start'));
    check('streaming → content_block_start + text_delta present', ev('content_block_start') && ev('text_delta'));
    check('streaming → message_stop present', ev('message_stop'));
  }

  // ── OpenAI Responses API (docs/05) ──────────────────────────────────────────
  cat('OpenAI Responses API');
  {
    const r = await http('POST', '/v1/responses', { auth: true, body: { model: 'auto', max_output_tokens: 200, input: 'Say hello' } });
    if (r.status === 404) check('/v1/responses route mounted', false, 'route not mounted');
    else check('/v1/responses non-stream → 200 + Responses shape', r.status === 200 && r.json?.object === 'response' && Array.isArray(r.json?.output), `status=${r.status} object=${r.json?.object}`);
    // Streaming Responses is now natively supported (#40): stream:true → 200 + an SSE
    // stream of Responses events terminated by [DONE]. (It used to 400 as unsupported;
    // that assertion rotted when the SSE transformer landed — updated here.)
    const s = await http('POST', '/v1/responses', { auth: true, raw: true, body: { model: 'auto', max_output_tokens: 200, input: 'Reply with exactly: one two three', stream: true } });
    const ev = (name) => s.text.includes(`"type":"${name}"`) || s.text.includes(`"type": "${name}"`) || s.text.includes(`event: ${name}`);
    check('/v1/responses stream:true → 200 + Responses SSE (created/delta)', s.status === 200 && (ev('response.created') || ev('response.output_text.delta')), `status=${s.status}`);
    // The Responses API stream terminates with a `response.completed` event — NOT the
    // Chat-Completions `[DONE]` sentinel. (Asserting [DONE] here would be wrong.)
    check('/v1/responses stream → terminates with response.completed', ev('response.completed'));
  }

  // ── Routing & classification (docs/03,04) ───────────────────────────────────
  cat('Routing & classification');
  {
    const r = await http('POST', '/v1/chat/completions', { auth: true, body: userMsg('hello there') });
    const lane = r.headers.get('x-helm-lane');
    check('model=auto routes (not passthrough): lane is a real lane', ['economy', 'balanced', 'premium', 'coding', 'json', 'vision', 'tool_use'].includes(lane), `lane=${lane}`);
  }

  // ── Error handling (docs/07) ────────────────────────────────────────────────
  cat('Error handling');
  {
    const r = await http('POST', '/v1/chat/completions', { auth: true, body: '{not valid json', headers: { 'content-type': 'application/json' } });
    check('malformed JSON body → 400 invalid_request (not 502)', r.status === 400 && r.json?.error?.code === 'invalid_request', `status=${r.status} code=${r.json?.error?.code}`);
  }
  {
    const r = await http('POST', '/v1/chat/completions', { auth: true, body: { model: 'auto', messages: [] } });
    check('empty messages → 400 invalid_request (no fallback-chain burn)', r.status === 400 && r.json?.error?.code === 'invalid_request', `status=${r.status} code=${r.json?.error?.code}`);
  }
  {
    const r = await http('POST', '/v1/messages', { auth: true, body: '{not valid json', headers: { 'content-type': 'application/json' } });
    check('/v1/messages malformed JSON → 400 (Anthropic envelope, not 502)', r.status === 400, `status=${r.status}`);
  }
  {
    // Gateway contract for a json_object request: route to a json-capable candidate and EITHER
    // return a well-formed chat.completion envelope (200), OR a structured error (502/422) when no
    // candidate can satisfy the constraint. NOTE: whether the upstream content itself is valid JSON
    // is the model's job, not the gateway's — and a tiny max_tokens truncates it (finish=length),
    // so we assert the envelope/contract, not the model's JSON compliance. (max_tokens raised so the
    // happy path isn't masked by truncation when an upstream does emit JSON.)
    const r = await http('POST', '/v1/chat/completions', { auth: true, body: { model: 'auto', max_tokens: 64, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'Return JSON with ok=true' }] } });
    const okEnvelope = r.status === 200 && r.json?.object === 'chat.completion' && r.json?.choices?.[0]?.message?.role === 'assistant';
    const structuredErr = [502, 422].includes(r.status) && !!(r.json?.error?.code || r.json?.error_class || r.json?.error?.type);
    check('JSON-constraint request → 200 chat.completion envelope or structured error (502/422)', okEnvelope || structuredErr,
      `status=${r.status} ${r.status === 200 ? 'model=' + r.json?.model : 'code=' + (r.json?.error?.code ?? r.json?.error_class)}`);
    check('JSON-constraint response well-formed (valid envelope, or structured error body)', okEnvelope || structuredErr);
  }
  {
    const noKey = await http('POST', '/v1/chat/completions', { body: userMsg('hi') });
    // Known: auth errors return bare HelmError shape; routing errors return OpenAI shape
    const shape = noKey.json?.error ? 'openai' : noKey.json?.error_class ? 'bare-helm' : 'unknown';
    check('401 error body is structured', !!(noKey.json?.error || noKey.json?.error_class), `shape=${shape}`);
  }

  // ── Telemetry / logging / redaction (docs/02,07) ────────────────────────────
  cat('Telemetry, logging & redaction');
  {
    const list = await http('GET', '/admin/api/requests', { admin: true });
    // /admin/api/requests is paginated → { items, total, page, pageSize }. Tolerate
    // both that and a bare array (older builds) so the lookup survives either shape.
    const rows = Array.isArray(list.json) ? list.json : (list.json?.items ?? []);
    const row = rows.find((r) => r.trace_id === chatTrace || r.request_id === chatTrace) ?? null;
    check('chat request was persisted to telemetry', !!row, `trace=${chatTrace}`);
    if (row) {
      check('decision record has classifier+lane+attempts+final', !!(row.classifier && row.lane && Array.isArray(row.provider_attempts) && row.final));
      check('candidate_chain expanded (primary+fallback, not just lane name)', Array.isArray(row.lane?.candidate_chain) && row.lane.candidate_chain.length > 1, JSON.stringify(row.lane?.candidate_chain));
      check('decided_by recorded (原则5: classification stage visible)', typeof row.classifier?.decided_by === 'string', `decided_by=${row.classifier?.decided_by}`);
    }
    const prefixOnly = typeof row?.key_prefix === 'string' && row.key_prefix.length <= 16 && !list.text.includes(KEY);
    check('redaction: only key prefix stored, full plaintext key NEVER in telemetry (原则7)', prefixOnly, `key_prefix=${row?.key_prefix}`);
  }

  // ── Memory middleware (docs/08 observe/inject + docs/12 forgetting) ─────────
  // Black-boxes the memory contract a LIVE deployment must honor end-to-end:
  // observe persists + routes normally; inject hydrates a memory prefix and
  // enqueues the observer write-back; the background worker compresses history so
  // a LATER inject carries an observation; the decision record carries ONLY the
  // redacted memory meta (counts/ids, never content — 原则7); memory is fail-open
  // and default-safe throughout. Works with memory.forgetting enabled OR disabled
  // (the forgetting layer is config-gated; its internals are unit/e2e-covered —
  // here we assert the API-observable contract). NOTE: DecisionRecord.memory is
  // stamped for INJECT requests only (observe rows carry memory:null by design).
  cat('Memory middleware');
  {
    const stamp = Date.now();
    const th = `live-mem-${stamp}`;
    const proj = `live-mem-proj-${stamp}`;
    const memH = { 'x-thread-id': th, 'x-project-id': proj };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const findByTrace = async (trace) => {
      const list = await http('GET', '/admin/api/requests', { admin: true });
      const rows = Array.isArray(list.json) ? list.json : (list.json?.items ?? []);
      return rows.find((r) => r.trace_id === trace || r.request_id === trace) ?? null;
    };

    // 1) observe turns: persist raw history + route normally (write-only middleware).
    let observeOk = true;
    for (let i = 1; i <= 3; i++) {
      const r = await http('POST', '/v1/chat/completions', {
        auth: true,
        headers: { ...memH, 'x-memory-mode': 'observe' },
        body: userMsg(`Live memory check ${i}: the project codename is HELM-MEM. Reply ok.`),
      });
      if (r.status !== 200) observeOk = false;
    }
    check('observe mode: turns route normally (200) with memory headers', observeOk);

    // 2) inject: hydrates immediately (recent raw) + enqueues the observer
    //    write-back; the decision record carries the redacted memory meta.
    const injectOnce = async (content) => {
      const r = await http('POST', '/v1/chat/completions', {
        auth: true,
        headers: { ...memH, 'x-memory-mode': 'inject' },
        body: userMsg(content),
      });
      return { status: r.status, row: await findByTrace(r.headers.get('x-trace-id')) };
    };
    const first = await injectOnce('What is the project codename? One word.');
    const m1 = first.row?.memory;
    check('inject mode: 200 + memory_hydrated=true (prefix assembled)',
      first.status === 200 && m1?.memory_hydrated === true,
      m1 ? `tokens=${m1.memory_tokens_injected}` : `status=${first.status} memory=${JSON.stringify(m1 ?? null)}`);
    check('inject: decision record carries redacted memory meta (thread_source=header, 原则7)',
      m1?.thread_source === 'header' && typeof m1?.memory_tokens_injected === 'number',
      JSON.stringify(m1 ?? null));
    check('inject: observer write-back enqueued (job id recorded, off the request path)',
      m1?.memory_writeback_status === 'queued' && !!m1?.observer_job_id,
      `writeback=${m1?.memory_writeback_status} job=${m1?.observer_job_id ?? 'null'}`);

    // 3) the background worker drains: a LATER inject carries a COMPRESSED
    //    observation (observation_count ≥ 1). Worker cadence is deployment config
    //    (HELM_MEMORY_WORKER_INTERVAL_MS, default 60s) → poll with backoff and SKIP
    //    (not fail) when this deployment's worker is slower than the test window.
    let drained = null;
    for (const waitMs of [2500, 5000, 8000]) {
      await sleep(waitMs);
      const probe = await injectOnce('Remind me of the codename again, one word.');
      if (probe.status === 200 && (probe.row?.memory?.observation_count ?? 0) >= 1) { drained = probe; break; }
    }
    check('background worker drained: a later inject carries a compressed observation',
      drained !== null ? true : 'skip',
      drained
        ? `observation_count=${drained.row.memory.observation_count} reflection_v=${drained.row.memory.reflection_version} tokens=${drained.row.memory.memory_tokens_injected}`
        : 'worker did not drain within ~15s (set HELM_MEMORY_WORKER_INTERVAL_MS lower for live testing)');

    // 4) fail-open: inject with NO thread anchor degrades to minimal context, 200.
    const noThread = await http('POST', '/v1/chat/completions', { auth: true, headers: { 'x-memory-mode': 'inject' }, body: userMsg('hi') });
    check('fail-open: inject with NO thread anchor still 200', noThread.status === 200, `status=${noThread.status}`);

    // 5) default-safe: an ILLEGAL x-memory-mode normalizes to off (200; never
    //    silently falls back to inject — issue #97 priority semantics).
    const illegal = await http('POST', '/v1/chat/completions', {
      auth: true,
      headers: { ...memH, 'x-memory-mode': 'definitely-not-a-mode' },
      body: userMsg('hi'),
    });
    const ilRow = await findByTrace(illegal.headers.get('x-trace-id'));
    check('default-safe: illegal x-memory-mode normalizes to off (200, memory meta null)',
      illegal.status === 200 && (ilRow ? ilRow.memory == null : true),
      `status=${illegal.status} memory=${JSON.stringify(ilRow?.memory ?? null)}`);

    // 6) redaction (原则7): the requests LIST must never leak memory CONTENT — the
    //    sentinel injected above must not appear anywhere in the admin list payload.
    const listAll = await http('GET', '/admin/api/requests', { admin: true });
    check('redaction: memory content (sentinel) never appears in the requests list (原则7)',
      !listAll.text.includes('HELM-MEM'));
  }

  // ── Admin API + auth (docs/11) ──────────────────────────────────────────────
  cat('Admin API & auth');
  {
    check('/admin/api/requests no auth → 401', (await http('GET', '/admin/api/requests')).status === 401);
    check('/admin/api/keys no auth → 401', (await http('GET', '/admin/api/keys')).status === 401);
    check('/admin SPA no auth → 401', (await http('GET', '/admin')).status === 401);
    check('/admin SPA with auth → 200', (await http('GET', '/admin', { admin: true })).status === 200);
    for (const ep of ['requests', 'keys', 'lanes', 'policies', 'classifier']) {
      const r = await http('GET', `/admin/api/${ep}`, { admin: true });
      check(`GET /admin/api/${ep} → 200`, r.status === 200, `status=${r.status}`);
    }
  }
  {
    // key lifecycle: create → appears → revoke
    const create = await http('POST', '/admin/api/keys', { admin: true, body: { role: 'user' } });
    const plaintext = create.json?.key ?? create.json?.plaintext ?? create.json?.api_key;
    const keyId = create.json?.key_id ?? create.json?.id;
    check('admin create key → returns plaintext once', (create.status === 200 || create.status === 201) && typeof plaintext === 'string' && plaintext.startsWith('helm_live_'), `status=${create.status}`);
    if (keyId) {
      const del = await http('DELETE', `/admin/api/keys/${keyId}`, { admin: true });
      check('admin revoke key → 2xx', del.status >= 200 && del.status < 300, `status=${del.status}`);
    } else check('admin revoke key', 'skip', 'no key_id returned');
  }

  // ── Subscriptions (OAuth) end-to-end (docs/06,09 + issue #38) ────────────────
  // Proves the OAuth subscription chain is actually STRUNG THROUGH, not just listed:
  // connected providers → live model catalog → a real request that reaches each
  // upstream. A connected provider passes iff ≥1 of its catalogued models serves a
  // 200 from THAT provider; stale/invalid curated ids (upstream 4xx) are surfaced
  // in the info string so a drifted list reads as a data problem, not a dead chain.
  cat('Subscriptions (OAuth)');
  {
    const oauth = await http('GET', '/admin/api/oauth', { admin: true });
    const providers = Array.isArray(oauth.json?.providers) ? oauth.json.providers : [];
    check('GET /admin/api/oauth → 200 + providers[]', oauth.status === 200 && providers.length > 0,
      `providers=${providers.map((p) => p.id).join(',')}`);
    // Defense-in-depth (原则7): the status surface must never echo token material.
    check('OAuth status carries NO access/refresh token material (原则7)',
      !oauth.text.includes('refresh_token') && !/"access[_A-Za-z]*"\s*:\s*"[A-Za-z0-9._-]{20}/.test(oauth.text));

    const catRes = await http('GET', '/admin/api/models', { admin: true });
    const catalog = Array.isArray(catRes.json) ? catRes.json : [];
    const oauthAliases = catalog.filter((m) => Array.isArray(m.accounts) && m.accounts.length > 0);
    check('GET /admin/api/models is live + includes OAuth-backed aliases (alias+accounts)',
      oauthAliases.length > 0, `${oauthAliases.length} OAuth of ${catalog.length} total`);

    // ── Known-good model PER PROVIDER — verified live 2026-06-03 ────────────────
    // Each subscription is tested with its OWN model id; they DO NOT share one. This
    // is hard-won knowledge — pinned here so we don't relearn it every time:
    //   • openai-codex (ChatGPT Codex backend): serves gpt-5.4 / gpt-5.4-mini / gpt-5.5.
    //     The legacy *-codex / *-pro / *-nano slugs 400 "model is not supported when
    //     using Codex with a ChatGPT account" — it is a MODEL-id problem, not auth.
    //   • github-copilot: serves gpt-4o / gpt-4.1 / gpt-4o-mini / gpt-5-mini (+ some
    //     claude). Copilot's /models ADVERTISES gpt-5.4 / gpt-5.4-mini / gpt-5.5 and
    //     claude-opus/sonnet + gemini, but its chat endpoint REJECTS them
    //     (model_not_supported). So NEVER reuse Codex's gpt-5.4* ids for Copilot.
    //   • anthropic: any live-listed claude model (haiku is the cheapest).
    // The check below routes each provider's own model explicitly and asserts it serves.
    const KNOWN_GOOD = {
      anthropic: 'claude-haiku-4-5-20251001',
      'openai-codex': 'gpt-5.4-mini',
      'github-copilot': 'gpt-5-mini',
    };

    // A passthrough key so an explicit `provider/model` alias routes DIRECTLY to that
    // subscription (explicit-model passthrough is gated by allow_custom_model, docs/04).
    const mk = await http('POST', '/admin/api/keys', { admin: true, body: { role: 'user', allow_custom_model: true } });
    const passKey = mk.json?.plaintext ?? mk.json?.key ?? mk.json?.api_key;
    const passProbe = async (alias) => {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${passKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: alias, messages: [{ role: 'user', content: 'Reply with exactly: pong' }], max_tokens: 16 }),
      });
      let j = null; try { j = await res.json(); } catch {}
      const upstream = j?.error?.message || j?.message ||
        (j?.provider_raw ? JSON.stringify(j.provider_raw) : '');
      return {
        status: res.status,
        finalModel: res.headers.get('x-helm-final-model'),
        content: j?.choices?.[0]?.message?.content ?? null,
        upstream: typeof upstream === 'string' ? upstream : JSON.stringify(upstream),
      };
    };

    check('admin minted an allow_custom_model passthrough key', typeof passKey === 'string' && passKey.startsWith('helm_live_'));
    if (typeof passKey === 'string' && passKey.startsWith('helm_live_')) {
      for (const p of providers) {
        const healthy = (p.accounts ?? []).some((a) => a.healthy);
        const aliases = oauthAliases.filter((m) => m.alias.startsWith(`${p.id}/`)).map((m) => m.alias);
        if (!healthy || aliases.length === 0) {
          check(`route → ${p.id} subscription reaches upstream`, 'skip', healthy ? 'no catalogued models' : 'no healthy account');
          continue;
        }
        let served = null;
        const tried = [];
        for (const alias of aliases.slice(0, 5)) {
          const r = await passProbe(alias);
          if (r.status === 200 && r.content != null && (r.finalModel ?? '').startsWith(`${p.id}/`)) {
            served = { alias, ...r };
            break;
          }
          tried.push(`${alias.split('/').slice(1).join('/')}→${r.status}${r.upstream ? ` (${r.upstream.slice(0, 48)})` : ''}`);
        }
        check(`route → ${p.id} subscription reaches upstream (≥1 model serves 200)`, served !== null,
          served ? `${served.alias} → ${JSON.stringify(served.content)}` : `0/${Math.min(aliases.length, 5)} served: ${tried.join(' | ')}`);

        // Explicit, documented per-provider model (the KNOWN_GOOD map) — pinned as its
        // own check so the "each provider uses its OWN model" knowledge can't silently
        // rot. Skips if that model isn't currently curated for this provider.
        const good = KNOWN_GOOD[p.id];
        if (good && aliases.includes(`${p.id}/${good}`)) {
          const r = await passProbe(`${p.id}/${good}`);
          check(`route → ${p.id}/${good} (its own model, distinct per provider) serves 200`,
            r.status === 200 && r.content != null && (r.finalModel ?? '').startsWith(`${p.id}/`),
            r.content != null ? `→ ${JSON.stringify(r.content)}` : `status=${r.status} ${r.upstream.slice(0, 60)}`);
        } else if (good) {
          check(`route → ${p.id}/${good} (its own model) serves 200`, 'skip', `${good} not currently curated for ${p.id}`);
        }
      }
    }
    // Clean up the throwaway passthrough key.
    const passId = mk.json?.key_id ?? mk.json?.id;
    if (passId) await http('DELETE', `/admin/api/keys/${passId}`, { admin: true });
  }

  // ── Classifier hot-apply (docs/03 + consolidation) ──────────────────────────
  cat('Classifier hot-apply (admin)');
  {
    // Full-config REPLACE (the admin UI flow: GET, mutate, PUT the whole object).
    const before = await http('GET', '/admin/api/classifier', { admin: true });
    const cfg = before.json;
    const curEnabled = cfg.eval.enabled;
    const origThreshold = cfg.rules.confidence_threshold;
    cfg.eval.enabled = !curEnabled;
    cfg.rules.confidence_threshold = 0.5;
    const put = await http('PUT', '/admin/api/classifier', { admin: true, body: cfg });
    const after = await http('GET', '/admin/api/classifier', { admin: true });
    check('PUT full config hot-applies (GET reflects change)', put.status === 200 && after.json?.eval?.enabled === !curEnabled && after.json?.rules?.confidence_threshold === 0.5, `eval.enabled ${curEnabled}→${after.json?.eval?.enabled}, threshold→${after.json?.rules?.confidence_threshold}`);
    // revert to original
    cfg.eval.enabled = curEnabled;
    cfg.rules.confidence_threshold = origThreshold;
    await http('PUT', '/admin/api/classifier', { admin: true, body: cfg });
    // Hardening (#4): a wrong-shaped patch must be rejected, not silently write defaults.
    const patch = await http('PUT', '/admin/api/classifier', { admin: true, body: { eval_enabled: true, confidence_threshold: 0.5 } });
    check('wrong-shaped classifier patch → 400 (strict, fail-closed)', patch.status === 400, `status=${patch.status}`);
  }

  // ── Rate limit (docs/06) ────────────────────────────────────────────────────
  cat('Rate limit');
  {
    // default disabled → rapid requests are NOT 429 (auth-only, cheap-ish; use a 400 path to avoid LLM cost)
    let any429 = false;
    for (let i = 0; i < 6; i++) {
      const r = await http('POST', '/v1/chat/completions', { auth: true, body: { model: 'auto', messages: [] } }); // 4xx, no upstream
      if (r.status === 429) any429 = true;
    }
    check('rate limit OFF by default (no 429 under burst)', !any429);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok && !r.skip).length;
  const skip = results.filter((r) => r.skip).length;
  console.log(`\n=== SUMMARY: ${pass} pass, ${fail} fail, ${skip} skip (of ${results.length}) ===`);
  if (fail) {
    console.log('FAILURES:');
    for (const r of results.filter((x) => !x.ok && !x.skip)) console.log(`  ✗ [${r.cat}] ${r.name}  ${r.info}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
