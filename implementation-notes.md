# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 3 条**完整记录。新条目入栈时，把被挤出前三的条目压缩成一行要点（保留日期、标题、关键决定/坑/TODO），移入文末「历史条目摘要」。完整原文可经 git history 回溯。

---

## 2026-06-22 · Claude 订阅（OAuth）token 成本折算（docs/04/07；约定「能力与定价数据源」；原则 6）

- **问题**：admin 对 Claude Pro/Max 订阅（`anthropic/*` OAuth 池）流量只显示 token **数量**，花费恒为 `—`（null）。token 计数链路（解析→落库→聚合→渲染）对所有 provider 早已就绪，唯一缺口是 `config/pricing.yaml` 无 `anthropic/*` 行；`costOf(alias)` 以路由 alias 查 catalog 落空 → `resolveCostUsd` 返回 `null`（fail-open「未计量」）。`openai-codex/*` 早有定价故 ChatGPT 订阅花费一直能显示——Claude 是唯一漏配的订阅渠道；`github-copilot/*` 无 lane 引用，不在范围。
- **关键坑（务必同时改两个文件）**：这些 alias 现**无 catalog 条目**→能力过滤被跳过、fail-open 直接尝试（`execute.ts:887` `if (caps)`）。一旦**只加 pricing**，`loadCatalog`（`catalog/index.ts:107`）会用 `EMPTY_CAPABILITIES`（`maxContextTokens:0`/`supportsStreaming:false`/`jsonOutput:none`）造条目 → 能力过滤第 4 关 `context_too_small` 把**每个** Claude 请求剪掉。故必须**同时**在 `capabilities.yaml` 加条目（照搬 `zenmux-anthropic/claude-*` 既有先例，二者都加），用真实上限：Opus/Sonnet/Fable `maxContextTokens:1000000`、Haiku `200000`。
- **定价来源（按用户规则「API 价优先，否则官方」）**：核对生成 catalog（`catalog/generated/catalog.json`）只有旧 `claude-3-5-{sonnet,haiku}-20241022`，四个目标模型均不在 → 全部用**官方 Anthropic 价**（`claude-api` skill 即官方价表）。Opus 5/25、Sonnet 3/15、Haiku 1/5、Fable 10/50（USD/MTok）。**含 cache 读写价**（读 0.1×、写 1.25×输入）——载入项：Claude Code 大量用缓存，缺省会让 `computeCostUsd` 按全价计缓存 token，严重高估。
- **取舍/限制**：是**折算价非实付**（订阅月度统付，与 `openai-codex/*` 既有语义一致），未在 UI 区分名义/实付；仅 4 个 lane alias 被定价，自定义 key 发来的其它/带日期 `anthropic/<id>` 仍 `null`（fail-open 照样尝试，只是不计价，需要时运维补一行）。纯配置无代码改动。
- **验证**：`samples.test.ts`（Claude lane 路由不回归）、`catalog/{index,load,models-list}.test.ts`（4 条新条目的计数/快照）、`capability/filter.test.ts` 均绿；typecheck+lint 绿。

## 2026-06-22 · Codex 原生 Responses 直通兼容清洗 + fallback reasoning 泄漏修复（docs/05/07；原则 3/7/8）

- **线上实证**：`la.atmy.work` 请求 `e3ead05d-3433-4464-aca2-47d7640ee97f` 的第一候选 `openai-codex/gpt-5.5` 295ms 返回 HTTP 400：`Unsupported parameter: max_output_tokens`；入站是 `/v1/responses` 原生直通，客户端带 `max_output_tokens:512`。请求 `39f175e4-2ff8-4ede-849c-d8dc9542adb0` 第一候选 `openai-codex/gpt-5.4-mini` 404：`Item with id ... not found. Items are not persisted when store is set to false`；同一 fallback 链随后 Anthropic/DeepSeek 因 Responses reasoning history 被当作 provider `thinking` 配置而 400，OpenRouter 最终成功。
- **决定 1（Codex 直通）**：仅对 ChatGPT-account Codex Responses profile 增加 native body 清洗：移除 `max_output_tokens` / `temperature`；`store:false` 时删除 input item 的 `id/status/phase` 引用元数据，并丢弃空 reasoning item（保留有 `encrypted_content`/summary/content 的 reasoning）。generic OpenAI Responses passthrough 保持原样，避免破坏标准 API 语义。
- **决定 2（跨协议 fallback）**：`InternalRequest.thinking` 若是 Responses reasoning history 数组，不再作为 provider `thinking` 请求配置转发到 OpenAI-compatible / Anthropic target；attempt 记录 `thinking_history_stripped_for_target`。provider_raw.reasoning 继续按目标协议 allowlist 剥离并记录。
- **验证**：TDD 红→绿；`openai-responses.test.ts` 覆盖 Codex native 清洗；`execute.test.ts` 覆盖 Codex 直通清洗与 fallback `thinking` 剥离；focused 237 测、core/gateway typecheck、Biome touched-file check 均绿。

## 2026-06-22 · Opus 1M 上下文溢出预检 + 流式失败落库修正（docs/04/05/07；原则 3/5/7/8）

- **线上实证**：`la.atmy.work` SQLite 显示 `claude-opus-4-8` 原生 Anthropic 请求在 `2026-06-22 01:28:23–01:33:50 UTC` 连续失败，核心错误为 `prompt is too long: 1001854 tokens > 1000000 maximum`；稍后同模型 `prompt_tokens=924300` 成功，说明客户端压缩/清理尚未把活动上下文降到硬上限以下。`decision_json.memory` 为空，Helm memory middleware 未参与。
- **决定 1（上下文）**：对 Anthropic native target 在真正 provider invoke 前增加 exact `count_tokens` 预检；`claude-opus-4-8` / `claude-sonnet-4-6` / `claude-haiku-4-5` 采用保守硬上限 `1_000_000`，并与 catalog 值取较小者。`count_tokens` 失败时 fail-open 继续原尝试（避免 token helper 自身成为 5xx），但一旦精确 `input_tokens` 超限，记录 `skip_reason:"context_too_small"` 并进入 fallback，**不记 breaker failure**。
- **决定 2（请求形状 400）**：上游 400 中的 `prompt is too long`、`does not support effort level`、`output_config.effort` 等判为请求形状错误，attempt 记 `invalid_request`，但不污染 circuit breaker。`:free` 429、OAuth 429 auto-park 等 provider-health 路径保持原语义。
- **决定 3（effort）**：`claude-sonnet-4-6` 只允许 `low|medium|high|max` 的 `output_config.effort`；`xhigh` 等不兼容值在执行前以 `unsupported_reasoning_effort` 跳过该候选，而不是发给上游再 400。没有把 `xhigh` 自动 clamp 到 `max`，因为 clamp 会悄悄改变用户请求语义；fallback skip 更可观测。
- **决定 4（流式可观测）**：`/v1/messages` 已写出 Anthropic `event:error` 时，同步把 `DecisionRecord.final.status` 改为 `error` 并写入 `error_reason`，避免 admin 显示 ok 但 payload 里是错误帧。Codex Responses `response.failed` / `error` 抛出的 `UpstreamError` 现在带原始 SSE event 到 `providerRaw`，让 `error_detail.provider_raw` 能保留故障字段（仍经 telemetry redaction）。
- **仍未做**：all-failed chain 的 per-attempt upstream body capture 还没补；当前只继续保存 served attempt 的 `upstream_request_json`。这需要扩展 payload 表或决策 attempt 附属表，单独做更稳。
- **验证**：TDD 红→绿；`execute.test.ts` 覆盖 exact count_tokens skip、Sonnet effort skip、request-shape 400 不触发 breaker；`messages.test.ts` 覆盖 stream error 落库；`openai-responses.test.ts` 覆盖 `response.failed.providerRaw`。focused 212 测、typecheck、Biome lint 均绿。

