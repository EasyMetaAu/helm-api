# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-07-06 · 请求总超时必须驱动下游 abort 与失败 telemetry（Gateway runtime / telemetry，docs/02/07，原则 3/5/7）

- **背景（Lukin）**：生产 `gpt-5.5` 长请求超过 Helm `request_timeout_ms` 后，客户端收到 504，但上游 provider 后续完成，Telemetry 仍把 `final_status` 记成 `ok`，导致日志和 Admin requests 不能反映客户端真实结果。
- **语义决策**：Gateway 总超时是**客户端可见的终态**；一旦触发，后续即使 provider 晚完成，也不能把该 request 记录为成功。持久化前把 `DecisionRecord.final.status` 规范成 `error`、`error_reason: "timeout"`，同时 `serving_account` 清空。Provider attempt 仍保留原始上游事实（例如 late `ok` / cost），避免把“上游后来完成”伪造成 provider failure。
- **执行决策**：timeout 中间件在 Hono context 上挂一个 request state：`timedOut` 与 `AbortSignal.any([client, timeout])`。各路由的 provider/pipeline/concurrency 调用使用这个统一 signal，尽量在 Helm 超时时停止下游；真实客户端断开判断仍只看原始 client signal，避免把 Helm timeout 当成用户主动取消。
- **payload 决策**：如果请求已经 timeout，`request_payloads.response_json` 写 `null`，因为客户端实际收到的是 504，不是晚到的 provider response。`upstream_request_json` 可继续保留，便于追查发给上游的请求。
- **覆盖面**：OpenAI Chat 的自有 persist 路径和 `recordServed` 共享路径都覆盖；Messages / Responses / Gemini / Images / Interactions 都传入 request timeout state，防止协议面漂移。
- **验证路径**：新增 timeout context 与 late-success telemetry 测试；覆盖 app/limits/chat/messages/responses/gemini/images/interactions/payload-capture targeted tests，并跑 gateway typecheck。

## 2026-07-06 · API key 绝对模型黑名单（Key governance / routing / Admin keys，docs/04/06/11，原则 5/6/7）

- **背景（Lukin）**：每个 API key 需要能禁止若干具体模型，语义是“这个用户无论通过 direct model、显式 lane、auto/classified lane、alias-to-lane 还是 execution fallback，都不能实际用到这些模型”。
- **产品边界**：`blocked_models` 是具体模型 denylist，不是 lane denylist。请求若直接点名被禁的具体模型，立即返回结构化 `invalid_request`；请求若点名 lane 或走自动路由，则在执行前从 expanded candidate chain 中剥离被禁模型，fallback 会自然跳过它们。Chat/Messages/Responses/Gemini 走 `routeRequest`，Images/Interactions 入口在各自 image chain 执行前应用同一过滤。
- **空链处理**：如果某个 lane 的所有候选都被当前 key 的 `blocked_models` 剥空，路由阶段直接返回 `invalid_request`，不进入 provider executor，也不把它伪装成 provider failure。Routing signal feedback 也会跳过被黑名单剥空的提升目标，避免把本来可用的 lane 误提升成拒绝。
- **匹配语义**：`blocked_models` 每项先 `trim`，匹配时大小写不敏感；普通文本是精确模型 ID，包含 `*` 或 `?` 时按 glob 处理（`*` 任意长度，`?` 单个字符，正则特殊字符按字面量）。不按 provider 前缀隐式扩展；`auto`、空模型、lane 名本身不会作为模型命中，lane 内的具体模型 alias 会被过滤。
- **数据与迁移**：API key schema 增加 nullable `blocked_models`；create/update 支持设置与清空。SQLite v38 用 JSON text，Postgres v37 用 JSONB；两个 store adapter 都做 round-trip，并保持旧 row 默认 `null`。
- **可见性与 UI**：`/v1/models` 会按当前 key 隐藏被 block 的 concrete alias；若某 lane 过滤后没有任何可用候选，该 lane 也不展示。Admin keys 的共享 caps form 始终展示多行 `Blocked models` 输入，独立于 `allow_custom_model`，支持换行、逗号、分号分隔并去重。
- **验证路径**：覆盖 shared schema、direct reject、classified/explicit/alias lane chain filtering、routing signal 提升过滤、空链拒绝、models list 过滤、SQLite/Postgres store contract、gateway auth/admin/chat/messages/replay/models threading，以及 admin create/edit/list 表单映射。

