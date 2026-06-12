# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 3 条**完整记录。新条目入栈时，把被挤出前三的条目压缩成一行要点（保留日期、标题、关键决定/坑/TODO），移入文末「历史条目摘要」。完整原文可经 git history 回溯。

---

## 2026-06-12 · Claude Code 计费归因块：入站剥离客户端轮换头 + 订阅路重注入「真实版本、可缓存」头（docs/05；anti-ban；原则 4/7）

- **缘起**：用户报告 admin 捕获 payload「数据全是重复的」，怀疑 helm 拼接 bug。结论：**helm 无 bug**（`messages.ts` parse 前 `c.req.text()` 原样捕获）。畸形是 Claude Code ≥2.1.29 客户端行为——把 `x-anthropic-billing-header: cc_version=<v>.<3hex>; cc_entrypoint=cli; cch=<5hex>;` 注入为 top-level `system[0]`，且 **3hex 后缀和 cch 都按请求内容哈希、逐请求轮换**（从真实 2.1.175 二进制 `z76()` 确认：`cch=00000` 是 JS 里的 sentinel，native 层 egress 前替换成真实 5hex，所以 helm 收到的 body 已是 `fd3e2`/`8f46b` 真值）。prompt cache 严格前缀匹配 → 首块每轮变 → 生产实测**每轮 `cached_tokens=0` + ~42.8K 缓存重写 + 150–200K Opus 输入全额未缓存**（≈10×）。上游已知：anthropics/claude-code#24168、#40652、motiful/cc-cache-audit。
- **两层修复（用户拍板 Plan B）**：
  1. **入站剥离**（`protocol/anthropic/request.ts` `transformRequestOut`）：`stripBillingHeader` 无条件丢弃以 `x-anthropic-billing-header:` 开头的 top-level system 块（string 整块即头→不发 system；数组过滤空→不发；prefix 锚定 `startsWith`，正文提及不误伤）。去掉客户端那个**轮换且与 helm 伪装版本不符**的头（否则会折进订阅 system 砸缓存 + 暴露矛盾）。OpenAI 中继路也因此免受污染。
  2. **订阅路重注入**（`provider/anthropic.ts`）：`buildSystem` 现在把 `billingHeaderBlock(systemText)` 放 `system[0]`（spoof 退到 `system[1]`，复刻真 CC 布局）。后缀+cch 由 **SHA-256(稳定 system 文本) 切片**派生（`slice(0,3)` / `slice(3,8)`）——对 Anthropic 是普通内容哈希、不可分辨，但**只在 system 提示变化时才变**（那时缓存本就失效），跨同会话多轮字节恒定 → **缓存命中**。`CLAUDE_CODE_VERSION` 从假的 `1.0.0` 升到**真实 `2.1.175`**，user-agent 改 `claude-cli/2.1.175 (external, cli)`（与二进制逐字对齐）。betas（`claude-code-20250219,oauth-2025-04-20` + context-mgmt/compact/fast）经核对本就与 2.1.175 一致；`anthropic-version: 2023-06-01` 一致。
- **关键取舍（已与用户敲定）**：真 CC 的头逐请求轮换（后缀+cch 都是内容哈希），所以「字节级仿真」与「命中缓存」**本质冲突**。三选项里用户选**按缓存前缀算哈希**：authentic-looking + 真实版本 + 可缓存；唯一弱差异是同会话内 cch 不像真 CC 每轮变（但 cch 是归因 telemetry，Anthropic 几乎不可能据此封号）。另两个未选：①逐请求轮换=字节级最逼真但放弃缓存（同默认 CC 用户）；②每账号固定=缓存最好但偏离最大。**「无头」本身也合法**（=`CLAUDE_CODE_ATTRIBUTION_HEADER=0`），但订阅路选呈现正向一致身份。
- **维护坑**：`CLAUDE_CODE_VERSION` 是会过期的反封号常量——**必须随真实 CC 版本同步 bump**（连同 betas）；陈旧版本号本身就是指纹。`metadataUserId`（per-account 稳定 device id）仍是账号级身份来源，billing 头是内容派生（与真 CC 一致，非 per-account）。
- **验证**：TDD 红→绿。strip 5 例 + billing 重注入 3 例（system[0] 形状 / 跨轮恒定 / system 变则变）+ 改 4 处既有 system-index 断言（spoof 右移一位）。provider+protocol+gateway messages 361 绿、`pnpm typecheck`/`lint` 绿。

## 2026-06-12 · 首页 Token 计量 dashboard（持久化 + 聚合端点 + LayerChart 图表；CLAUDE.md 原则 1/3/7；docs/02/07）

- **缘起**：用户要在 `/admin` 首页看到「总/输入/输出/缓存 Token」与两张图（用量趋势 + 各模型占比），参考 `claude-relay-service` dashboard。阻塞点：helm-api **从不持久化 token 计数**——`catalog/cost.ts::usageFromBody()` 早就能解析 OpenAI/Anthropic 两种 usage 形状，但 `resolveCostUsd()` 只留 USD、丢掉 token 数；telemetry 表只存 `cost_usd`；无聚合端点（首页此前 client 侧 reduce ≤200 行样本）；无图表库。决策（已与用户敲定）：**cards + 2 charts / LayerChart / forward-only 不回填**。
- **三层改动**：
  1. **持久化**：`DecisionRecord` 加可选 `usage` 块（`TokenUsageSchema`，4 个整数计数）。**容器键必须叫 `usage`**——redactor 的 `DEFAULT_SECRET_PATTERN` 含 `token`，若键名带 "token" 整个对象会被 summarize 成 `{redacted:true}`；标量 `*_tokens` 叶子本身能原样通过（[[已修的 memory_tokens_injected]] 同理）。由 pinned redaction 测试钉死。gateway `backfillCompletionCost` 加第 4 参 `usage?`，复用 **core 的** `usageFromBody`（别名导入；gateway 本地同名函数只返回原始对象）映射后盖戳；token 盖戳与 cost **解耦**（null cost + 有 usage 仍盖 token，非流式路径也补盖）。telemetry 表反范式化 5 列（`prompt/completion/cached/cache_creation_tokens` + `served_model`）便于 SQL 聚合；迁移 **sqlite v22 / pg v21**（两套 ledger 独立编号，sqlite 因早期重建领先一号）。
  2. **聚合端点**：`TelemetryStore.aggregate(start,end,bucket)` 返回 `{totals, series[], byModel[]}`，三条 SQL 全走 `SUM`/`COUNT`/`GROUP BY`（绝不逐行 JS）。分桶用 epoch-ms 整除（窗口大小经 `sql.raw` 内联，确保两方言都做整数除法），排序在共享 `aggregate-shape.ts` 里用 JS 做（方言无关）。token sum 用 `COALESCE(...,0)`，cost/latency 保持 nullable（「未测量」≠ 0）。新 `GET /admin/api/stats`，查询用 fail-open 的 `StatsQuerySchema`（默认末 24h / day）。
  3. **前端**：`layerchart@^1.0.13`（Svelte5 兼容，SSR 已关无需 guard）；`lib/api/stats.ts` 客户端 + `+page.ts` loader 改调 `getStats`（recent-requests 表仍用 `listRequests`）；4 张 token card + AreaChart 趋势 + PieChart（`innerRadius:-40` 甜甜圈）各模型占比；`formatTokens`（1.2M/34.5K）；i18n en/zh-hans/zh-hant/ja/ko。
- **坑/取舍**：**forward-only**——历史行 token 列与 `served_model` 为 NULL，趋势从部署起、by-model 旧流量归到 "unknown" 桶。avg latency 仍从 decision JSON 读（`json_extract`/`->>`），有界窗口可接受；变热再反范式化。LayerChart 的 `AreaChart`/`PieChart` 用 Svelte4 风格 props 但 runes 模式下渲染正常；类型上需给两图显式 point 类型，否则各 series accessor 把 `TData` 收窄成不同内联形状无法统一。WebFetch/Context7 当时都取不到 LayerChart API，最终读包内 `.d.ts` 作为 ground truth。
- **追加修复**：review 发现 non-chat 协议的 admin 流式 replay 没有 budget deps 时会跳过 streamed usage 盖戳，导致 replay telemetry 被 dashboard 少算；已把 shared `messages-pipeline` 的 token stamp 从 budget-only 分支移出，budget settle 仍保持 gated。
- **验证**：`pnpm typecheck`/`lint` 全绿；`pnpm test` 绿（唯一 full-run 红是已知 PGlite 5s 超时 flake `memory-jobs.test.ts`，隔离重跑 8/8 过——见 [[pnpm-test-pglite-flake]]）。新覆盖：redaction guard、schema round-trip、gateway token-stamp（OpenAI+Anthropic）、aggregate contract（**两 adapter** sqlite+pglite）、stats route、`formatTokens`、dashboard locale coverage。13 个迁移-scoped 测试因预置 applied 版本列表少了 v22/v21 而红，已补齐（图表渲染本身 jsdom 不可测）。

## 2026-06-12 · 四协议互译保真补丁（Responses tool_choice / Anthropic native controls / Gemini safety；CLAUDE.md 原则 1/7/8；docs/05/07）