---

## 历史条目摘要（压缩归档）

> 以下为更早条目的一行要点（新→旧）。完整原文见 git history（本文件在 2026-06-05 压缩前的版本）。

- **2026-06-21 · Codex Chat→Responses 兼容层移除 `temperature`**：economy+temperature:0 非流式 Chat 经 `openaiToResponsesRequest` 互译到 ChatGPT-account Codex Responses 后端 400 `Unsupported parameter: temperature`；改为 Codex Responses 用 openclaw 最小 body（`store:false`/`stream:true`/`include:[reasoning.encrypted_content]`/`text.verbosity:low`，不发 `max_output_tokens`/`temperature`），generic Responses 不变。
- **2026-06-21 · 全仓评审修复 Tiers 1–5**：按 review C1/C2、C3/H3、H1/H2、H9/H10/H11、breaker+memory 分批修复；关键取舍包括删除未被网关调用且漂移的 `executor/fallback.ts`、不从 `prompt_tokens` 预减 cached、`cleanup_archive_enabled` 默认关并加 2× 安全线、`require_api_key:false` fail-closed、Anthropic mid-conv system 折叠保持现行为、OPEN 态 `recordFailure` no-op；M6/C4 延后单做。

### 2026-06-20 · 内部 LLM（memory + eval）支持 lane 名 + 默认 economy（docs/03/04/08；原则 4/6）：self-http 内部 LLM 原把裸 lane `economy` 改写成 `deepseek/economy` 导致 lane-as-model 失效；修为 `createSelfHttpClient` 注入 live `isLane()`，已知 lane 原样透传，memory/eval 默认 model 改为 `economy`，并删除 `HELM_INTERNAL_LLM_THROUGH_GATEWAY` 开关使内部调用始终经自有网关（mint `k_internal`，失败才落回直连）。用户知情接受 economy 成本较高；未做启动期 capability 校验/成本可观测。

### 2026-06-20 · observer 任务合并竞态致"运行期到达的消息"丢失（docs/08 Phase 2；原则 3）：observer job claim 时一次性快照，运行期间新 user 轮被开放任务唯一索引合并进已过读取点的 running job，导致短线程 fact 轮永不被挖；修为 `runObserverJob` 记录 `snapshotMessageIds`，done 后重读并仅对快照外新 user 消息补发 observer job，避免 assistant-only 热循环；无 schema/迁移，SQLite+Postgres 对称，observer 26 + core memory/store 653 绿。

### 2026-06-20 · 事实抽取可靠性 + 内部 LLM 调用走自有网关（可观测）（docs/06/08/12；原则 3/7）：`deepseek-v4-flash` 抽事实 temperature:0 仍非确定性、对明确事实偶发返空（输出形状每次变）→ `maybeEagerExtractFacts` **只喂 user 消息**（滤 assistant/tool/文件噪音）+ **空结果重试一次**（`eager_facts_retry`）。另：内部 LLM（记忆+eval）原绕过遥测不可观测 → 改**自调用** helm 自己的 `/v1/chat/completions`（loopback，`createSelfHttpClient`）获遥测+payload，启动自动 mint 固定 `k_internal`（allow_custom_model+memory_mode:off）。续修：保护 `k_internal` 不被 admin 删（DELETE 守卫 403 + 前端只留 Details）。PR #339→v0.21.8；保护续修→v0.21.9。

### 2026-06-20 · eager 事实抽取 `insertFactsReconciled` 未绑定 `this`（v0.21.6 潜伏 bug）（docs/08/12；原则 3）：`observer.ts` 的 `maybeEagerExtractFacts` 把 store 方法解构后**裸调用** `const insert=deps.memoryStore.insertFactsReconciled; await insert({…})`→丢 `this`→sqlite 适配器 `this.db.$sqlite` 抛 "reading 'db'"→eager fail-open 静默不写。裸数组 schema bug 一修通它立刻顶出（之前路径走不到 insert）；假 store 的 vi.fn 不依赖 this 故单测没抓到。修：`insert.call(deps.memoryStore, {…})`，对齐 idle-flush/decay-trigger 既有 `.call` 模式（observer 是唯一裸调）。`this`-敏感回归测试 + observer 21/memory 255 测绿。配套 `docs/memory-review-2026-06-20.md`（数据流图 + 6 bug 账本）。PR #337→v0.21.7。

### 2026-06-20 · eager/reflector 事实抽取被严格 schema 静默吞掉（deepseek 裸数组）（docs/salient-fact-memory-spec；原则 2/3）：`deepseek-v4-flash` 事实抽取 temperature:0 仍非确定性返**裸数组** `[...]` 而非 `{facts:[...]}`，`RawFactsOutputSchema`/`FactsOutputSchema` 只认对象信封→`callJsonModel` 静默回退 `{facts:[]}`→fact 永不落库（reflection 因回退非空才幸存）。修：`coerceFactsEnvelope` 经 `z.preprocess` 把顶层数组包成 `{facts:array}`（tolerant passthrough，镜像 codex role/effort）+ `parseJsonObject` 裸数组打捞；无 schema/无迁移。同 PR 另带 Gemini 原生直通注入记忆 + fact 复活刷新 scope（账号全局 hash 跨 project 重述复活旧 scope 致 inject 读不到）。memory-llm 18 + memory 247 测绿。PR #335→v0.21.6 已部署。

### 2026-06-20 · 已归档 reflection 无法删除（两段式 soft→hard delete）（docs/13；原则 1）：admin 删 reflection→`archived`，再删 0 命中 active→404「reflection not found」永远删不掉。修：`deleteReflection` 按解析行 status 分支——active=软删（归档整 scope 全 active 版）、archived=**硬删该 scope 全 archived 版**（运营者手动二次删才永久清，自动遗忘管线仍永不硬删，docs/12 有意偏离）；硬删整 scope 防旧归档版经 `latestPerScope`「诈尸」。sqlite+pg 双适配器、admin 弹窗文案随 status 切换 + 1 i18n×5、MCP 透明受益。822 测绿。PR #331。

### 2026-06-20 · 记忆形成低延迟：防抖唤醒 memory worker（docs/08 Phase 2；原则 3）：worker 每 60s 轮询排空 `memory_jobs`，请求 inject 阶段立即入队 observer job 但干等下个 tick→最坏 ~55–60s。修：`scheduler.wake()`=trailing-edge 防抖（`coalesceMs` 默认 8s，`HELM_MEMORY_WORKER_COALESCE_MS` 可覆盖），`write-queue.onTaskDrain` 在 observe 落库后唤醒；`enqueueJob` 幂等去重保住合并（pending 期间多回合 dedupe 进同一 job=一次 LLM 调用）；60s timer 留作 backstop。Codex 修 2 P2（唤醒早于 outbound observe→仅 wakeOnSettle 触发；stop 后 wake no-op）。948 测绿。PR #332。