## 2026-07-06 · Anthropic native passthrough 稳定 Claude Code billing cch（Provider execution / prompt cache，docs/04/05，原则 3/5/7/8）

- **背景（Lukin）**：线上 `claude-fable-5` 请求大多是 Anthropic native passthrough，理论上应保留 Claude Code 原始 body；但 production SQLite 样本显示同一会话里 `system[0]` 的 `x-anthropic-billing-header` 只有 `cch` 每轮变化（`cc_version`/`cc_entrypoint` 稳定），导致 Anthropic prompt cache 的严格前缀匹配被第一块内容打断，缓存读取只覆盖小前缀，成本显著偏高。
- **问题归属**：这不是 Helm 协议转换 correctness bug；原样转发本身成立。这里是对 Claude Code 官方 billing header 与 Anthropic prompt cache 机制冲突的兼容性 workaround：为了自托管网关的成本边界，允许 native passthrough 做一个可审计的最小 body shim。
- **修复边界**：只在 `protocol === anthropic_messages` 且 `system[0]` 明确是 `x-anthropic-billing-header`、含 5 位 hex `cch` 时触发；保留 `cc_version`、`cc_entrypoint`、system/messages/tools 正文和 cache_control，仅把 `cch` 替换成由稳定 cache-prefix 材料（resolved model、system、tools，排除 messages）计算出的 5 位值。没有该 header 的 native 请求完全不变。
- **观测决策**：触发时写入 passthrough mutation `body_shims_applied: ["anthropic_billing_cch_stabilized"]`，并清掉 raw_body 走重序列化，避免 telemetry 显示仍是旧的客户端 raw body。后续线上可按该 mutation 与 `cached_tokens/cache_creation_tokens` 验证成本改善。
- **风险边界**：如果 Anthropic 将来开始强校验官方 `cch` 与整请求字节一致，这个 shim 可能引发上游拒绝；届时可通过 native passthrough flag 或后续 runtime setting 回滚。当前生产证据显示 `cch` 更像缓存/归因指纹而非认证字段。

## 2026-07-06 · Admin 请求列表模型关键词搜索改走预计算列（Admin requests performance，docs/07/11，原则 1/7）

- **背景（Lukin）**：线上 `/admin/api/requests?...&model=fable&key_id=...` 首字节约 5.26s。生产 SQLite 虽能用 `(api_key_id, created_at)` 索引把范围缩到当天该 key 的 7922 行，但 `model` 筛选仍要对每行 `decision_json` 做 `requested_model` / `final.model_alias` JSON 提取和 LIKE，`COUNT` 单独就约 2.36s。
- **查询决策**：保持 `model=` 的既有语义（substring 匹配 requested model、served alias、selected lane；大小写不敏感），新增生成列 `model_search`：把三段文本 lower 后拼成一个小搜索面。SQLite 用 VIRTUAL generated column，Postgres 用 STORED generated column。
- **索引决策**：新增 `idx_telemetry_admin_model_window(created_at, model_search)` 与 `idx_telemetry_admin_key_model_window(api_key_id, created_at, model_search)`，让 admin 列表和计数扫描小索引值，不再为候选行反复解析 JSON。
- **保持不变**：不改 API 参数、不改 UI、不改 payload/telemetry retention；`payload_retention_days` 继续保持 3 天。
- **验证计划**：覆盖 SQLite/Postgres 迁移、SQLite telemetry 查询、跨 adapter store contract；发布后用同一线上 URL 比较 TTFB/total，并确认 `EXPLAIN QUERY PLAN` 使用新索引。

## 2026-07-06 · Admin 请求详情 payload 改为分段懒加载（Admin requests performance，docs/07/11，原则 1/7）