- **缘起**：继续对照本地 LiteLLM review 四协议互译缺口。剩余问题集中在“字段形状接近但不完全相同”的边缘：Responses `tool_choice` 在 Responses 与 Chat 之间形状不同；Responses `previous_response_id` 的 tool-output continuation 需要服务端历史；Anthropic native/control 参数进 IR 后丢失；Gemini `safetySettings` 没有 round-trip；Anthropic provider 使用 `context_management` / `speed:"fast"` 时缺 feature beta header。
- **修复**：Responses transformer 把 inbound `{type:"function",name}` 规范成 OpenAI Chat `{type:"function",function:{name}}`，outbound 反向还原；Codex Responses provider 同步把 Chat `tool_choice` 发成 Responses 顶层 `name` 形状。Anthropic transformer 将 `context_management`、`mcp_servers`、`container`、`speed`、`output_config` 保存在 `provider_raw` 并在 Anthropic native out 重新发出，`context_management` 数组按 LiteLLM 兼容形状包成 `{edits:[...]}`。Anthropic provider 透传这些 native controls，并按 body 动态补 `context-management-2025-06-27`、`compact-2026-01-12`、`fast-mode-2026-02-01` beta。Gemini transformer 将 `safetySettings` 存入 `provider_raw.safety_settings` 并在 Gemini native out 恢复。
- **取舍/仍开放**：Helm 目前没有 Responses object/session/history store，所以带 `previous_response_id` 且只提交历史 tool-output continuation 的请求不能假装可处理；本轮选择 **fail-closed**，返回明确错误，避免把缺少本地 `function_call` 上下文的 `function_call_output` 转成无效 Chat tool message。单纯携带 `previous_response_id` 的普通字符串 input 仍保留在 `provider_raw` 用于后续 Responses-native round-trip；完整 continuation 支持需要 response store、input_items/history 查询和 tool-call correlation。
- **验证**：TDD 红→绿。新增/更新 focused regression 覆盖 Responses `tool_choice` 双向规范化、`previous_response_id` continuation fail-closed、Codex provider `tool_choice`、Anthropic native passthrough + beta headers、Gemini `safetySettings` round-trip，以及 gateway 不把 `previous_response_id` / `truncation` 泄漏到 OpenAI-compatible upstream。验证命令：focused Vitest 244 绿；`pnpm typecheck` 绿；`pnpm lint` 绿；`pnpm test` 初跑因本地 `better-sqlite3` ABI 137 vs Node 25 ABI 141 失败，执行 `pnpm --filter @helm/core rebuild better-sqlite3` 后完整 `pnpm test` 240 files / 3036 tests 绿。

---

## 历史条目摘要（压缩归档）

> 以下为更早条目的一行要点（新→旧）。完整原文见 git history（本文件在 2026-06-05 压缩前的版本）。

### 2026-06-12 · 新增 claude-fable-5 配置支持（原则 2/6；docs/04）：能力取自 OpenRouter API（ctx 1M / max_out 128K / text+image+file→document，pricing 未落库）；完全镜像 claude-opus 模式——`lanes.yaml` 新 `claude-fable` lane 以 native OAuth 别名领衔、`fallback:[premium]`，`model-aliases.yaml` 加 `claude-fable-*` glob；用户拍板**去掉 OpenRouter 静态镜像兜底**；native 别名靠运行时 OAuth pool 注册不进 providers.yaml。TDD samples+catalog 98 绿。部署坑：需手动同步 `/opt/helm-api/config` 两个 yaml（[[deploy-never-overwrite-config]]）。

### 2026-06-12 · Codex/Responses 流式兼容修复（状态可见 + 生命周期路由形状；原则 1/7/8；docs/05/07）：修 Responses SSE 解析（CRLF/multi-line/tail/event fallback/reasoning deltas）、补 `/v1/responses` lifecycle/helper URL family auth-first structured unsupported；`stream:true` 路由立即发 `response.created`/`in_progress` prelude 并复用 route-stamped response id，Codex 客户端可低首 token 延迟看到状态。取舍：非完整 Responses object store/token counter，helper endpoints fail-closed unsupported。

### 2026-06-12 · LiteLLM 协议兼容面修复（四协议路由 + Gemini usage；原则 1/7/8；docs/05/07）：对照 LiteLLM 补 drop-in 缺口——Gemini `parseGeminiPath` 接受 `/v1beta/models/{model:path}` 与 `/models/{model:path}`、`streamGenerateContent` 一律流式；Gemini 流式 `promptTokenCount` 加回 cache read/write（gateway 渲染前先标准化 usage 防重复加）；OpenAI Chat 增 `/chat/completions`+engine/deployment 路径别名、Responses 增 `/responses`+`/openai/v1/responses`、Anthropic 加 event_logging stub + 本地 count_tokens 估算。取舍：Responses GET/DELETE/cancel/input_items/compact 仍需 object store，本轮只补 create aliases；core transformer 不做网络 fetch。TDD 红例钉死 Gemini 流式 double-count（140→100）。typecheck/lint/build/test(3020)/e2e(64) 绿。

### 2026-06-12 · Anthropic streaming 保留 MCP 双下划线工具名（原则 8；docs/05）：线上 Claude Code 经 Helm 调 `codegraph` MCP，流式 `tool_use.name` 把 `mcp__codegraph__codegraph_context` 折叠成单下划线 → 客户端 `No such tool available` 死循环。根因 = `sanitizeAnthropicToolName` 把非法字符替换后又折叠连续 `_`，破坏 MCP 双下划线命名空间语义。修复：不再折叠 `_+`，保留非法字符替换/首尾裁剪/空名兜底/冲突 hash 后缀（`search web` 仍产冲突后缀，`mcp__server__tool` 原样通过）。TDD 钉死 streaming round-trip。

### 2026-06-11 · 「重试」按钮支持全部四协议：admin retry 从 OpenAI-chat-only 改为 faithful 原生回放；DecisionRecord 增可选 `protocol` 零迁移盖戳，旧记录按 body 形状推断；Anthropic/Responses/Gemini 复用 live transformers + shared pipeline 捕获原生响应，客户端 `canRetry` 放宽为对象 body 即可；限制是非 chat 流式回放不回填 `completion_usd`，需发新 admin 镜像。

### 2026-06-11 · 请求页自动刷新控件 RefreshControl：新增请求页分体刷新按钮 + 下拉自动刷新节奏（关/5s…1d），`onRefresh` 注入 `invalidateAll()`，定时器生命周期内有效且不持久化；admin tests/build/lint 当时通过，需发新 admin 镜像生效。

### 2026-06-11 · 记忆消息重复写入根治 + 历史脏数据清理：根因是 observeInbound 全量盲插客户端重发 transcript，`memory_messages` O(n²) 膨胀并让 observer 反复压缩；修复为 `message_index + content_hash` 幂等键、sqlite/pg 迁移与 dedup 运维脚本，清理 observations 后重建。坑：历史 NULL hash 需脚本补齐；部署先迁移后备份/dry-run/正式/VACUUM。

### 2026-06-11 · 四个 AI API 高并发热路径性能优化（Phase B）：根因仍是 [[sqlite-write-perf-root-cause]] better-sqlite3 同步阻塞事件循环。四独立修复（各藏可选 dep / boot 调用后，可单独回滚）：① `cached-keystore.ts` `createCachedKeyStore` 对 `getByHash` 做 LRU+TTL（默认 30s `HELM_AUTH_CACHE_TTL_MS`，mutation 整表失效；多实例 Postgres 下吊销最多续命 TTL）；② **延迟+批量写队列** `runtime/write-queue.ts`（`TelemetryStore.insertMany?`/`insertPayloads?`，25ms/阈值合并 flush，副作用走 FIFO 串行，有界深度；接可选 `writes` dep——缺省 inline await，存在=响应后批量；**budget settle 永不延迟**；SIGTERM→flush 再关 store；批量失败回退逐条）；③ `runtime/egress.ts` boot 设 undici 全局 `Agent`（keepAlive 30s，消反复 TLS 握手）；④ `createSseCapture(full)` capture 关只留 ~16KB 尾够成本回填。无 DB schema/客户端 API/必填配置改动。全量 2935 绿。

### 2026-06-10 · SQLite 写入热路径性能修复（Phase A，无 Redis）：根因非 SQLite 并发能力，而是 better-sqlite3 同步阻塞 Node 单线程 + 默认 `synchronous=FULL`（每 commit fsync）；修复 = `migrate.ts::applyPragmas()` 每连接设 WAL + `synchronous=NORMAL` + busy_timeout/temp_store/cache_size，外加 `MemoryStore` 可选 `appendMessages` 批量写（单事务 / 多行 INSERT，N commit→1，`createdAt=base+i` 保序）。坑：PRAGMA 硬编码不入 config；NORMAL 弱持久性已接受；部署后需实测两并发延迟再定 Phase B（Redis 是多实例扩展、非单机吞吐）。migrate.pragmas.test(3)+store-contract/observe 批量例、全量 2601 绿。