### 2026-06-20 · 删除的 fact 可被重新学习（resurrect-on-re-ingest）（docs/12/13；原则 1/3）：`deleteFact` 软删=`status='pruned'`+盖 `expired_at` 但保留 content_hash；`insertFactsReconciled` 的 `INSERT OR IGNORE` 撞 `UNIQUE(owner_id,content_hash)`（无 status 过滤）→ Reflector 重抽逐字相同 fact `changes===0` 静默跳过=永久压制。修：dedup 命中查现有行，`status IN (pruned,archived)` 则就地复活（active、清 expired_at/invalid_at、valid_from=新观测、跑 supersede）；活体重复仍幂等 no-op；保留软删审计。`MemoryFactReconcileResult` 加 optional `resurrectedIds`，sqlite+pg 双适配器，MCP `handleAdd` 报 resurrected。sqlite 3+pg 3+MCP 1 新测、650 绿。PR #329。（本次 2026-06-20 续修在最上方那条：复活时**刷新 scope 列**——账号全局 hash 跨 project 重述会复活旧 scope 行致 inject 读不到。）

### 2026-06-19 · 设置页清理动作确认弹窗 + 五卡布局重组（admin「System Settings」；原则 1）：上一条「自动数据清理」的 Clean now / Compact database 两按钮单击即执行（删数据/VACUUM 锁库）无确认 → 复用全站 `Modal` 确认模式（confirmingClean/confirmingVacuum $state，触发改置 flag、弹窗确认才真跑、执行中 `dismissible=false`，保留 testid 故 e2e 不破）；并把杂物卡「Operations」拆成**五卡**（Routing/Rate limiting/Request queueing/Logging/Data retention & cleanup，按请求生命周期排序，binding/testid/文案逐字不变）。坑：i18n 7 新 key 经 `i18n:sync` 中继译，`i18n:extract` 首跑赶在落盘前→0 新 key 重跑即正常。svelte-check 0/0、手测 Playwright 五卡顺序+确认流程绿。分支 `worktree-settings-confirm-and-layout`，未部署。

### 2026-06-19 · 记忆管理后台页 + Memory MCP server（docs/13；原则 1/2/7）：facts+reflections 长层运营者无法查看/编辑/删除、外部 agent 无程序化读写 → 新增 admin `/memory`（By Key+By Scope）+ `POST /mcp`（API-key 鉴权 full-CRUD，6 工具 `type:fact|reflection` 判别符，直写 JSON-RPC 不引 SDK，gating `memory.mcp.enabled` 默认 false fail-closed）。`MemoryStore` 加 9 个全 optional 管理方法 sqlite+pg 双适配器。关键决定：管理读**不套** `expired_at IS NULL`（运营者要看 superseded/archived/pruned；admin 默认 all、MCP 默认 active）；updateFact 重算 content_hash 但不动 subjectKey，碰撞→typed 409；**fact 删=软删 pruned+盖 expired_at**；**reflection 删=软删 archived**（本次 2026-06-20 扩成两段式 soft→hard）；reflection 编辑就地改不 bump version；Codex review 修 3 lifecycle bug（deleteReflection 归档整 scope 全 active 版本 / updateFact status 同步 expired_at / latestPerScope tuple key 改 JSON.stringify 防 NUL 二进制化）。277 文件 4047 测绿，分支 `worktree-memory-admin-mcp`。

### 2026-06-19 · 自动数据清理/保留/归档（admin「Data retention & cleanup」；原则 1/2/3）：修 3 个无限增长缺陷（payload 机会式清理、telemetry 无 prune、memory 保留被 forgetting 门控）。core 新 `cleanup/`（plan→runner→scheduler 独立 setInterval+unref+fail-open，**归档 fsync+sha 校验成功后才删**=archive-first；`LocalVolumeSink` gzip-JSONL+manifest）+ `StoreSet.vacuum()`（sqlite VACUUM/pg no-op）。设置进 runtime-settings（master+interval+archive+每类 toggle/天数；memory_messages/derived 默认 OFF 须 opt-in）。上次报告存 config_kv 非新表、无迁移。Codex review：彻底移除请求路 `prunePayloads`（保留权归调度 runner 独占）、`buildCleanupPlan` 不读 master（仅 scheduler tick 守卫，手动 Clean now 始终执行）。范围收敛：有界表(rate/budget/signals/quota)推迟。4037 绿、`worktree-data-cleanup-archival` 未部署。

### 2026-06-19 · Anthropic 出站工具名规范化（全翻译路径）（issue #303；docs/05；原则 6/7/8）：非 strict 热路径 `openaiToAnthropicRequest` 逐字发 `fn.name` 致非法/点/空格/超长工具名直达 Claude→400/工具链错位（规范化原仅 strict 指纹模式做）。新增 `applyAnthropicToolNameSpec`（复用 `createAnthropicToolNameMap`：`[A-Za-z0-9_]`/≤64/空→tool/FNV 冲突后缀）+ `composeReverseMaps`，在 `request()` strict cloaking **之后**、序列化**之前**、**仅翻译路径**（`normalizeToolNames` 标志；native passthrough 逐字不改）跑，组合 reverse-map 经既有 translator 还原原名；在 `structuredClone` 上改写保 401 重放安全。anthropic 6 新例（含幂等/native 逐字）+ provider 493 绿。PR #316 `Closes #303`，未部署。

### 2026-06-19 · 每 API Key 使用量统计：列表 24h 列 + Key 详情页（issue #314；docs/06/07；原则 1/3/7）：`/admin/keys` 每行加 24h 用量 + 新 `/admin/keys/{id}` 详情页（配置 + 可筛选统计 + 请求列表下钻）。后端 `TelemetryStore.usageByKey`（单条 `GROUP BY api_key_id`，无 rollup）、`aggregate()` 加可选 keyId、schema fail-open `key_id` 列等值；`GET /admin/api/keys/:id`（**须注册在 `/keys/usage` 之后**防 :id 捕获）+ `/usage`。前端 `getKey` **仅 404→null 其余照抛**（不把后端故障伪装成"不存在"）、`key-detail-filters.ts` 自定义日范围优先且 rollover-safe、LayerChart 组件测试须 `vi.mock`（import 即调 matchMedia）；12 新 key×5 locale。274 文件 4028 测绿。分支 `worktree-feat-key-usage-stats`，未部署。

### 2026-06-19 · Layer-1 复杂度(tier)评分限定当前 user 轮（PR #315；docs/03 §Layer-1；原则 4/6）：#313 task 修复的孪生 bug——`dimensions.ts` 复杂度评分仍 `extractText` 拼全部消息，巨型系统提示把闲聊抬成 `complex`→`chat_complex_to_premium`→烧 Opus。修：`buildContext` 文本派生维度（`*_kw`+结构信号+`msg_length`）改用 `lastUserMessageText` 限定末条 user，ambient 形态维度（turn/tool/attachment/json）保持全请求；标定语料 100% 单消息故行为逐字不变、无需重跑标定、`classifier.yaml` 未改。Codex review（连带修已合并 #313）：`lastUserMessage` 跳过 `<system-reminder>` 开头的注入 user 轮。dimensions 5 例 + message-text 注入跳过例、classifier+samples 280 绿。PR #315。

