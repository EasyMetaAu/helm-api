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
    // Streaming Responses has no SSE transformer yet → must reject with a clean 400, not 5xx / silent JSON.
    const s = await http('POST', '/v1/responses', { auth: true, body: { model: 'auto', max_output_tokens: 24, input: 'hi', stream: true } });
    check('/v1/responses stream:true → 400 invalid_request (honest unsupported)', s.status === 400 && (s.json?.error?.code === 'invalid_request'), `status=${s.status}`);
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
    const r = await http('POST', '/v1/chat/completions', { auth: true, body: { ...userMsg('Return JSON with ok=true'), response_format: { type: 'json_object' } } });
    // CRS json-capable candidates fail upstream + */auto pruned (no_json_support) → 502
    check('JSON-constraint request → structured error (502/422)', [502, 422].includes(r.status), `status=${r.status} code=${r.json?.error?.code ?? r.json?.error_class}`);
    check('error body is structured (has code/type)', !!(r.json?.error?.code || r.json?.error_class || r.json?.error?.type));
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
    const row = Array.isArray(list.json) ? list.json.find((r) => r.trace_id === chatTrace || r.request_id === chatTrace) : null;
    check('chat request was persisted to telemetry', !!row, `trace=${chatTrace}`);
    if (row) {
      check('decision record has classifier+lane+attempts+final', !!(row.classifier && row.lane && Array.isArray(row.provider_attempts) && row.final));
      check('candidate_chain expanded (primary+fallback, not just lane name)', Array.isArray(row.lane?.candidate_chain) && row.lane.candidate_chain.length > 1, JSON.stringify(row.lane?.candidate_chain));
      check('decided_by recorded (原则5: classification stage visible)', typeof row.classifier?.decided_by === 'string', `decided_by=${row.classifier?.decided_by}`);
    }
    const prefixOnly = typeof row?.key_prefix === 'string' && row.key_prefix.length <= 16 && !list.text.includes(KEY);
    check('redaction: only key prefix stored, full plaintext key NEVER in telemetry (原则7)', prefixOnly, `key_prefix=${row?.key_prefix}`);
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