### 2026-06-10 · admin 导航进度条 NavProgress：纯消费 SvelteKit `navigating` store 的顶部细进度条（8% 起跳→trickle 逼近 92%→resolve 补满淡出），`$effect` 仅依赖 `$navigating` + `untrack` 防 trickle 自触发，挂 `+layout.svelte` 最顶层；**只覆盖路由导航（含其 `load` 内 API），不做全局 fetch 拦截**（Occam，~70 行无 nprogress 依赖）。坑：页内非导航 fetch 不反映；改页内手动取数的页将不触发；需发新 admin 镜像。NavProgress.test 3 绿。

### 2026-06-10 · Anthropic tool_result 邻接兼容修复：`transformRequestOut` 对混合 user turn 先发 fanned-out `role:"tool"` 结果再发尾随文本；订阅 provider `openaiToAnthropicRequest` 合并相邻同角色（连续 OpenAI tool→单个 Anthropic user turn，`tool_result` 块先于文本），修线上 `messages.N` 的 `tool_use` 无紧邻 `tool_result` 的 400；纯结构归一化、不拒绝 payload、不丢用户文本，纯 tool-result turn 行为不变。core 63 绿。

### 2026-06-10 · 虚拟模型别名映射 model-aliases.yaml：裸厂商 id（如 `claude-opus-4-8`）→ lane 名/`auto` 的兼容映射（`routing/model-alias.ts`），`plan()` step-0 独立 0a 分支解析，对任意 key 生效但经 `aliasPolicyContext` 跑 policy+key 双层 cap 静默 clamp（不提权，Codex review P1）；精确键优先、否则最长字面 `*`-glob、大小写敏感；`ModelAliasesSchema` 形状校验 + boot 时 `validateModelAliasTargets` 对有效 lane 集 fail-closed。出厂 `config/model-aliases.yaml` 带 claude-*/gpt-* 激活映射。**坑：线上需手动在 `/opt/helm-api/config` 放该 yaml 才生效（见 [[deploy-never-overwrite-config]]）。**

### 2026-06-10 · publish.yml 版本号升级自动发布 Release：main push 读根 `package.json` 版本 V，若 `vV` tag 不存在即判定版本升级——额外推 `:V` 镜像并用 GitHub REST 建 tag+Release（generate_release_notes）；普通 commit 行为不变（仅 `:latest`/`:sha`）。GITHUB_TOKEN 建的 tag 不递归触发本 workflow（避免重复构建），`tags:[v*]` 保留作手工 escape hatch；需 `contents:write` + `fetch-depth:0`。新流程：bump package.json → release PR → squash main → 自动发布。

### 2026-06-10 · Prompt caching 参数保真与缓存计费修复：补齐 `prompt_cache_key`/`prompt_cache_retention`/`cached_content`/Anthropic `cache_control` 透传与 cache read/write 成本拆分；Gemini cachedContent 加能力门禁；风险是运营侧需准确标记 `supportsCachedContent`，缺失则对 cached-content 请求 fail-closed。

### 2026-06-10 · 请求详情页多行/长字符串「预览」弹窗：新增 `TextPreview.svelte`，对多行或 >512 字符串在 `JsonTree` 节点挂「Preview」按钮，复用 `Modal`（新增 `wide` prop）渲染解码后原文 + Copy；只读、零 core/config 改动；admin 279 绿。需发新 admin 镜像生效。

### 2026-06-10 · Responses API flat function tools 规范化为 Chat tools：`responsesTransformer.transformRequestOut` 把扁平 `{type:"function",name,...}` 规范成 Chat `tools[].function`（修官方 DeepSeek `tools[0]: missing field function` 400），原文存 `provider_raw.responses_tools` 供 round-trip 恢复；只转带 name 的 function tool，未知类型 fail-open。core 43/43 绿，生产 DeepSeek 直连 200。需发新镜像生效。

### 2026-06-09 · DeepSeek provider developer-role 兼容开关：新增 provider-scoped `map_developer_role_to_system` 并在官方 DeepSeek provider 开启，避免 OpenAI `developer` 角色被 DeepSeek 400；原始 payload 保真，上游 wire body 做兼容转换，需部署新镜像/生产配置才生效。

### 2026-06-09 · 请求详情页 Responses API 流式回放与 JSON 换行修复：`parseSseStream` 加 Responses `response.*` 分支（Anthropic 前匹配，累积 `output_text.delta`、读 `response.completed` usage/model/status、done 事件仅兜底快照不重复 append）；`JsonViewer` 三 tab 与 `JsonTree` scalar 统一 `whitespace-pre-wrap break-words [overflow-wrap:anywhere]` 去横向滚动。Vitest 40/40 绿。

### 2026-06-09 · LLM 记忆提取/压缩接线与可配置模型：新增默认关闭的 `memory.llm`，后台 Observer/Reflector/facts 可用配置模型替代 deterministic stub；LLM 失败/无效 JSON/空白输出均 fail-open 回 stub，prompt 去掉 `previous_reflection` 并强制 fact citation 命中 active observation。

### 2026-06-09 · Agentic Signals 反馈接入 ranked-lane 路由：新增默认关闭的 `runtime.signal_feedback`，请求路径读取聚合 signals 后仅可在 ranked lane 内健康提升，不降级、不越过 policy/key/budget caps；读取异常 fail-open。TODO：若后续支持 task lane 反馈，需先定义 task lane → ranked lane 映射。

### 2026-06-09 · 生产路径四协议 LiteLLM 参数保真 + payload 原文记录修复：生产路径补齐 OpenAI Chat/Anthropic/Responses/Gemini LiteLLM 参数透传，流式强制 usage 回填，payload 表保存原始请求 JSON 文本；TDD 覆盖 route/pipeline/execute/provider/payload 边界。TODO：pre-pipeline 拒绝仍未统一写入 request history。

### 2026-06-08 · 四协议完整性审计 + 逐条修复：Workflow 扇出审计 4 个 wire 协议，对照 LiteLLM 找到并 TDD 修复 31 项生产协议/流式/usage/多模态缺口；最终 core 1744 绿、typecheck/lint/build 通过。

### 2026-06-07 · 修复 Anthropic 订阅配额页：`resets_at:null` 让整份用量解析失败、快照永久卡旧；修为 `utilization`/`resets_at` 双 `.nullish()`，保坏类型 fail-closed；TDD 锁线上 body，oauth/shared/core 验证通过。

### 2026-06-07 · 记忆压缩重写为单一 auto 模式：删除 fixed/economy，改为默认零配置 auto + 少量触发覆盖；价格/上下文窗口从 catalog 自适应，三触发 size/idle/pressure，修复多轮评审发现的 idle/前沿/范围/配置漂移问题；最终 typecheck/lint/build/full test 通过。

### 2026-06-07 · 重试请求：原 key 失效时回退 root key（用户决策；docs/07）：原 key 存活照旧用（路由忠实），已删/吊销则回退**第一把存活 root key**（记 `replay.root_key_fallback`），连存活 root 都没有才 409。有意偏离「绝不放宽权限」——replay 在 admin Basic auth 后，操作者本就 root 等价，回退是主动调试非提权；代价是路由保真度（root 无 lane 白名单），靠日志+归因补偿。遥测 `apiKeyId` 改记**实际使用的 key**（避免悬空引用）。TDD 4 case，replay 15/15、admin 78/78 绿，前端零改。

### 2026-06-07 · eval 快探针 + 流式 idle 超时（修复线上恒 fallback；docs/03 Layer 2；原则 2/4）：① `model:"auto"` 中文请求恒 `eval_timeout` 降级——根因 eval 模型是推理模型、250ms 内层超时不够；方案 `EvalConfigSchema.extra_body` 配置驱动请求体透传（classify invokeModel 铺最前、锁定 model/temperature/stream/max_tokens 后覆盖），classifier.yaml 设 `thinking.{type:disabled}` 关推理 → ~1.1s 干净 JSON、超时收回 1500/2000。② 新增 `provider/stream-idle.ts` `readChunkWithIdle`：TTFB 后流式读循环此前**无超时**，mid-stream 卡死永久挂起；逐块计时（非总时长），首块前抛=可 fallback、之后抛=终止流；复用 `request_timeout_ms` 当 idle 值；三 client 接入。Codex 二轮修 3 真 bug（终止 SSE 事件后须停读否则误判 timeout、cancel 改 fire-and-forget、四路由用 `isUpstreamTimeout` 谓词保 timeout 分类）。**部署 TODO**：代码在分支，线上 0.8.3 无；新镜像部署后 classifier.yaml 切 `extra_body.thinking+1500/2000`、`request_timeout_ms` 由 300000 下调 ~60–90s（兼 TTFB+idle，卡死连接快回收）。全量 2552 绿。