### 2026-06-19 · Layer-1 task 检测限定当前 user 轮（docs/03 §Layer-1；原则 4/6）：线上 `5ee4bf79`（AgentCrew/Mimi，`/v1/responses`）末条 user 仅 10 字闲聊却被第一层纯规则判 `coding/complex`→coding lane；根因 `taskdetect.ts` 的 `extractText` 拼全部消息 + `task_keywords` 纯 `includes()` 子串匹配，7599 字 developer 系统提示里 `类/实现/git` 命中 coding 3.0 分淹没真实问题。修：`detectTask` 的关键词+结构信号限定**末条 user 消息**（工具名仍全请求扫），新增共享 `classifier/message-text.ts` 收敛 engine/cache-key 三处重复。坑：tier 层 `dimensions.ts` 同病但被 golden set 标定锁定，刻意不碰（后续标定门控项）。taskdetect 5 新例、classifier+samples 266 绿，分支 `fix-classifier-task-scope-last-user`，未部署。

### 2026-06-18 · Salient-fact 快车道：事实形成与注入解绑压缩（docs/salient-fact-memory-spec；docs/08/12；原则 1/2/3）：线上「我喜欢42」短对话跨 session 召不回——facts 只由 reflector 从 observation 抽,而 observation 仅 `segmentMinTokens=2048`/1h idle 触发,短对话 0 observation→0 fact;且 `inject.ts` 从不读 `memory_facts`。新增 opt-in `config.memory.forgetting.consolidate.eager_facts`(默认 false,跨块强制 `llm.enabled`)+ `max_facts_injected`(先验 16)。Change A:observer 不压缩退出路径对 uncovered 原始轮抽事实(`extractFactsFromMessages`,nano `facts_model`,失败返空),经共享 `buildReconciledFactBatch` 落库 `insertFactsReconciled`,scope 由 `ObserverJob` 携带。Change B:`inject.loadMemory` 加载 `listActiveFacts` 装配「## Known facts」段(reflections>facts>observations 预算优先,forgetting 排序 top-K)。坑:fact-scan watermark/压缩跳过 eager/fact reinforcement 均推迟;成本放大 ~1.05–1.2×;无迁移无 schema 改。全量 3989 绿。PR #312,默认 off(box 已开 llm+forgetting,置 `eager_facts:true` 启用)。

### 2026-06-18 · Codex 原生直通缺失 instructions 修复（issue #217；docs/05；原则 1/4/8）：线上 `09387e28` pi-ai `/v1/responses` 直通 ChatGPT 订阅 Codex 后端 400 `Instructions are required`（入站 `input[]` 无顶层 `instructions`，系统提示在 `input[0]={role:developer}`，pi-ai 故意不发）。core 新增纯函数 `hoistResponsesInstructions`（已有非空 instructions 原样返回；否则把 input 里 system/developer hoist 进顶层 instructions 并摘除；无 system 则注入 `DEFAULT_INSTRUCTIONS`），在 `execute.ts` `needsCodexResponsesShim`（仅 codex_responses profile）调用，记 `instructions_hoisted_from_input`/`instructions_defaulted`，**保留 passthrough**。坑：`body_shims_applied` 去重+排序故 ledger 字母序。core 8 + gateway 2 测、全量 3264 绿，未部署。

### 2026-06-18 · Anthropic OAuth TLS/JA3 transport spike（docs/05/10；原则 2/7/8）：新增 provider 配置 `transport_profile: auto|default|tls_chrome`（Zod fail-closed）；`auto` 下 Anthropic preset OAuth 默认 `tls_chrome`、其他 `default`，显式 `tls_chrome` 仅限 Anthropic preset OAuth 否则 fail-closed。最终 provider execution 经 `makeTlsImpersonationFetch()` lazy-load optional `wreq-js`（标准 fetch seam，`disableDefaultHeaders:true`、streaming `timeout:0`、per-request ephemeral cookie），OAuth refresh/discovery 仍走 undici；wreq 连接错误归一到 ECONNRESET/ECONNREFUSED 命中既有 retry。坑/TODO：native 包/Docker platform、streaming 行为、proxy 矩阵、TLS spoof 是否真改善 401/403；optional 包缺失则 fail-closed 抛 `TlsTransportUnavailableError`，需 `transport_profile: default` 回退；价值待同账号同 request A/B live smoke。未部署。

### 2026-06-18 · Claude CLI strict tool pipeline 与 golden fixture（docs/05/07；原则 5/7/8）：strict fingerprint 模式（动态 OAuth/非官方 relay，非 native passthrough）在最终 Anthropic body 序列化前做工具兼容层——工具名 cloaking（`read_file→Read`、`mcp__…→McpCodegraphCodegraphContext`，同步改 tools[]/历史 tool_use/tool_choice）、零参 schema 补 `properties:{}`、`cache_control` ≤4、forced choice 删 thinking/context_management、非 forced thinking 仍跑 Anthropic 约束；请求内部返回 reverse-map，流式/非流式 translator 还原 cloaked 名。坑：strict 原地改写 body 会破坏 401 重放的 reverse-map → 改为只操作每 attempt 的 clone，原 body 不改，401 回归测试锁住。native passthrough 仍逐字直通不改写；TLS/JA3 属单独 spike。golden fixture + TDD，anthropic 94 绿/typecheck/lint 绿，未部署。

### 2026-06-18 · 请求详情页内部 code 人类可读化（admin i18n；原则 1）：「供应商尝试」链 + 错误类型显示内部 snake_case code（no_response_schema_support/circuit_open/client_abort/upstream_error…）运维看不懂；新增 admin `attempt-codes.ts` 的 `ATTEMPT_CODE_LABELS`(code→英文人话=i18n key)+`attemptCodeLabel()`（未知回退裸 code），镜像 core SkipReason+error_class（admin 不 import core），渲染处改 `$t(attemptCodeLabel(code))` 并 `title` 留裸码；26 新 key×5 locale 手译、additive 合并；admin 14 测/svelte-check 0/build 绿。分支 feat-readable-attempt-codes，未部署。

### 2026-06-18 · json_schema 能力分级修复（capability tier；docs/02/04；原则 2/3/4）：把 `supportsJsonMode` 拆成有序 `jsonOutput:none|object|schema`，能力过滤区分 `json_object` 与 strict `json_schema`，json_schema 默认落 openrouter-deepseek；旧 `supportsJsonMode` override fail-closed，部署前需改 operator-owned capabilities。

### 2026-06-17 · /admin/lanes 加 reasoning_effort 下拉（admin UI；原则 1）：后端已支持 lane `reasoning_effort` round-trip，缺口只在 admin DTO/UI；新增 admin 侧 enum 镜像、LaneEditor 下拉、Unset 删除字段、5 语言文案与 tests。坑：mock 必须补 `REASONING_EFFORTS`；i18n 用手动 append 避免无关重排；未部署。

### 2026-06-17 · Lane 级强制 reasoning_effort（docs/04；原则 1/2/4）：`LaneSchema` fail-closed 增可选 `reasoning_effort`，route 注入 `reasoning_effort_forced`，翻译路/原生直通四协议出站改写；Anthropic thinking 约束统一处理。坑：配置不可先于新镜像上线；未做 per-model 默认或客户端优先。

### 2026-06-17 · Gemini 跨协议 response_format 修复 + ZenMux 原生直通接入（issue #217；原则 1/3/6/8）：修 Gemini `responseJsonSchema` 映射漏 `{name,schema}` 导致跨协议 OpenAI 校验失败，并把 ZenMux Vertex/Anthropic 原生 provider 接入默认配置。TODO：请求构造 ZodError 不应打熔断、核对 ZenMux 价目；box 已验证生效。

### 2026-06-17 · Codex「重置限额」额度消费（docs/06；原则 1/3/6/7）：在 Subscription Providers 页给 `openai-codex` OAuth 账号接入 reset credit 实时计数与 consume POST，计数不落库、consume fail-closed 且不回显上游 body。坑：只有已有 quota 快照行才显示按钮；真机 consume 需有额度账号。