- **背景（Lukin）**：线上 `/admin/requests/:traceId` 详情页会在首屏同时拉完整 request/response/upstream payload；部分记录超过 1MB，经公网和未压缩 JSON 传输后容易出现长时间白屏/卡顿。
- **接口决策**：保留原 `/admin/api/requests/:traceId/payload` 全量兼容；新增 `?part=meta` 只返回捕获状态与三个分段是否存在，`?part=request|response|upstream_request` 只返回单段正文。SQLite/Postgres adapter 实现轻量读取，老 adapter 通过 `getPayload()` fallback。
- **UI 决策**：详情页 loader 只取 meta；Conversation/Raw/Response/Forwarded upstream/Retry 在用户点击时才按需取对应分段。这样列表到详情的首屏不再被大 payload 阻塞，同时保留完整审计正文查看能力。
- **memory stats 决策**：`/admin/api/memory/stats` 增加 10 秒按 scope 短缓存；管理员写入/编辑/删除 facts/reflections 后清缓存，避免重复刷新扫统计表。返回语义不变。
- **保留策略**：`payload_retention_days` 继续保持 **3 天**；本次不把它降到 1 天（Lukin 明确要求）。
- **验证计划**：覆盖 gateway payload meta/part、SQLite/Postgres store contract、admin loader 懒加载 UI、memory stats cache；发布后用线上 API timing、gzip 响应头和浏览器网络请求确认。

## 2026-07-06 · 纯工具 turn 去掉空 header 行 + peek 收到 3 行（Admin conversation view，docs/11，原则 1）

- **背景（Lukin）**：默认展开后，纯工具 turn 在工具块上方还多渲染一条近乎空的折叠 header 行（`▾ ● { }`：caret+role dot+空 preview+源码切换），很丑；另外 output peek 6 行太多。
- **改动 1（删空 header）**：`ConversationTurn.svelte` 把折叠 header 行包在 `{#if !toolOnly}` 里——纯工具 turn 不再渲染它，工具块自己的 `● Name(args) ✓ ok` 行就是整条 row。把 per-turn 的 `{ }` view-source 切换挪到**第一个工具部分**那一行右侧（hover 显现，`toolOnly && firstToolPart === i` 只出现一次，不逐行重复）；非纯工具 turn 仍用原 header 里的 `{ }`（不重复）。`toolOnly`/`firstToolPart` 改 `$derived`，`open` 初值用 `untrack(() => isToolOnly(turn))` 消除 `state_referenced_locally` 警告。
- **改动 2（peek 3 行）**：加 `PEEK_LINES = 3` 常量，两处 `toolOutputPeek(part.output, PEEK_LINES)` 传入（`toolOutputPeek` 默认仍 6，只在组件里收窄）。
- **测试**：更新「peek」用例断言 3 行可见、第 4 行隐藏、`+5`（8 行输入）；新增「纯工具 turn 无 `conversation-row-toggle`，但 `conversation-source-toggle` 在工具行上」。97 conversation/render 测试绿、svelte-check 0/0/0。full-run 里 `requests.test.ts` 2 红是并发 PGlite flake（隔离跑 40/40 绿，非本次改动，见 [[pnpm-test-pglite-flake]]）。
- **共享树坑（记）**：切回 main 时发现工作树带着 sibling session（Codex `codex/admin-perf-lazy-payload`）未提交的 `packages/core/src/store/*telemetry.ts` WIP——**没碰它**，直接开隔离 worktree（干净 checkout，不含 sibling 文件）。参见 [[git-add-explicit-not-all-shared-tree]]。
- **发布**：v0.25.10。worktree `worktree-tool-row-cleaner`。

## 2026-07-06 · 纯工具 turn 默认展开，去掉多一次点击（Admin conversation view，docs/11，原则 1）