### 2026-06-07 · 请求详情页展示第二层 eval 的模型与复核结论（修复；docs/03/07；原则 5/7）：cascade 用 eval verdict 覆盖 rules 输出且 eval 模型名从不持久化 → 详情页把 eval 结果误标为「第一层规则」。修：新增持久字段 `classifier.eval_model`/`eval_latency_ms`（`.default(null)` 兼容 legacy；落库在 route-request.ts `plan()` 内联），`toDetail` 透传 `decided_by`，DecisionChain 加判定来源徽章、eval 框重做（模型+缓存+耗时+verdict/fail-open 原因）。后续修正：0.8.5 上线后用户仍把 eval 的 0.95 误读为第一层置信度 → 补 `classifier.rules_confidence` 持久化触发升级的 gate 置信度 + 升级因果行（"第一层不确定(0.05)→升级 eval 复核"，legacy 无数值定性显示不伪造）；`matched_dimensions` 映射加固防 `[object Object]`。两轮共 14 处 DecisionRecord fixture 补新字段；全量 2570 绿。

### 2026-06-07 · 请求详情页时间显示「未记录时间」（修复；docs/07）：根因①详情接口直吐 `DecisionRecord`（schema 无时间戳，时间在独立 `createdAt` 列）②前端 `toDetail` 把 `ts` 写死 `''`。修：新增窄查询端口 `getCreatedAt(requestId)`（仿 getApiKeyId 单列 select；pg 列为 epoch-ms bigint 需 `new Date(ms)` 包回），详情接口拍平 `created_at`，前端与 `toListItem` 同款映射；legacy 无值仍兜底（绝不伪造时间）。TDD 双适配器契约 + 4 处 TelemetryStore mock 补 `getCreatedAt`。

### 2026-06-06 · 管理界面规则编辑写回 YAML（修复「保存只活内存、重启即回滚」；用户决策；docs/11；原则 2）：三页（分类器/Lanes/Policies）保存只重绑内存、重启回滚 → 新增 `yaml-writeback.ts`（保留注释 eemeli/yaml `setIn` + 原子 tmp+rename + fail-closed 写失败 throw），RuntimeRuleStore **先持久化后重绑**（写失败→500、内存不动、文件内存不分叉）。文件形状对齐 loader（lanes 平铺 map 缺失即删 / policies 列表整替 / classifier 包裹逐 scalar）。e2e 防误伤：test-server configDir 改拷贝到 `.e2e-data/config` 不碰仓库 config。部署坑：`/opt/helm-api/config` 须 `chown` 10001（root 属主则保存 fail-closed 500）。gateway 新增依赖 `yaml@^2.9`。

### 2026-06-06 · 请求详情页「重试」按钮（可编辑重发 + 隔离重跑；用户决策；docs/07）：弹窗预填录制请求体可改 max_tokens/messages 再发；隔离 debug 重跑走真路由+真 provider、记新 trace+payload 但**不计 budget/不写记忆**，身份/caps 从原 key 重建（lane 白名单/allow_custom_model 仍生效；key 删/吊当时 → 409，**2026-06-07 已改为回退 root key**，见顶部条目）。后端 `getApiKeyId` 窄查询重建身份 + `admin/replay.ts`（判别式 outcome 400/404/409，insert 失败 fail-closed 500 因交付物就是那条记录）；范围 v1=openai_chat（按体 schema 推断，无需新存 protocol）。Codex 修复：限流/并发门一并绕过属有意取舍（运维动作非客户端面）已成文；流式 drain try/catch 部分字节照存。

### 2026-06-06 · 已吊销 key 允许永久删除（两步销毁；用户决策；docs/06）：软吊销 `DELETE /:id` 契约不动，硬删作 `?purge=true` 旗标；路由 gate `list().find`——未找 404 / active 409（必先吊销）/ disabled 才 deleteKey。「必先吊销」是路由策略不进 store；UI 仅 disabled 行显 Delete 但 server 独立校验（纵深防御）。审计存活靠 telemetry/payload 的 `api_key_id` 是无 FK 纯文本列，硬删不级联、悬空引用仍可审计。贯穿 core `KeyStore.deleteKey`(throw on unknown)→admin route→api client→+page。坑：选旗标不破 revoke 契约；read→delete TOCTOU 在单管理员场景可忽略 + deleteKey throw 兜底。

### 2026-06-06 · 记忆 thread source 新 key 默认 auto（配合「记忆默认开启」；用户决策；docs/08）：新 key `memory_mode=inject` 却 thread source 仍 `header` = 缺 `x-thread-id` 不回退信号链、无 per-conversation 记忆——两 keystore `createKey` mint 默认 `?? "header" → ?? "auto"`（仅新 key；Zod parse-default `header` 不动，既有 key/迁移不重写）。admin UI 诚实化：KeyCapsForm/CreateKeyDialog 默认显 Auto = 实际落库值。Codex 修复：(P2) `bootstrapRootKey` 显式置 `off`+`header` 让 root key 记忆惰性（root key 勿用于生产流量）；(P3) CreateKeyInput 各层注释自 #106 起误写「omitted => off」→ 改如实「省略 ⇒ mint 默认 inject/auto」。

### 2026-06-06 · 记忆默认开启（eval 维持默认关闭——依赖已配置 eval 模型）（用户决策；docs/08）：只开记忆不开 eval——Layer-2 eval 客户端把 `model`(deepseek-v4-flash) 直发 providers[0]，无配好 DeepSeek 兼容 provider 时每个 uncertain 请求先打一通失败再 fail-open 回 balanced，故 eval **必须有可用模型才开**、留 per-deployment opt-in（原则 4）。memory 无全局开关：新 key `keystore.create` mint `off→inject`（sqlite+pg）+ 请求兜底 `memory-scope` `?? off → ?? inject`，**仅新 key+兜底、不迁移既有 key**（DB 列默认/迁移仍 off）；显式 `x-memory-mode` 仍优先、非法头归一 off，`inject` 在 threadId===null 时自闸 no-op。`config/memory.yaml enabled` 早前置 true 配套。测试 store-contract/memory-scope/messages.memory 随翻转，2474 绿；README+docs/01/02/08/12 记忆表述改「默认开启」、eval 维持「off by default」。

### 2026-06-06 · 订阅 provider 绑定全程走代理，堵住绑定首步真实 IP 泄露（issue #38；docs/02/06/11）：所有 OAuth 出站硬编码全局 fetch → 绑定首通（Copilot device-code POST / Anthropic·Codex token 交换）+ 刷新从运营者真实 IP 发出，唯 chat 执行走代理。修：core OAuth kit 全网络函数加可选 `fetchImpl`（默认全局 fetch 向后兼容）+ `refreshToken(creds,fetchImpl?)`；连接对话框第 1 步加代理区，start 路由 validate 后 pin 进 login session，绑定成功写 account settings → refresh/execution/quota 复用。测试 stub 全局 fetch 成 throw 证明绑定走代理则永不调用全局 fetch。Codex 三修：(P1) buildServer primaryCred 漏传代理→preset-OAuth 刷新泄露，resolveProviderProxy 一次算 primaryProxy 同喂 buildCredential+createProviderClient；(P2) 持久化改「先代理后 token」fail-closed；(P2) UI 文案改「浏览器登录页不走代理」。

### 2026-06-06 · API key 增加可编辑 name 字段（docs/06）：新增 `api_keys.name`（纯展示标签，非鉴权/路由）+迁移 sqlite v19/pg v18（additive nullable）；3 个 schema 共用 `KeyNameSchema=z.string().trim().min(1).max(100)`（服务端 trim，纯空白塌成 "" 被拒——Codex P3）；record `.nullable().default(null)`、create `.optional()`、update `.nullable().optional()`(null 清空)；贯穿 ports/两 keystore/admin route(POST/PATCH/toSummary)/api client(normalizeView 读侧也 trim)/Create+Edit 对话框/列表 Name 列(空显 Unnamed)。坑：最小种子迁移测试须把 v19/v18 并入预标记集（种子无 api_keys 表）；6 个 gateway fixture 补 `name:null`；api client 测试复用单 Response(body 单读)→ mockResolvedValueOnce。

### 2026-06-05 · live 集成测试上线记忆段 + 脱敏器吞数字计数的生产 bug（scripts/integration-live.mjs；docs/07/08/12）：integration-live 新增「Memory middleware」段（observe/inject/写回/fail-open/default-safe/不泄漏正文哨兵）首跑即抓真 bug——脱敏器把 `memory_tokens_injected` 数字计数 mangle 成对象 → DecisionRecord 解析失败 → `/admin/api/requests` 整页 502（#41 起潜伏，fake store 不过脱敏回环故单测/e2e 全未踩）。双侧修：写侧 redactNode 放行 secret-key 命中的标量（number/bool/null 不携凭证，顺救 max_tokens），读侧 schema 对 legacy 损坏行 preprocess→0、非 legacy 垃圾仍 fail-closed。

### 2026-06-05 · 遗忘策略 Codex 评审修复 VII（docs/12）：(P2) reinforcement 仍在请求 tick 执行——`void bump().catch()` 不 await，但 sqlite 同步写当场执行 → 整体包 `setImmediate` 延后到 macrotask（try/catch 防崩）；(P2) 空集归档分支缺 `enabled` 门控，关闭时「有 reflection 无 observation」的 scope 仍被归档 → 加 `deps.forgetting?.enabled === true`。