### 2026-06-17 · 真实 TPS 端到端采集与展示（docs/07/10；原则 1/3/5/6）：新增流式 `generation_ms` 后置落盘、telemetry denormalize、仪表盘/列表/详情派生真实 TPS 与 TTFB；非流式/legacy 显示 null。坑：只在有 usage tail 的流式响应可算，平均值用聚合比值而非 per-request 均值。

### 2026-06-17 · OAuth 账号「使用量限制」自动停靠 + 一键重置（issue: auto-park；原则 2/3/7）：`oauth_quota` 增 `usageLimitedUntilMs`，OAuth pool select 跳过冷却账号，服务流量 429 / Codex quota header 触发停靠，admin reset 清本地门控。坑：页面 PULL 不改变调度状态；reset 只清 auto-park 不解 operator park。

### 2026-06-17 · Claude CLI strict fingerprint profile 落地（docs/05/06/07；原则 2/5/7/8）：新增 provider 配置 `claude_cli_fingerprint_mode: auto|off|conservative|strict`（Zod fail-closed），把激进的 Claude CLI wire-image 放进 provider HTTP 最后一跳而非协议 transformer。`auto`：Anthropic OAuth subscription / dynamic getAuthHeader / 非官方 anthropic-compatible relay 默认 strict，static API key 默认 conservative。strict 仅在互译/compat rewrite 出站 Anthropic 时启用（native passthrough 不注入）：最终 POST 前按 Claude 顶层 body order 序列化、用 xxHash64(seed 0x6e52736ac806831e) 算 body-level 5-hex CCH 只替换 `system[0]` billing 占位（避免误改正文 `cch=abcde;`）、headers 按 Claude CLI order/casing 并补 X-Stainless-*。取舍：strict CCH 随 body 变化牺牲 prompt-cache 友好性（仅默认作用于 subscription/relay 互译路），`off` 是 kill switch，不保证降低封号风险。TODO：golden fixtures、TLS/JA3 指纹、完整 strict tool pipeline、admin per-provider 开关、profile/mutation ledger。focused 269 绿、typecheck/lint 绿。

### 2026-06-17 · Opus 4.8 会话中 system 消息恢复原生直通（issue #217；原则 5/8）：线上请求 `5191ce2b...`（Anthropic native 流，`messages=[user, system]`、tools=63、`claude-opus-4-8`）`passthrough_used=false`、disable reason `provider_requires_compatibility_rewrite`，折叠后上游只回 `message_start→message_delta(end_turn)→message_stop`（无 text/tool_use）客户端卡住。根因 `aa377a1` 把任何 `messages[].role=system|developer` 一律折叠，误伤 Opus 4.8 合法的 mid-conversation system。修：`anthropicNativeBodyRequiresSystemFold(req, { providerModel })` 改 model-aware——仅 `claude-opus-4-8` + inline system 处于 `user→system→assistant|end` text-only 形态才保直通；缺 model/旧模型/`developer`/leading/consecutive/非文本 system 继续 fail-closed 折叠；`execute.ts` 用 resolved `target.providerModel` 不信客户端 body。不全局放开 system 直通。focused `protocol+execute` 97 + 全量 263/3802 绿，未部署。

### 2026-06-17 · Claude Code 互译路径 OmniRoute 对齐与 system 样板去重（docs/05/07；原则 5/7/8）：线上请求 `51067fe1...` 互译路径 `upstream_request_json.system` 膨胀到 81 block（sentinel ×2、task-tools reminder ×44）。根因：Anthropic 入站 hoist 顶层 system 不剥 sentinel + subscription provider `buildSystem` 又无条件插 sentinel 并折叠所有 IR system。修：仅互译到 Anthropic subscription 的 `buildSystem` 幂等清理（跳过已存在 billing header、单一 sentinel 于 `system[1]` 继承 cache_control、仅对 Claude Code 固定样板提醒做完整文本精确去重）；补 Claude Code agent prompt block（客户端已带则复用）；移植 OmniRoute 保守子集（第三方 agent 指纹清洗 + Claude CLI-like runtime headers），只在 translation path，native passthrough 逐字保真。不放宽 `anthropicNativeBodyRequiresSystemFold`。TDD 全绿（263 files/3796 tests），未部署。

### 2026-06-16 · 修复原生直通对 Claude Code「会话中 system 消息」400（issue #217；原则 3/5/8）：生产请求 `81f3fa9e-...` 显示 Claude Code 把 MCP instructions 作为 `messages=[user, system]` 末尾 system 直通上送，被 Anthropic subscription 400 后 fail-open 回退到 gpt-5.5；修为新增 `anthropicNativeBodyRequiresSystemFold(nativeRequest)`，仅对 Anthropic target 且 `messages[].system|developer` 需折叠时关闭 native passthrough，复用 `provider_requires_compatibility_rewrite` 让请求落回合法的翻译/折叠路。取舍：保留全局 native passthrough 默认 ON，不在直通内就地改 body；后续若订阅端支持更多 mid-conversation system，再用实测扩大 allowlist。focused tests/typecheck/biome 绿。

### 2026-06-16 · classifier 中英文关键词对等 + 修复短消息捷径的 CJK 盲区（docs/03；原则 2/4）：根因是 `overrides.ts` 短消息捷径只看英文 signals 且自带 CJK-broken matcher，短中文 analysis/security 被钉 `simple`→economy；修为 `signals.ts` 共享 CJK-aware `keywordMatcher`，`containsClassifierSignal` 纳入 `*_intl_kw`，补 diagnostic/translation/lookup/chitchat intl 配置与中文确认词。TDD 覆盖短中文不降级、纯问候仍 simple、golden routing 中文样本；focused tests/typecheck/biome 绿。

### 2026-06-16 · 数据汇总按客户端时区分桶（修复「8 点边界」）（docs/02/04/10；原则 1/2/3）：仪表盘日/今日数据 8 点断层根因是 stats/OAuth usage 按 UTC 分桶；改为浏览器传 `tzOffsetMinutes`，SQL 用 shift-floor-unshift 统一 sqlite/pg，本地日窗口查询 OAuth 小时桶。TDD 覆盖 shared schema、store contract、sqlite/pg oauth usage、routes/admin；build/typecheck/lint/全量测试绿。

### 2026-06-15 · 移除 policy 级 max_lane 上限（docs/02/04/06；原则 2/6）：admin 策略编辑器「Cap lane (maximum)」(policy `max_lane`) 是已退役机制的最后残留（per-key max_lane 早在 `feat/drop-key-max-lane` 删，sqlite v10/pg v9 DROP COLUMN），`LANE_RANK` 只排 3 条、task/厂商 lane 不可排序故 rank 天花板语义不明。用户拍板硬删 breaking：`PolicySchema.strict()` 拒收 `max_lane`（旧 policies.yaml 启动 fail-close，部署前走 [[config-schema-strict-removal-failclose]] 复核），保留更具表达力的 `allowed_lanes`。改 policy-schema/engine、route-request 3 处 synthetic outcome、admin PolicyRow 降为仅 use_lane、5 语言 i18n、docs。「全局成本上限」改用 `allowed_lanes:[economy,balanced]`。TDD 全绿。分支 `feat/drop-policy-max-lane`（BREAKING，不发版/不部署）。