- **背景（Lukin）**：终端风格上线后，看一个工具的 output peek 要点**两次**——先点行展开 turn（row-toggle），再点 `… +N lines` 出完整 JSON。第一层折叠对「整条 turn 就是一个工具调用」的行是纯多余摩擦。Lukin 要求参考 Claude Code：peek 直接可见，不用先展开。
- **确认方向（AskUserQuestion）**：**纯工具 turn 默认展开**（peek 直接显示），文本/混合 turn 仍默认折叠（保持长 trace 可扫）。
- **实现**：`ConversationTurn.svelte` 加 `isToolOnly(turn)`（parts 非空且全为 `tool_exchange`/`tool_result`/`tool_call`）；`let open = $state(isToolOnly(turn))`。用**具名函数**在 initializer 里读 `turn`（避免 Svelte `state_referenced_locally` 警告——turn 不会原地变，mount 时算一次即可）。展开态 header/peek 逻辑不变；点 `+N lines` 仍出完整 JsonViewer（第二层保留）。`expandCommand`（全部展开/收起）照常覆盖。
- **测试更新**：3 个旧断言「tool turn 默认 collapsed / 需点击」翻转为默认 `data-open==='true'` + peek 无点击可见；新增「混合（text+tool）turn 仍 collapsed」用例。670 admin 单测绿、`ConversationTurn.svelte` svelte-check 0 warning。
- **可视验证坑（记）**：本 session 的 worktree 里有自动清理会**反复删掉未追踪的临时文件**（`/tmp/*.json`、`static/*` payload、`harness-data.json` 每次命令后消失），静态 harness 走不通；改用 live box 部署后截图验证（部署产物不被清理）。
- **发布轨迹**：终端风格 = v0.25.8（PR #474）；本次默认展开为 v0.25.9。**worktree `worktree-tool-turn-auto-expand`**。

## 2026-07-06 · 对话视图工具执行改为 Claude-Code 终端风格（inline peek，Admin requests / conversation view，docs/11，原则 1）

- **背景（Lukin）**：原展开态工具块是重边框卡片（🔧 Tool ✓ ok + 两个 bordered JsonViewer 面板 Arguments/Result），boxy、不看展开就不知道工具做了什么。Lukin 给了 Claude Code 终端 transcript 截图，要求参考它做得更清晰。
- **确认方向**：展开态 tool block 采用 CC 的 inline peek；**整个 timeline** 转成 borderless dot+indent 终端观感。折叠行 arg 预览（v0.25.7）保持不动。
- **新纯函数**：`conversation.ts` 加 `toolOutputPeek(output, maxLines=6) → {lines, moreLines}`：output 归一成文本（字符串原样；JSON 串/对象/数组 → pretty JSON，与 JsonViewer 一致），split `\n`，剔尾部空行（防虚增 +N），截前 N 行报剩余数；纯、永不抛。`formatToolArgs` 加可选 `maxChars`（默认 72；展开态 header 传 160，`truncateDetail` 也接受 max）。
- **组件重构**（`ConversationTurn.svelte` 为主）：展开体去掉 `rounded-lg border bg-*-50` 卡片；每个 turn 用 role dot（`●`）+ 单条淡 spine。tool_exchange = 行1 `●` + mono 粗体 `Name`(`formatToolArgs(...,160)` args) + 复用 `exchangeStatus` 状态字形；行下 `toolOutputPeek` 前几行挂在 `│` 左规则里；footer `… +N lines (click to expand)`（无更多行时 `⋯ view details`）——点开才 inline 挂**完整** JsonViewer（args+result，逃生舱不丢）+ `▾ Collapse`。reasoning 去紫盒改 `🧠` + muted 左规则文本。per-tool 展开用 `toolOpen: Set<number>`，各行独立。
- **testid 保留**（e2e 硬断言，见 [[e2e-admin-specs-live-in-gateway]]）：`conversation-turn/-tool/-reasoning/-row-toggle/-source-toggle/-source`、`data-open`、`data-turn-role` 全留；新增 `conversation-tool-toggle/-expand/-collapse`。只改样式+内部结构。
- **i18n**：新增 3 key `lines`/`click to expand`/`view details`，5 语手填（意译：点击展开/查看详情等），插在 `no result` 后（[[i18n-sync-incremental-empty-only]] / [[admin-test-i18n-gotchas]]）。
- **ponytail**：无新库无新组件，restyle + 1 纯 helper；peek 是 `split('\n').slice()`，非语法高亮（标 `// ponytail:`）；peek 行数 6 硬编码（配置化是投机，跳过）。
- **验证**：`toolOutputPeek`/`maxChars` 单测 + `Conversation.test.ts` 渲染契约（header `Bash(ls -la)` + peek `line1` + `+2` + 点开才出 Arguments/Result）；668 admin 单测绿、svelte-check 0 error。**真实数据可视验证**：临时 harness route 加载 box trace `2fb017ae` 全 743 turn 真 payload，Playwright 截图确认 `● Bash(ssh…) ✓ ok` + SQL 结果行 inline peek + `… +21 lines (click to expand)`，点开出完整 Tree/Formatted/Raw JsonViewer——与 CC 截图一致；harness 用后即删。**在 git worktree `worktree-cc-terminal-conversation` 开发（Lukin 要求不在 main 搞）。**