### 2026-06-05 · 遗忘策略 Codex 评审修复 VI（docs/12）：有界扫描饥饿——limit-only 分页按 observed_at 取最旧 N，全幸存者页让 limit 外 condemned 行永不处理 → score 谓词下推 SQL（`candidates` 参数，与 score.ts 同公式），TS 复算留作纵深防御；archive→rebuild 后 reflection 版本重置 → 新增 `getReflectionVersionHighWater`（跨全 status MAX），写 highWater+1，内容仍只读 active。

### 2026-06-05 · 遗忘策略评审修复 V（docs/12）：评分公式语义级修正——access bonus 移进 recency 乘积内 `score = recency × (importance + bonus)`（原加法 = 一次注入的 bonus 0.104 永远高于阈值 0.05，「用过一次 = 永不遗忘」）；强化只延迟遗忘无永久豁免；`enable_llm_supersede` 改 `z.literal(false)`（LLM path 未接入前拒绝 true，不留撒谎开关）；notes 完成「最近 3 条」合规压缩。

### 2026-06-05 · 遗忘策略评审修复 IV（docs/12）：遗忘补全输出侧——reflection 是 active observation 的派生缓存：getReflection 过滤 active；新增 archiveReflections（active 集空时归档旧 reflection，min(1) 不能写空）+ listActiveReflectionScopes（decay 归档后为每个活跃 scope 入队 reflector 重建，open-job 去重、fail-open）；max_facts_per_subject 改按 validFrom 取最新 N 再 asc 写入（原 head-slice 留最旧丢修正）；fact 审计字段改存 observation id `[o.id,o.id]` 对齐 schema。

### 2026-06-05 · 遗忘策略评审修复 III（docs/12）：fact validFrom 改用来源 observation 的 observedAt（处理时刻 now 让同批矛盾事实互不 supersede、旧 observation 晚处理可错误过期新 fact）；ExtractedFact 加 validFrom?/sourceObservationRange?；listScorableObservations 加 limit（max_iterations×50、oldest-first）扫描有界；docs 配置示例改扁平（`memory:` wrapper 会被 strict 拒）+ 状态横幅改「P0–P7 implemented / P8 deferred」。

### 2026-06-05 · 遗忘策略评审修复 II（docs/12）：decay job 入口 re-check `enabled`（持久队列的残留 job 在开关关闭后不得归档）；fact supersede 改按新 fact 非空 scope 列收窄（与 listActiveFacts 读取语义一致，read-visible ⇒ supersede-able）；decay trigger 的 scope_id 匹配改 `json_extract`/`::jsonb->>'accountId'`（字符串拼接匹配不了 codec 转义的特殊字符 id → 每 tick 重触发）。

### 2026-06-05 · 遗忘策略评审修复 I（docs/12）：observation retention 改 TOMBSTONE（status='pruned' 保留行 + sourceMessageRange 覆盖标记——硬删会让 raw 复活重注入）；reflector/inject 内容读只取 active（覆盖读仍全状态，内容读 vs 覆盖读分离）；pg fact reconcile 整批包事务；P6 extractor 在 server.ts 接线（确定性 stub）；observer 从 priority 推导 importance（clamp(priority/10)）。坑：'[pruned]' 占位满足 observationText min(1)；active 过滤对 undefined status 宽松（旧 fixture 无 status 字段）。

### 2026-06-05 · 记忆遗忘策略 + 短/中/长期分层（docs/12 P0–P7 全实现）：纯评分函数（零依赖叶子模块、负 age 夹 0）；config.memory 子树（memory.yaml 扁平无 `memory:` wrapper，嵌套用 `.prefault({})` 非 `.default({})`——Zod v4 内层默认才生效）；迁移 sqlite v18/pg v17；memory_facts（owner_id NOT NULL 租户界 + UNIQUE(owner_id,content_hash) + bi-temporal）；inject bumpReferences fire-and-forget + score 裁剪（fail-open 回退 oldest）；decay job + scheduler 显式分发；facts 确定性去重/supersede；retention。`MemoryFactInput` 用 z.input 非 z.infer。全 gated `forgetting.enabled:false` = 字节级不变。TODO：P8 混合检索 deferred；LLM summarize/merge/extract 仍是确定性 stub。

### 2026-06-05 · 零改动客户端记忆接入（issue #97；docs/08）：per-key memory 默认值（api_keys 三列，迁移 sqlite v17/pg v16）+ thread 信号回退链（x-thread-id → body metadata → x-session-key → prompt_cache_key → metadata.user_id）；显式头永远赢、非法 mode 头归一 off（不落回 key 默认）。坑：prompt_cache_key 复用为会话锚点（隐式契约）；评审修复：key list 视图漏 memory 字段会让编辑静默清空配置、显式空 x-thread-id 不再触发回退链。

### 2026-06-05 · Memory 第二轮评审修复（docs/08 Phase 2；#41 跟进 II）：inject 过滤已被 observation 覆盖的 raw（防 observation+原文双份注入）；listObservations 的 project/resource scope 跨该 owner 全部 thread 聚合（防 project reflection 被单 thread last-writer-wins）；gemini pipeline 接 inject；claimPendingJobs 回收超 5min lease 的 stale running；DecisionRecord 新增脱敏 memory 字段。

### 2026-06-04 · 请求排队两特性（issue #93）：per-key 并发溢出排队（`concurrency_limit` 列，NULL=不限、0 被拒；队满/超时→429）+ per-account 用户消息串行（完整 drain 才释放锁；超时→终态 503 不前进 fallback、不记熔断）。in-memory promise FIFO（无 Redis，多实例各自排队=已知限制）；释放路径全覆盖（context 变量 + 路由 guard + 流 finally + 5min watchdog）；串行 gate 在 buildServer 建一次跨 pool rebuild 存活；gate 意外异常 fail-open。迁移 sqlite v13 / pg v12。

### 2026-06-04

- **`/v1/models` 漏报订阅（OAuth）模型**（#38/#94）：发现端点只拿静态 `providerAliases`，订阅别名在热加载的 `oauthAliasSet` 里。修复：`ModelsRouteDeps.oauthAliases?` 活读 thunk，gateway 组合根合并后交 `buildModelsList`（core 契约不动）。订阅别名只对 `allow_custom_model` key 可见；列出时不带 capabilities/pricing（TODO：去前缀回查 catalog）。
- **Memory 后台环路三处修复**（#41 评审 I）：① reflection 写入 scope 改取最高可读层级（`reflectionTargetScope`，project > resource；thread-only 不晋升）；② runner 抛错的已认领 job best-effort 标 failed，晋升单独 try/catch；③ D7 纯文本闸门移入 bridge，非纯文本轮次保留原文但仍 `enqueueObserverWriteback`。
- **Codex 额度 PULL + PUSH 双源**（#38）：原来只有响应头 PUSH，无流量则永远「—」。从 Codex CLI 逆向出 `GET chatgpt.com/backend-api/wham/usage`（Bearer + chatgpt-account-id），`fetchCodexQuota` 是 `fetchAnthropicQuota` 孪生（5 分钟正负缓存、8s 超时、代理复用）。schema 全 loose + fail-open（逆向端点可能改形态）。取舍：PULL 无条件覆盖快照。
- **公开端点三件套**（docs/06）：落地页 `GET /`（自包含静态 HTML 拉 healthz/version）；`/v1/models` **key 感知**——默认 key 只见 lanes+auto，`allow_custom_model` 额外见配置别名（附 capabilities/pricing + lane 成员关系），纯逻辑在 core `buildModelsList`；OpenAPI 3.1 + Swagger UI（`/openapi.json` + `/docs`，Zod 4 `z.toJSONSchema()` 直出，paths 手写）。`expandChain` 抽到 `core/lanes/expand-chain.ts` 复用。
- **显式 lane-as-model + 透传严格校验**（docs/04/06）：`allow_custom_model` key 可点名 lane 名（跳过分类但走 `expandChain` 完整链；lane 名遮蔽同名模型别名）；点名不在 `allowed_lanes` 的 lane → 400 响亮拒绝（不静默降级）；未知裸模型名严格拒绝（新增 `RouteDeps.isKnownModel`，移除显式透传的 Phase-0 fail-open）。拒绝也落完整 DecisionRecord。
- **Anthropic null 窗口解析回归 + /usage 孤儿过滤**：`seven_day_opus` 真实响应是显式 null，`.optional()` 不接受 null 导致整体解析失败——改四个窗口字段 `.nullish()`。/usage 路由加 listStatus 绑定过滤（同 /quota）。
- **OAuth 额度孤儿快照清理**：/quota 以 `listStatus()` 为唯一真相，孤儿行 best-effort 删除；新增 `OAuthQuotaStore.delete`。坑：源码里裸 NUL 字节让 git 把文件当二进制，改 `\u0000` 转义。
- **OAuth 额度刷新负缓存**（对齐 CRS）：`fetchAnthropicQuota` 原来只缓存成功，429/超时每次页面加载都重打被限流端点——改为成功/失败都缓存（TTL 内不重试）。无后台轮询。
- **OAuth 额度展示三处修正**：`utilization` 本就是 0–100 百分数（勿再 ×100）；`seven_day_opus`/`seven_day_sonnet` 各自 1:1 映射；重置倒计时 ≥24h 显示天级。坑：该端点未文档化，再现整页 100% 先核字段量级。