### 2026-06-15 · 可配置的「默认兜底车道」系统设置（docs/04；原则 1/2/3/5）：兜底写死 `balanced` 不可改 → 加**热改** RuntimeSettings `default_lane`（DB config_kv，读 fail-open/写 fail-closed，默认 balanced=向后兼容）。否决 policies catch-all（policy 最高优先级会盖过 task/complexity 路由）与 lanes 末条（z.record 无序）两方案。只在 resolver 两个 fail-open 终点用、且仅当该 lane 存在否则回落字面 balanced（**无新 fail-close 路径**，不重演 0.13.4）；不动 COMPLEXITY_FALLBACK。admin 系统设置加 lane 下拉 + 5 语言 i18n + PUT 校验 lane 存在。分支 feat/configurable-default-lane。

### 2026-06-15 · 双人 code review 修复：org/user 策略拆除 + Anthropic 空流 + applyCaps + client_abort（docs/02/04/05/07；原则 3/5/7/8）：我+Codex 对抗式 review，确认 2 bug+1 设计+2 小问题全修。#1 org/user 维度策略形同虚设（`auth.ts` 写死 null→永不命中、`budget_org_cap` 死代码）→ 从 PolicyMatch/Context/MATCH_FIELDS/两 builder 拆除（`.strict()` 使遗留策略 fail-closed），admin PolicyRow 同步删 User/Org ID；#2〔Codex〕Anthropic 出站零 chunk 流缺 message_start→收尾前补 `messageStartEvent` 守卫；#3 applyCaps 把不可排序候选顶到 premium→`UNRANKED_CANDIDATE_RANK=balanced` 降级；#4 client abort 误标 upstream_error→新增 `client_abort`(499) ErrorClass；#5 aliasPolicyContext 写死 complexity:medium→改 null；#6 非自定义模型 key 全走 auto（route-request Step 0a 加 `allowCustomModel` 门槛）。TDD 全量 **3737** 绿。分支 fix/review-routing-stream-errors。

### 2026-06-15 · 订阅 OAuth 轮换 refresh token 跨实例竞争修复 + 刷新状态码透传（docs/06；原则 1/3/7）：5+ 独立 TokenManager 共用 store 里同一单次性轮换 refresh token、无跨实例协调 → 并发刷新重放已消费 token → Anthropic invalid_grant 常作废整个 token 家族需重登。修（全在 core `token-manager.ts`，自动覆盖 7 调用点）：store 作用域跨实例刷新闸 `presetRefreshGates`（`WeakMap<store, Map<key, Promise>>` 串行化 + 闸内先 reload store 采纳兄弟刚轮换的 token）、保留每实例 single-flight、`invalidate` 仅当 store 仍是被拒 token 才强制刷新、新增 `OAuthHttpError{httpStatus}` 把状态码织入错误串（脱敏不变）。坑：已被作废的 token 家族无代码可复活、须 admin 重登。TDD preset +4、core 429 / gateway 796 绿。**已部署 v0.13.3**。

### 2026-06-14 · 上游瞬时断连幂等重试 + SSE 心跳保活（docs/02/05；原则 3/8）：客户端裸 socket 断连 → (A) `provider/retry.ts` `withConnectionRetry` 严格白名单瞬时错误在三 client fetch 边界重试 2×[200,500]ms（首字节前=幂等，对单候选链也生效；timeout 不重试交跨模型 fallback）；(B) `routes/heartbeat.ts` `withHeartbeat` chunk 间心跳（同一 next 与定时器赛跑不丢/不重 chunk，`:\n\n` 仅在帧边界发=principle 8），接 chat/messages/responses/gemini 4 面，`runtime.sse_heartbeat_ms` 默认 15000、0 关。慢首包否决（保留 peek-before-commit）。TDD retry 25 + heartbeat 7 绿。分支 fix/upstream-transient-retry-sse-heartbeat。

### 2026-06-14 · Admin 移动端/响应式走查 + 修复（docs/10/11；原则 1）：Playwright 三视口截 29 图 + Workflow 扇出 10 reviewer，25 处归并 12 修复。核心：宽表（Providers 10 列/Keys 9 列）→ CSS reflow 单 `<tr>` 卡片化（`.cards-table` + `::before` 注 `data-label`，避免双 DOM 让 vitest 单行断言全红）、UUID 首列 truncate、触控 44px（btn-* `min-h-11 md:min-h-0`/hamburger）、768px 网格推迟 lg、a11y 健康点 sr-only。admin build/vitest 364/lint 绿、svelte-check 仅既有 oauth.test.ts 3 报错（非回归）。分支 worktree-admin-mobile-ui，PR #255。

### 2026-06-14 · 协议互译剩余项 PR review 修复（review of fix/protocol-litellm-remaining；原则 2/3/7）：修 Gemini native passthrough 计费/记忆漏洞（usage 改三路协议分支 + observeOutbound，默认 config 无 gemini provider 故不触发）、远程媒体 SSRF 加固（`assertPublicHttpsTarget` 拒私有/保留/元数据 IP + DNS pin 防 rebinding、独立 `mediaFetch` 钉死已校验地址）、Generic Responses→Chat 桥补 `tool_calls`；Codex review round2 再修 Gemini 翻译路径（transformer 组合双向译，不再恒 throw）、静态 key 脱敏、媒体边读边限、401 重建头、registry 有界 LRU。TDD changed-area 全绿。

### 2026-06-14 · Claude OAuth web 登录改用 console callback「copy code」流（docs/06；原则 1/7）：admin web 连 Claude 订阅时 authorize 的 `redirect_uri` 写死 localhost 死链（web 无回调服务器）；改用 Anthropic 托管 console callback `https://platform.claude.com/oauth/code/callback`（批准后页面直接显示 `code#state` 供复制）。外科式仅改 Anthropic：`provider/oauth/anthropic.ts` 参数化 `exchangeAuthorizationCode(redirectUri)`，**web 路** begin/complete 用 console callback、**CLI 路** `loginAnthropic` 保留 localhost；两路 redirect_uri 刻意分叉（授权 URL 与 token 交换须同值）。`parseOAuthAuthorizationInput` 早已认 `code#state`、授权 URL 早已带 `code=true`，故单点修复。Codex web 同有死链但 OpenAI 无托管码页，未动（follow-up）。TDD web-login/anthropic 绿、core+gateway OAuth 202 绿。

### 2026-06-14 · 评估并否决引入 `@earendil-works/pi-ai` 替换 OAuth 实现（原则 1/6）：pi-ai（v0.79.3）内置 OAuth provider 与 helm 完全一致（anthropic/codex/copilot），其文档「众多 Supported」多为 API-key 类（非 OAuth）；其公开 API 只 `login*()`（强绑本地端口 53692/1455）+`refresh*Token`、不导出 `exchangeAuthorizationCode`/PKCE，与 helm web begin/complete 形态失配；二者同源（openclaw 血统）。用户拍板**不引入、保持现状**，无代码改动。重评触发：pi-ai 新增真 OAuth（Gemini/Qwen 订阅）时仅评估接管 `refresh*Token`，不碰 web 登录编排。

### 2026-06-14 · LiteLLM 协议互译剩余项完成（docs/protocol-translation-litellm-gap-spec；原则 1/7/8）：Anthropic/Gemini token helper 改 provider-first + 估算兜底；Responses `previous_response_id` 不再入站拒绝（同协议直通、跨协议 fail-closed）；Responses input_tokens / registry-bound retrieve/delete/cancel/input_items / compact 接线；Gemini native provider（generate/stream/countTokens、parametersJsonSchema/responseJsonSchema/google_genai 保真）；OpenAI Chat response_model_policy；Gemini remote media materializer（默认关）。后续 review 两轮修治理/SSRF/翻译路径（见顶部完整条目）。