## 2026-07-06 · 折叠会话行显示工具调用参数预览（whitelist-free，Admin requests / conversation view，docs/11，原则 1）

- **背景（Lukin）**：请求详情「对话」视图里，assistant 的工具调用折叠行只显示 `Bash()` / `Read()` / `Write()` / `Agent()` 空括号——能看出调用了工具，却看不出具体参数。
- **关键修正（Lukin 明确指令「不要写白名单，所有工具都要」）**：第一版按大写工具名逐个 special-case（Bash/Read/Write/Agent/Task…），导致名单外的工具（如小写 `read()`、自定义 MCP 工具）仍然是盲括号——见截图 `read()`。**改为完全无白名单、纯按 args 形状泛化**：`formatToolArgs(_name, args)` **不看工具名**，从对象里挑最可读字段渲染，因此任何工具都有 detail。
- **选字段算法**：① 非对象参数（字符串/数字/数组）直接展示；② 对象：先按 `PREFERRED_KEYS` 排序挑首个 scalar 字段（顺序是**排序不是门禁**：`command`→`file_path`→`pattern`(先于 path)→`query`→`url`→`path`→短标签 `description`/`subject`/`summary`/`title`/`name`/`message`（**先于**大块 `prompt`/`content`/`text`/`input`）），命名外的对象仍回落到**第一个 scalar 字段**；③ 全是嵌套对象/数组 → 整体 compact JSON；④ 空对象 → 空串（裸 `Name()`）。参数可能是对象或原始 JSON 串，先 `coerceJson` 归一。72 字符硬截断带 `…`。
- **按字段（非按工具名）的轻润色**：`command` 字段做 `&&`/`;`/`||` 顶层切分成 `→` 链；`file_path`/`filePath` 且有 sibling `content` 字符串时追加字数 hint。因为 key 于字段，对任何携带该字段的工具都生效。
- **纯度/失败软化**：与整个 `conversation.ts` 一致——纯、永不抛，最坏返回 `''`；折叠行渲染不会因坏参数崩页。工具名完全不参与（连大小写都无关）。
- **UI 改动面**：仅 `ConversationTurn.svelte` 的 `preview` derived 一行 + import。展开视图、badges、size hint、状态字形全部不动。无新 i18n key。
- **ponytail 简化**：shell 切分是朴素顶层 split（非引号感知），引号内 `&&`/`;` 会过度切分——展示预览里无害（代码标 `// ponytail:`）。
- **验证**：`conversation.test.ts` 覆盖泛化契约（preferred 字段/未知工具/自定义 MCP 工具/大小写无关/命令链/字数 hint/排序不门禁/first-scalar 回退/数字布尔 scalar/纯嵌套→JSON/裸串数组/空对象/截断/null 软化）；`Conversation.test.ts` 保留真实 Anthropic `tool_use` 渲染契约。截图 `read(HEARTBEAT.md)`、`some_custom_mcp_tool(/v1/x)`、`weird_tool(3)` 均验证通过。svelte-check 0 error。
- **发布轨迹**：第一版（带白名单）= v0.25.6（PR #471，已发布并部署 box）。本次无白名单重写为后续版本。

## 2026-07-06 · 配额 PULL 的 100% 账号级窗口必须同步停车（OAuth provider pool / Admin providers，docs/04/11，原则 3/5/7）