### 2026-06-03

- **litellm-parity 收官（P9，纯文档）**：parity 计分卡——OpenAI Chat 95 / Anthropic 90 / Responses 90 / Gemini 88。关键策略写入 docs：n>1 reject-clean（单候选后端 cap 到 1 + 警告）、provider_raw 透传清单（无损、绝不上 wire）、能力门控多模态（capabilities.yaml `modalities`）。
- **litellm-parity P2–P6**：四协议采样旋钮/usage 明细（reasoning/cache/逐模态）/finish_reason 两向枚举补齐；P6 reasoning 统一桥（`protocol/reasoning.ts`，thinking 块 ↔ 扁平 reasoning_content 互桥）。铁律：finish_reason 原值留 `provider_raw.stop_reason`，无法映射的数据进 provider_raw，绝不发明字段。
- **P8 互译加固 + 4×4 矩阵**：新增 `protocol-guards.ts`——REJECT-CLEAN cap（n_capped）+ DATA-LOSS guard，告警写 `provider_raw.warnings`（IR 内部，不上 wire）；拍板选 warnings 不 throw。矩阵扩到 4 协议 16 路（含 self 恒等），剩余 gap 文档化为 todo（responses 出站 multimodal/json-schema）。
- **P7 多模态 I/O 全量**：关键发现——OpenAI native content part（image_url/input_audio/file）不是合法 IR 判别值，"identity" 路径会让真实请求 Zod 失败；新增 `nativePartToIR`/`irPartToNative` 双向归一化。Gemini inlineData 按 MIME 路由 + fileData/videoMetadata；capabilities 加 `modalities`，filter 加 `no_{audio,video,document}_support`。
- **Providers 页 per-account usage/quota/priority**（#38）：额度源不对称——Claude=PULL（5min 缓存 + 代理）、Codex=PUSH（`x-codex-*` 头经 `onResponseMeta`）、Copilot 无源。usage 归因走 AsyncLocalStorage（只包同步 routeRequest）+ `servedByAccount` guard 防 fallback 误记（Codex P1）。新表 `oauth_usage`/`oauth_quota`（sqlite v12/pg v11），全 fail-open。限制：providers.yaml 静态声明的 OAuth provider 不被统计。
- **删 `openai-crs` relay**：premium/coding 改走 `openai-codex` 订阅（未连接时 fail-open 跳过），primary 改官方 DeepSeek（`DEEPSEEK_API_KEY`）。⚠️ `deepseek-v4-flash` 是 reasoning 模型，客户端 max_tokens 太小会空 content + finish_reason:length。TODO：核对 DeepSeek 官方定价。
- **请求列表默认 24h**：`DEFAULT_RANGE='24h'`，干净 URL = 24h，`?range=all` 显式。
- **请求列表 pager**：数字页码 + 每页行数（25/50/100/200）+ 全局 `cursor-pointer` 修复（按钮配方类）。
- **共享 `RangeFilter` 组件**：首页与列表页共用预设按钮行；`today` 不再是 UI 选项（旧书签仍解析）。
- **首页 Recent requests 行可点击**：与列表页同行为/同 token；保持紧凑子集非全 14 列。
- **首页日期范围过滤**（1h/6h/24h/7d/30d/All）：窗口客户端解析（网关 TZ 无关）；stats 是 ≤200 行采样快照非精确聚合（TODO：如需精确加 /stats 端点）。
- **per-key 用量预算 + lane 降级**（取代已关闭的 PR #42 账户计费）：token-bucket 长窗口（`usage_budget_buckets`，sqlite v11/pg v10）+ `applyCaps` 复用 maxLane。离散维 `remaining < 1` 判超（防 30 天窗口微量回填）；默认 degrade 非 reject（产品目标=不中断）；四面全覆盖，流式管线顺带补 usage 尾成本回填。
- **Gemini 入站流式修复**：`transformStreamOut` 由累积全量快照改为真增量 delta（真实 Gemini SSE 是 delta，旧实现会让客户端文本翻倍）；tool-call 只在终端 chunk flush 一次。
- **OAuth pool 热加载**（#38）：`rebuildOAuthPool` 序列化重建（失败保旧池），所有 OAuth mutation await 后才返回；订阅别名 fail-closed 路由（只认 live `oauthAliases()` + pool，绝不落到 stale registry/defaultProvider）；rebuild 失败返回 503 `not_applied`（持久化成功但未应用）。
- **移除 per-key `max_lane`**：lane 大多无序（LANE_RANK 只排 3 个），`allowed_lanes` 白名单足以表达；DB 列破坏性 DROP（sqlite v10/pg v9）；创建对话框补 lane 复选框。i18n extract 是 additive，孤儿键用一次性脚本清。
- **Anthropic anti-ban + Codex slug 修复**（#38）：稳定 per-account Device ID（sha256(encKey+provider:account) 派生，跨请求跨重启不变，metadata.user_id）；Codex 持续 400 真因是**模型 slug 错**——ChatGPT 账户 Codex 后端只接受 `gpt-5.4`/`gpt-5.4-mini`/`gpt-5.5`，所有 `*-codex`/`*-pro`/`*-nano` 都 400。顺带移植 openclaw 的 Responses body/header。
- **LIVE 验证三订阅**：Anthropic ✅、Copilot ✅（curated 列表部分过期）、Codex 当时 ❌（后证为 slug 问题）。确认无 Device-ID 轮换 bug（我们零 per-request 随机值）。live 套件修复分页读取（`list.json.items`）。

### 2026-06-02

- **统一 live 模型目录 + Codex 执行**（#38）：`effective-models.ts` 单一真相（network-free，读保存的 curation）；`modelAliases` 改 async thunk（curation 即改即见）；执行器结构化 OAuth 别名解析（`${name}/${model}` 且 providers.has(name) → pool client）；新增 `openai-responses` 执行器（Responses SSE → OpenAI chunks，stream-only 聚合非流式）；`chatgpt-account-id` 请求时从 JWT 解。
- **多账户 OAuth pool**：per-account settings 存 `config_kv` AES-256-GCM blob（不放 oauth_tokens.meta——refresh 会覆盖）；调度 priority asc + 同级 LRU 轮转，无可调度成员 fail-closed throw；per-account egress proxy（http/https ProxyAgent，socks5 经 `socks` 包 + undici 自定义 connector）；served-account 只进结构化日志不进遥测（telemetry 字段留作后续）。
- **API key 弹窗 Modal 化**：可复用 `Modal.svelte`（scrim 是真 button、Escape、body scroll lock）；`dismissible` 守卫一次性明文展示（必须点「I saved it」）。
- **修 #59 两个 Codex P1**：真实 Anthropic 流的 prompt usage 在 `message_start`（非 message_delta）——converter 改 Math.max 累积；tool-name round-trip 经 `toolNameMap` 还原原名（响应只带 sanitized 名，原注释错）。
- **Anthropic 协议全双向**（#59）：补 `transformRequestIn`（system/developer 按序折叠、tool_calls↔tool_use、图片双向、tool 名 sanitize）、native response/stream → IR、`output_format` JSON schema（镜像 LiteLLM filter 行为：剥 min/max 系列关键词进 description、内联 $ref）。14 个矩阵 fixture 翻绿。
- **Gemini 端点（取代 #39）**：core 半边已经由 #49/#51/#54 上 main，只移植 gateway 路由层（`gemini.ts` + pipeline gemini 分支：OpenAI chunk 直喂 transformStreamOut）；不应用 #39 里会回退 OAuth 接线的 server.ts 改动。
- **OpenAI + Gemini 错误信封**（#51）：`openai-error.ts` 是全代码库 canonical OpenAI 错误形（gateway onError 同源 import，防漂移；trace_id 有意上 wire）；gemini 用 `google.rpc.Status`。矩阵 error 维度明确是 target-renderer 检查。
- **`developer` role 一等公民**（#50）：IR enum 加 developer；OpenAI identity 直通；Gemini/Anthropic（provider 层）把 system+developer **按消息序**折叠进 systemInstruction/system。
- **交互式 OAuth 登录**（#38）：Claude 手动粘贴 + Copilot device-code + Codex，全走 admin web UI（无 CLI）；refresh token AES-256-GCM 加密存 `oauth_tokens`（`HELM_OAUTH_ENC_KEY`，sqlite v9/pg v8）；openclaw（MIT）流程自包含重写 + 头部注明出处；native Anthropic 执行器带 Claude-Code 身份 spoof；401 → refresh → 首 chunk 前单次重放。
- **OAuth subscription providers（非交互刷新半边）**：`TokenManager` 懒刷新 + 单飞锁；providers 二选一 refine `{api_key_env, oauth}`；401 单次重试在客户端层；token 缓存 in-memory（D3 已知限制，后被 preset 持久化关闭）。
- **分类器关键词扩表**：扩表会稀释信号（hits/ceil(len/2)），需重校准——正权重抬、**负权重放大**（最反直觉的是负向表）；`task_keywords` 是裸子串匹配，新词必须 distinctive/多词（`tone` 命中 milestones、`rce` 命中 source 的教训）。38/38 golden 全中。
- **多语言守卫**：CJK 词边界修复（lookaround 只在非 CJK 词字符边缘发射，否则 CJK 关键词永不可匹配）；`nonLatinRatio ≥ 0.3` 且无非 ambient 正向命中 → confidence=0 强制 uncertain。运营契约：非英语流量请开 Layer-2 eval（关则确定性落 balanced）。
- **Memory inject + reflector 接线**（#36）：memory_jobs 队列契约 + `claimPendingJobs`（sqlite RETURNING / pg SKIP LOCKED）；`startMemoryWorker` 仿 signal-scheduler；`injectIntoIR` 持 D7 纯文本闸；scope_id 用 canonical JSON 编码；worker env-gated（`HELM_MEMORY_WORKER_DISABLED`）。