### 2026-06-14 · 移除「协议直通」设置 UI，保持运行时默认 ON（issue #236；原则 1/2）：删 admin System Settings 的 `native_protocol_passthrough` 开关 UI（纯前端 5 文件），schema/字段/runtime 默认 `true` 不动（保字段防 PUT round-trip 静默重置为 false，#225 教训）；i18n 删 en/zh-hans/zh-hant 各 4 串。

### 2026-06-14 · 原生直通按 attempt 判断 + Anthropic SSE 元数据修复（docs/02/05；原则 5/7/8）：native passthrough guard 改为只判当前 attempt（删除 lookahead 后续 fallback 协议的整链否决），Anthropic head 可直通、首包前失败再翻译 fallback；`convertOpenAIStreamToAnthropic` 的 `message_start` 不再发空 id/model（取首 chunk，缺失用 request_id/provider_model 兜底成 `msg_*`）。focused 96 tests 绿。

### 2026-06-14 · OpenAI-compatible reasoning alias opt-in（docs/protocol-translation-litellm-gap-spec P2-CHAT-03/04；原则 7/8）：新增 provider 配置 `normalize_reasoning_delta_alias`，只在显式 opt-in 时把 streaming `choices[].delta.reasoning` 归一为 `reasoning_content`，默认保持 byte-forwarding；后续剩余项已补 `response_model_policy`。

### 2026-06-14 · LiteLLM 协议互译首批 P1 修复（docs/protocol-translation-litellm-gap-spec；原则 1/7/8）：修 Responses duplicate prelude、target-aware `provider_raw`、Anthropic empty text sanitizer、OpenAI target `cache_control` 清理；focused tests、ast gates、passthrough deterministic/live 当时通过，memory e2e 既有红另记。

### 2026-06-14 · Subscription Providers 账号「测试」按钮 + 流式连通性检查（docs/06/11；原则 1/3/7）：OAuth『Subscription Providers』页按账号加「Test」按钮（helm 无截图里的 API-key provider 列表，用户拍板按账号测），弹层发单条 user turn 流式**真返回**。后端 TDD 三件：`routes/admin/oauth-test.ts`（`createOpenAiStreamParser` 跨非帧对齐字节重组归一 content/finish/usage、fail-open + `createOAuthAccountTester` 注入 buildClient）、`POST /admin/api/oauth/:provider/test`（streamSSE，无 tester→503/缺参→400/上游失败→**带内 error 事件不 5xx**/断连静默）、`server.ts` 抽 `buildOAuthAccountClient` 与 synthesis 共用且每次测试重载 account proxy。隔离防封号：走全新一次性 client（raw client 本无熔断），**不写 telemetry/不扰生产 pool**，anti-ban 头由 provider client 自动注入故裸 user 请求被 Claude Max/Codex 接受、parked 账号也可测。前端 `streamAccountTest`(永不抛) + `TestAccountDialog.svelte` + i18n 13 串补 en/zh-hans/zh-hant/ja/ko。坑：测试是真实上游调用（真计费、不入 Requests 日志）、只 surface content delta。gateway 732 绿 / admin 358 绿，typecheck/lint/build 绿；oauth.test.ts 3 处 svelte-check 报错为既有非回归。分支 feat/oauth-account-test-button。

### 2026-06-14 · 原生直通保真实施 + 可执行验收（docs/native-passthrough-fidelity-spec；原则 7/8）：建立 native carrier、provider safe profile、raw SSE byte relay、Responses/Codex passthrough、OAuth sticky session 与 live/fake 验收脚本；证明 native path 保持治理/telemetry/memory/预算，mutation ledger 只记修改类型不泄露正文；focused/unit/e2e/live final 当时全绿，TODO 为 provider profile YAML 化与 admin ledger UX。

### 2026-06-14 · 协议层 review 修复：4 协议保真 + memory 注释纠偏（多 spec；原则 1/7/8）：修 Anthropic stream cache_creation 计费、Gemini 媒体/tool_result、Responses input_audio、Anthropic tool_choice、远端 audio document 模态误判，并把 memory/native passthrough 过期注释改成实际尾部 system-reminder/default ON 模型；focused protocol/gateway suites + typecheck/lint 绿。

### 2026-06-13 · 原生协议直通默认 ON + 系统设置开关（runtime-settings；原则 2）：`native_protocol_passthrough` schema 默认 `false→true`（z.infer 传播）、admin 客户端 normalize `===true→!==false`（仍命名该字段防 #225 静默重置）、settings 页加独立「Protocol passthrough」开关（`data-testid=native-protocol-passthrough`）+ i18n en/zh。安全论证：`openai_chat` 入站两道独立闸恒翻译、跨协议/异构 fallback 自动退翻译，直通只换 execute invoke、分类/路由/治理/fail-open 全留。prod 坑：仅影响无持久 runtime_settings 行或行内未显式写该字段的部署（overlay 显式 false 仍赢）→ la.atmy.work 若存过 false 须 admin 手动开。TDD 4 个默认派生值断言 false→true 绿。

### 2026-06-13 · memory prompt-cache 优化 — 系统前缀注入 → 尾部 system-reminder（docs/08；原则 8）：用户拍板尾部 `<system-reminder>`，translate 路和 native passthrough 路都把 memory 追加到对话末尾而非前置 system，保住 Anthropic/Responses prompt-cache 前缀；`wrapMemoryReminder` 成单一真相源，system/instructions 与历史回合逐字不动。TDD 覆盖 inject bridge/native-memory/chat/messages/pipeline，typecheck/lint 绿；TODO 是 live e2e 手验缓存命中与 memory 召回。

### 2026-06-13 · Phase 4 — memory 前缀注入（docs/08；tool/多模态 + 直通；原则 1/3/7/8）：inject 从 full-replace 改**加性前缀**——assembler 不再重建会话，只产一个系统级 memory 文本块（`buildMemoryBlock`，确定性/缓存友好），pipeline 前置到逐字保留的实时会话之上 → 删 D7 纯文本闸、tool/多模态/直通回合一视同仁注入。**窗口感知去重**：project/resource reflection 恒注入、thread observation 仅当覆盖回合已不在实时窗口才注入，指纹 `sha256Hex(serializeContent)` 与 storage `content_hash` 字节恒等；无法解析覆盖范围则保留、无窗口不去重。落点：translate `injectIntoIR`（前置/插 leading system）、直通 `native-memory-inject.ts`（Anthropic `system`/Responses `instructions`，`messages`/`input` 逐字）；guard 删 `memory_mode==="inject"` 禁用项 → **直通可与 memory 同触发**。observe 路零改。取舍：放弃实时会话压缩（helm 只贡献长期召回）、memory 前置**位移 prompt-cache 前缀**（次日 [[尾部 system-reminder 修订]]改为缓存保留）。旧 full-replace/D7/recent_raw 测试全按前缀模型重写、新增 `native-memory-inject.test.ts`；3263/3264 绿（唯一红=admin-oauth 预存 flake）。