- **背景（Lukin）**：Providers 页可以从 Codex/Anthropic usage PULL 看到账号级窗口已经 100% 并显示“已限流”，但后端只把该 PULL 当观测快照；如果 live traffic 没先触发 429/header PUSH 写入 `usageLimitedUntilMs`，OAuth pool 仍会继续选择这个账号。
- **调度决策**：`/admin/api/oauth/quota` 成功拉到账号级窗口 `usedPercent >= 100` 且有未来 reset 时，立即写入 `usageLimitedUntilMs` 并同步 live pool member；近满但未满（例如 98/99%）不主动停车，只在账号已经被真实 429 停车后用于修正恢复时间。
- **恢复边界**：干净窗口会继续清理已存在 cooldown；scoped model 窗口（如 Anthropic `7d-*`）仍不扩大成全账号停车。Codex reset credit 消费成功后通过现有刷新路径恢复窗口并清理 cooldown。
- **测试路径**：覆盖 `/oauth/quota` 从 Codex saturated PULL 新建 cooldown，以及 near-full PULL 不误停车；再跑 admin OAuth route focused tests、typecheck/lint/build。

## 历史条目摘要（最近 5 条）

- **2026-07-05 · OAuth 凭证失效持久化为 needs reconnect（OAuth provider pool / Admin providers，docs/04/11，原则 3/5/7）**：refresh/持久 upstream 400/401/403 标记 credential failure、写入账号设置并摘出调度，reconnect 成功后按手动/自动停车边界恢复。
- **2026-07-05 · 避免浪费策略纳入周额度与 Codex reset credits（OAuth provider pool / quota，docs/04/11，原则 3/5/7）**：`use_expiring` 汇总短窗口、周额度与 reset credits 软评分，quota PULL 会刷新 live pool snapshot 但不自动消费 credit。
- **2026-07-05 · Codex reset-credit 消费改为硬门禁（OAuth quota / Admin providers，docs/04/11，原则 3/5/7）**：手动/自动 reset credit 必须命中 weekly secondary 阈值与持久 guard，缺少 snapshot 时 fail-closed，避免烧稀缺额度。
- **2026-07-05 · OAuth 账号池支持可选额度使用策略（OAuth provider pool / routing / Admin providers，docs/04/11，原则 3/5/7）**：新增 balanced/manual_priority/low_risk/use_expiring 全局账号池策略，保持 previous_response_id 强亲和和 scoped quota 边界。
- **2026-07-04 · internal LLM prompt 输入用 XML 数据边界隔离（Memory / classifier eval，docs/03/08/12，原则 3/4/7）**：classifier eval 与 memory LLM 把可信任务和不可信消息放进 XML/JSON 数据区并 escape，防止用户内容突破数据边界。

## 更早历史总览

2026-07-04 更早条目还包括 cheap-model 当前轮低风险降级、视觉上下文压缩 observe/off 接入、Memory stats 队列索引优化、OAuth 会话亲和调度、idle-flush 碎片段优先压缩最大连续段、memory worker 受控并发追赶、记忆页只读运行状态面板、Claude scoped weekly quota 只影响对应模型、跨协议 reasoning-history 候选级跳过、memory idle-flush 防饥饿、策略级 reasoning_effort 覆盖 lane 默认值、cron monitor 低成本规则等。2026-06-30 及以前的工作主要围绕 Helm API 的协议面、路由执行、admin 可观测性与自托管部署逐步成型：补齐 Gemini/OpenAI/Anthropic/Responses 双向转换、SSE 流式正确性、tool-call/JSON schema/思考参数保真、per-model reasoning effort、模型别名与能力/成本目录、provider fallback 与熔断语义、OAuth subscription providers、多账户池与 quota 处理、memory observe/inject/forgetting/admin/MCP、请求 payload 捕获与 request detail UI、API key 治理、admin 表格/过滤/分页/i18n、Docker/CI/release/deploy 验证，以及早期 Phase 0 的 Hono + SvelteKit static admin + Store 端口 + SQLite/Supabase 架构决策。更早细节不再逐条保留在本文件；需要精确背景时回查 git history。