### 2026-06-01

- **`/v1/responses` SSE 流式**：`responses-stream.ts` 第二台 IR→SSE 状态机；sequence_number 从 0、created/in_progress 无条件发、usage 只在 completed flush、错误帧直写流内（无法 throw→onError）。坑：改 core exports 后 e2e 需 rebuild core。
- **admin 请求分页 + 过滤**：`RequestsQuerySchema` 全字段 `.catch(default)` fail-open + pageSize clamp；`queryPage` 端口返回 `{rows,total}`（同 WHERE 的二次 count）；JSON-path 过滤分方言（sqlite json_extract / pg jsonb）；offset 分页；filters 进 URL。
- **密钥可编辑**：`updateKey` 部分 PATCH 语义（present=写/absent=不动/null=清除）推广到全部 caps；**role 保持不可变**（提权须吊销重铸）；统一 Edit 弹窗替代行内编辑。
- **Lanes 编辑器支持 lane 作链目标**：`laneNames` prop（排除自身）；不做 UI 侧环检测——`expandChain` 的 visited 守卫已中和深层环。
- **Docker 注入构建信息**：`HELM_VERSION/GIT_SHA/BUILT_AT` build-args→ENV（CI 传值并断言 /version）；版本 0.0.0→0.1.0；repo 转公开让 star 数显示。
- **admin 头部状态簇**：健康 30s 轮询 fail-open 三态；GitHub stars 客户端取 + localStorage 6h 缓存 fail-silent；version=unknown 时藏 pill。
- **stream-only 测试对齐**：6 个陈旧测试改流式发送/换 landing 模型（纯测试修复，运行时行为本来就对）。
- **0.1 发布文档审计**：README 英文化 + zh-CN 版；docs/01–11 对照代码修正 11 处差异（Gemini 未挂载、Responses 当时非流式、observe 已接 inject 未接、4 档复杂度塌 3 档等）；本文件历史条目保留中文。
- **stream-only 能力门**：`requiresStreaming`（`.optional()` 不用 `.default` 防类型波及）+ 第 6 门 `no_nonstream_support`——必然失败的一跳变成干净跳过，防非流式流量把熔断打 OPEN 误伤流式。坑：持久化遥测跨重部署残留旧 schema 行，排查须按容器启动时间过滤。
- **成本 $0.0000 三连修**：① 主因是显示截断（toFixed(4) 吃掉 <$0.0001，新 `formatUsd` 自适应有效位）；② 流式回填被 capture_payloads 开关挟持（解除：始终累积 chunk 解析 usage，开关只管持久化）；③ 新增 `resolveCostUsd` 统一「上游 billed 优先，否则 catalog 估算」。
- **per-attempt `error_detail`**：失败尝试记 `{upstream_status, message, provider_raw}`（镜像 HelmError 脱敏形 + 递归 redact 纵深防御）；`.default(null)` 旧记录零迁移；前向不追溯。
- **JSON 树形查看器**：`JsonTree`/`JsonViewer`（树/格式化/原始三标签）重写 llm-router 行为；惰性渲染 + 分页 + 截断；非法 JSON fail-soft 原样展示。
- **策略下拉缺 `security`**：admin 侧枚举副本与 shared `TaskTypeSchema` 漂移（admin 不能 import shared）；契约测试钉死 10 项全集兜底（TODO：代码生成根除手抄）。
- **per-key 速率限制 + 系统默认**：override 顺着 auth identity 走 probe（零额外读）；null=继承系统默认、0=显式无限；`rate_limit_default_*` 运行时可改即生效；messages/responses 面补齐（Codex review）。坑：多 worktree 并发 rebase 冲掉共享检出的未提交改动——务必独立 worktree。
- **请求列表行点击 + 时间/ID 列**：时间戳经 `RecentDecisionRecord{record, createdAt}` 配对透出（不塞进脱敏 DecisionRecord）。
- **规则维度折叠 + 根 dev 脚本**：`pnpm dev` = admin-only（gateway 无 dev 入口，devx 偏离已记录）。
- **分类器车道校准**（修「全落 balanced」）：根因=置信度死区（边界挤 + 信号衰减，standard 带内永远到不了阈值）→ 100% fallback；附带修裸 `includes()` 子串假命中（改词边界匹配）。校准：权重拉开、边界重置 `{-0.06,0.30,0.85}`、k=12、阈值 0.42；29/29 golden；新增 `cascade-gate.test.ts` 回归守卫 + 签入 `scripts/calibrate-classifier.ts` 调参工具。旧测试盲区：golden 测试把 decided_by 硬编码 rules，从没验证级联真能到达 rules。
- **完整正文记录 + 系统设置页**：用户拍板删「私有 payload 禁条」；`request_payloads` 独立表（capture_payloads 默认开、retention 机会式 prune）；`stream_options.include_usage` 注入否则流式无 usage 尾帧；DecisionRecord 仍走 redact（纵深防御）；运行时设置 fail-open 读 / fail-closed 写。

### 2026-05-31（中后期：审计、UX、校准前置）

- **全模块审计 41 项修复**（workflow 驱动）：非 chat 端面拉齐 chat.ts（400 信封/PipelineError/限流）；`UpstreamError.upstreamStatus`、`:free` 429 跳过；流式 usage 缓存扣减防双计费；key caps 第二道 applyCaps + policy cap 累积；PG 限流防双花、root-key bootstrap await、basicAuth 定长比较等。
- **Admin UX overhaul**：Tailwind v3→v4 + `@theme` 语义 token 层 + `@layer components` 配方类；8 页面去硬编码色阶 + 裸 schema 词汇改大白话。**重大坑：Workflow 子 agent 的文件写入不持久化**（异步清理会回滚未提交文件）——写盘必须主会话直接做，或事后从 transcript 重放 + 立即 commit；Workflow 只适合并行只读分析。
- **Lanes combobox**：`GET /admin/api/models` 别名目录 + `<input list>`+`<datalist>`（保留手敲逃生口，目录失败退化纯文本输入）。
- **eval-v2 Phase 2**：新 task_type `security` 需四文件 lockstep（taskdetect union / classifier.yaml / TaskTypeSchema / eval prompt 枚举）；activation 2.0 防单关键词误报；security 只在 complex 钉 premium（无 min_lane 用 complexity 条件化代替 floor）；long_context 阈值 64000。
- **catalog-reuse**：中继模型 capability/pricing 从 generated catalog 迁到 `capabilities.yaml`/`pricing.yaml` 覆盖层（generated 恢复纯 sync 产物，否则下次 sync 静默抹掉）；eval 模型改 relay 真实存在的 `deepseek-flash` + 裸 key 计价；mock 改用 eval 系统提示词标记识别。
- **fix-upstream-model-id（推翻 config-align）**：alias（routing key）≠ provider_model（wire id）——relay 只认裸 id，带前缀 500。catalog/cost/breaker 一律按 alias 取键，wire 发裸 id。坑：relay 的 gpt-5.x 仅支持流式。
- **live integration sweep**：新增 `scripts/integration-live.mjs`（42 项真容器套件）；畸形 JSON/空 messages → 400 fail-closed（OpenAI + Anthropic 双面）；classifier PUT 改 strict schema（防错形状 patch 静默覆盖）；`/v1/responses` 路由首次接线（当时仅非流式）；eval 三条 fail-open 路径实测；Supabase 全套等价验证。
- **config-align**：统一 `provider/model` 别名命名空间让能力过滤+成本在默认配置点火（`*/auto` 标 json-incapable 被剪）；后被 fix-upstream-model-id 修正 alias==provider_model 部分。
- **cost-wire**：`computeCostUsd`/`usageFromBody`（per-MTok）；缺 pricing → null（「未测量」≠ 0）；inline billed cost 优先于换算；`routing_usd` 不入 schema（恒 0 无独立计费源）。
- **capability-wire**：`loadRuntimeCatalog` fail-closed 加载 generated+overrides；链耗尽错误三分——空链 `lane_unavailable`(503) / 纯能力剪除 `capability_unsatisfiable`(422) / 其余 `all_providers_failed`(502)；熔断跳过不算能力缺口。
- **providers-multi**：统一 `ProviderConfigSchema`（name/alias 二选一 + `models[]` 默认 []）；executor 按 providerName 选 client（跨 provider fallback）；缺凭证 secondary 启动期跳过（primary 缺则 fatal）。
- **momentum-wire**：momentum store 进程级单例注入 classify deps（配置 live 读热生效）；TODO：动量信号未透出 DecisionRecord；in-memory store 多实例/重启即丢（fail-open）。
- **修合并后 typecheck**：两类陈旧 fixture——`z.input` vs `z.output`（default 字段输入可选输出必填）错配、eval 成本字段下沉未跟。生产代码无误。
- **CI 真 Docker job**：独立 docker job（与 verify 并列无 needs）build + run + /healthz 轮询 + 清理。
- **admin.requests-richfields**：`key_prefix`/`latency_total_ms`/`fallback_count`/`cost_breakdown` 做成真字段（`.default`/`.prefault` 兼容旧记录）；fallback_count = 非 skipped attempts − 1（执行兜底，与分类 decided_by 严格分开）；key_prefix 不命中 redact 正则（有测试钉死）。
- **admin.classifier-hotapply**：classify 适配器改每请求 `getClassifierConfig()` getter + 配置指纹（JSON.stringify）变即重建 eval 缓存——admin PUT 即生效且绝不服务陈旧裁决。
- **store.supabase**：postgres 适配器全 6 端口 + `createStore` 驱动工厂（未知驱动/缺 DSN fail-closed）+ PGlite 真 Postgres 契约测试（`describe.each`）。坑：pg wire 协议禁止一个 prepared statement 多命令，迁移按 `;` 切分逐条执行。连接串经 `url_env` 引用绝不明文。
- **gateway.session-key**：`x-session-key` → `metadata.conversation_id`（body 显式值优先）；头不进日志。
- **classifier.confidence-fix**：置信度归一化 `2·sigmoid(k·d)−1` 落域 [0,1)（旧式恒 ≥0.5，默认阈值 0.45 永不触发）——eval 级联在签入默认下真正可达；e2e 移除阈值头 workaround。
- **config.load-rules**：lane/policy schema 迁 `@helm/shared`（core 纯 re-export）；loader 接 `lanes.yaml`/`policies.yaml`（fail-closed）；默认 lanes（economy/balanced/premium + coding/json/vision/tool_use）+ 3 条样例 policy 签入。
- **signals.feedback**：`RoutingSignal` 聚合——`fallbackRate`（执行兜底）与 `classifierFallbackRate`（分类兜底）分列绝不混淆；零主路径延迟用「chat.ts 源码不出现 signal 符号」结构化守卫测试钉死；后台 60s 调度 fail-open；幂等聚合（PK + upsert）。
- **ratelimit.full**：配置在 `runtime.rate_limit`（+overrides）；fail-closed 语义（store 抛错 5xx 不放行）；RPM 先扣的预扣偏差可接受；TPM 估算后续接（当时 0）。
- **memory.observe**：`IRToolResult` = `IRMessage` 别名；system→user 角色折叠落库；threadId null 跳过 no-op；observe 不注入不 hydrate。
- **gemini.protocol**：`endPoint` 沿用字符串字段 + `parseGeminiPath` 纯函数解析操作后缀；流式 tool args **末尾整体 flush**（快照流的 JSON.stringify 非前缀增长，逐片拼会产半截 JSON）；`sanitizeSchema` 做成协议无关横切。