### 2026-06-13 · 原生协议透传 Phase 3 — openai_responses（Codex）同协议直通（docs/05；原则 1/5/8）：把 verbatim 转发从 anthropic 扩到 openai_responses——`/v1/responses`→codex pool 时客户端 native Responses body（仅 `model` patch 成上游 id）逐字转发、上游 SSE 字节直传，跳过 `responses→IR→responses` 往返（保住 `reasoning.encrypted_content`/tools）。机制全协议中立（guard/execute/serialize-client/pool 零改，Phase 1/2 已泛化），Codex client 的 `nativePassthrough`/`Stream` + `usageFromResponses*` 已就位；本阶段实改两处：messages-pipeline 透传 tee 改协议感知（`splitSSEFrames`/`usageFromResponsesSSE`/`accumulateResponsesAssistantText`/usage-frame 过滤泛化）+ responses.ts route 镜像 messages.ts（`native_request` 盖戳、流绕过 `transformStreamOut`、`isResponsesPreludeEvent` 泛化认 `event.event` 丢上游重复 prelude）。Anthropic 行为逐字节不变。Gemini 推迟（无原生 client）。三目标 91 绿、gateway routes 459 绿。

### 2026-06-13 · 原生协议透传 Phase 2 — Anthropic 流式直通（docs/05；原则 8）：上游 Anthropic SSE **字节级直传**（透传路径上彻底消灭 `convertOpenAIStreamToAnthropic` 重映射状态机，仅 SSE 信封由 `writeSSE` 重成帧）。`provider/anthropic.ts` 加 `nativePassthroughStream`（body 原样发、`readAnthropicSSERaw` 复用 `readChunkWithIdle` idle 守卫零翻译）+ OAuth pool 转发；`peekStream` 重构吃 stream thunk 同服两路、首包前抛错→`recordFailure` 链推进契约不变；guard 删 `stream_not_supported_phase1`；治理 tee（usage `usageFromAnthropicSSE` / observe-outbound / payload）只读拷贝不改转发字节；`native_request` 流式也盖戳、messages.ts 流式 `nativePassthrough` 时跳 `transformStreamOut`。live e2e（真实订阅，本地 docker）抓出并修 2 集成 bug（commit 384c153）：serialize-client(#93) 只转发 chat* 方法吞掉 native（按同 lease 转发 + 诚实特性探测）、execute 透传含路由别名 model→上游 404（patch 成 providerModel）。全量 3208 绿。

### 2026-06-13 · 原生协议透传 Phase 1（docs/02/05；原则 1/7/8）：取代零收益的 #225（openai_chat→openai_chat），把入站==上游原生协议时的 4 次有损翻译（#221/#222 bug 住所）改为 verbatim 转发。carrier `InternalRequest.native_request`（仅 anthropic 面经 `ir.metadata` 设）；可选 `ProviderClient.nativePassthrough?` 复用既有 HTTP core 跳过 to/from 翻译（OAuth pool 必须转发否则探测恒 undefined）；纯函数 guard `canUseNativePassthrough`（禁用原因有序、首失败胜出）；结果旁路 `nativePassthrough?:boolean` 让 collect 跳 `openAIBodyToIR`/route 跳 `transformResponseOut`、cost 用 `usageFromAnthropicResponse` 归一；flag `native_protocol_passthrough`（Zod default false，admin normalize 必须认否则静默重置）。Phase 1 范围=非流式 anthropic→anthropic；R7 计费块、observe-outbound 重建为已知 fail-open 简化。

### 2026-06-13 · OpenAI/Responses/Gemini 协议互译保真补丁（docs/05；原则 1/7/8）：补另外三协议 native→IR→native 丢真点——`IRImagePart` 加 `detail`（OpenAI Chat/Responses 双向保留）、OpenAI `file` 的 `format` 随 `IRDocumentPart.mediaType` 重发、Responses `function_call_output.output` multipart 出站发 content-part array（`output_text`/`input_image`/`input_file` 保 `filename`）+ reasoning item 重放去 `status`、Gemini tool-result 加 message-level `provider_raw.gemini_function_response` 恢复原始 object（OpenAI 出站剥离 message-level provider_raw 防泄漏）、Gemini `transformStreamIn` tool slot 改按 `name + frame occurrence` 修同名并行 functionCall 覆盖。取舍：message-level provider_raw 仅承载无法进通用 IR 的 native 结构；reasoning `status` 可捕获但不重放（Responses input 拒收）。focused protocol tests 177 绿。

### 2026-06-13 · Anthropic 互译保真：tool_result 多模态 + thinking/redacted_thinking 历史块（docs/05；原则 1/7/8）：Anthropic native→IR→native 三处丢真——`tool_result.content` 的 block[] 把 image/document JSON 字符串化、document `title` 不进 IR `filename`、assistant `thinking`/`redacted_thinking` 历史块与缓存命中合成 SSE 无法按原块恢复。修：`request.ts` 把 tool_result text/image/document 映射成 IR multipart tool message 并 `transformRequestIn` 重发 block[]，title↔filename 双向，`thinking_blocks` 挂 IR message 出站排在可见块前；`provider/anthropic.ts` 同步订阅执行器避免 JSON.stringify/丢 thinking；`response.ts`/`stream.ts` 加 `redacted_thinking`（response 入站进 message.thinking_blocks、IR→response 精确保留、SSE 入站映射 redacted delta、合成 SSE 同状态机输出），`reasoning.ts` 不再把 redacted 解析成空 visible thinking。TDD 红→绿，focused 203 绿、typecheck/lint 全绿。

### 2026-06-12 · Claude Code 计费归因块：入站剥离 + 透传客户端真实版本重注入「可缓存」头（docs/05；anti-ban；原则 1/4/7）：helm 无 bug——Claude Code ≥2.1.29 把逐请求轮换的 `x-anthropic-billing-header`（cc_version.3hex / cch.5hex 都是内容哈希）注入 `system[0]`，破坏 prompt cache 前缀（生产实测每轮 cached_tokens=0、≈10× 重算）。三层修复（用户拍板 Plan B）：① `transformRequestOut` `stripBillingHeader` 剥块 + `extractBillingHeaderIdentity` 严格正则抓 cc_version/entrypoint（畸形→null）；② `messages.ts`→`ir.metadata.client_billing_header`→`InternalRequest.metadata`（≤128，纯网关元数据不上 wire）；③ 订阅路 `billingHeaderBlock` 回写客户端真实版本（无则 `FALLBACK_CLAUDE_CODE_VERSION=2.1.175` 兜底）、**cch 改按 SHA-256(稳定 system) 派生**（跨同会话恒定→缓存命中），UA `userAgentFromBody` 与块永不矛盾。取舍：字节级仿真与命中缓存本质冲突，选可缓存（cch 是归因 telemetry，封号风险忽略）；CLI 走透传、非 CLI 走兜底（执行器不止服务 CC，`claude-opus` lane 也收 OpenAI 形请求，UA 身份头 load-bearing）。TDD 1071 绿。

### 2026-06-12 · 首页 Token 计量 dashboard：新增 usage 反范式化持久化、`/admin/api/stats` SQL 聚合、LayerChart token 趋势/模型占比；forward-only 不回填历史，SQLite/PG 迁移分别 v22/v21，typecheck/lint/test 验证。

### 2026-06-12 · 四协议互译保真补丁（Responses tool_choice / Anthropic native controls / Gemini safety；docs/05/07）：Responses `tool_choice` 双向规范化并对缺本地历史的 `previous_response_id` tool-output continuation fail-closed；Anthropic native controls 进 `provider_raw` 并补 beta header；Gemini `safetySettings` round-trip；focused 244、typecheck、lint、完整 test 绿。

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