### 2026-05-31（前期：admin/e2e/eval/protocol/classifier/registry 任务群）

- **e2e.admin**：`HELM_ADMIN_ENABLED` env 开关；列表改返回完整（已脱敏）DecisionRecord；Playwright httpCredentials 会自动补凭证掩盖 401——noauth 用例单独 project。
- **admin 四视图（requests/keys/policies/lanes-ui）**：admin 类型自持不 import core/shared（HTTP 边界映射真实后端形状，缺失字段派生或安全默认绝不伪造）；key 明文一次性 + 关闭即焚（DOM 级断言）；complexity 枚举以服务端 schema 为准（simple|medium|complex）；admin 测试链版本对齐（vitest 3 + vite 7 + plugin v6 是唯一可行组合）；PolicyRow「点击即激活」双 select；LaneEditor `untrack` 播种本地 state。
- **admin.api**：rule 配置走运行时 RuleStore（非 YAML 写回）；key 不回显（list 投影 KeySummary、POST 仅一次返回明文）；basicAuth 由 caller 在 server.ts 挂。
- **admin.scaffold**：当时 Tailwind v3（后升 v4）；tsconfig 继承 `.svelte-kit/tsconfig.json`（SvelteKit 硬约束）；check 前置 `svelte-kit sync`。
- **e2e.eval**：`buildClassifyAdapter` 把 cascade/eval cache/resolveLane 组装接进网关（此前 eval 模块是死代码）；决策可观测面 = `x-helm-decided-by`/`x-helm-eval-cache-hit`/`x-helm-fallback-reason` 响应头；`x-helm-eval`/`x-helm-rules-threshold` e2e 头（HELM_E2E gated）。
- **eval.cascade/cache/config**：cascade 注入理想化 `resolveLane` 签名（不感知 LaneDecision）；缓存键 turn_count=user 条数、只缓存 decided:true（瞬时故障不钉 300s）、Map 插入序 LRU；eval config 用 `z.literal` 锁死 temperature/on_failure/cache.key + 双超时（outer>inner refine）。
- **e2e.protocol + gateway.anthropic-route + protocol.anthropic-stream + protocol.responses**：`messages-pipeline.ts` 桥接 IR→route()→OpenAI body/SSE→Anthropic transformer；auth 中间件收窄到 `/v1/chat/*`（messages 路由内自鉴权出 Anthropic 信封）；流式状态机 tool-block start **延迟到首参数分片**（settle-before-emit，对外 id 恒等于最终真 id）；`synthesizeSSEFromJSON` 复用主状态机防两路漂移；responses transformer 用对象字面量（codebase 约定）+ reasoning item 剥 status 存 provider_raw。
- **e2e.routing + 收尾**：`x-helm-lane`/`x-helm-final-model`/`x-helm-provider-model` 调试头；execute 改发 resolved providerModel；mock 用提示词哨兵注错；空白消息触发分类兜底（decided_by=default→balanced）；4 个陈旧 core 测试 fixture 修正（makeHelmError 工厂/vi.fn 显式签名/noUncheckedIndexedAccess 解构）。
- **telemetry.decision-full**：`trace_id` 必填（= request_id，不另立第二个 id）；`persistDecision` fail-open（最坏丢一条记录不 5xx）；`buildDecisionRecord` 整条过 redact 作离开 core 前最后一道闸。
- **routing.pipeline**：`routeRequest` 框架无关全依赖注入；classifier 4 档与路由 3 档复杂度在网关适配器映射（standard→medium、reasoning→complex）；流式执行兜底 = peek 首 chunk（前抛错记熔断、拿到即成功，不缓冲整流）；abort 非 provider 故障。
- **classifier.engine/overrides/tiers**：momentum 应用时抑制 `short_message` 捷径（否则动量的存在意义被弱捷径钉回）；`set` 绝对压过 `floor`（精确信号 > 弱下限）；多 floor 取最高；心跳用整条等值判定非子串；tiers 的 sigmoid 公式与 0.45 阈值矛盾当时如实记录（后由 confidence-fix 解决）。
- **provider.registry**：registry ProviderConfig 与 shared 命名分歧刻意保留（后由 providers-multi 统一）；unknown alias 走 Result 不抛、duplicate alias 建期抛 `RegistryBuildError`；结果只含 env 名无明文。

### 2026-05-30（Phase 0 与初始决策）

- **catalog.sync**：构建期脚本读 LiteLLM 快照→签入 generated catalog；定价 per-token→per-MTok（×1e6 + round 去 IEEE 误差）；手动覆盖逐字段 WIN 且可新增 modelKey；ralph-dev index.json 数组→对象格式修复（CLI 0.5.0 兼容）。
- **Phase 0 实现**：`buildServer()` 收口启动接线（loadConfig→sqlite→bootstrapRootKey→client→app）；Dockerfile/compose 契约用静态断言测试钉死（当时无 Docker，后由 CI docker job 补真烟测）；better-sqlite3 原生编译坑（onlyBuiltDependencies + vitest `deps.external`）；config 样例对齐真实 schema（非 task 草稿字段名）；`ApiKeyRecordSchema` 自行补位（spec 缺口，无明文字段）；Zod v4 API 调整（record 双参、looseObject、z.url、z.core.$ZodIssue）；e2e 用 Playwright request fixture + mock 上游双 webServer。TODO（仍开放）：auth 中间件 401 返回裸 HelmError 形与 OpenAI 信封不一致。
- **初始技术决策**：Hono（headless、streamSSE）非 SvelteKit SSR；admin = SvelteKit adapter-static 由 Hono `/admin` 托管；Store 端口 + sqlite/supabase 适配器 + Drizzle；Biome（TS）+ Prettier/svelte-check（admin)；capabilities/pricing 数据源 = LiteLLM 同步 + 手动覆盖、不在运行时拉取；provider 执行层重写移植 llm-router 语义不抄代码；eval 缓存键 = sha256(canonical-json) 五字段。
