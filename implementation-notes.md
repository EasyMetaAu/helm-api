# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-07-04 · memory worker 受控并发追赶（Memory worker / scheduler，docs/08/12，原则 3/7）

- **背景（Lukin）**：线上 `/admin/memory` 显示队列持续运行但追赶很慢；生产采样显示 worker 没有卡死，CPU/内存仍有余量，但 open queue 基本维持在约 500，旧 idle-flush backlog 很难明显下降。
- **根因**：上一版已经把 `batchSize` / `maxBatchesPerDrain` 做大，但 worker 在一个 batch 内仍逐条 `await` LLM 任务。单纯继续调大 batch 只会让更多 job 长时间停在 `running`，不一定提升吞吐，还会让一次 drain 持续更久。
- **调度决策**：`MemoryWorkerDeps` 新增 `concurrency`，默认 1 以保持 core 旧调用行为；gateway 默认 `HELM_MEMORY_WORKER_CONCURRENCY=3`，同一 claimed batch 内最多并发 3 个 job，让 LLM-bound observer/reflector 任务并行等待上游返回。
- **安全决策**：gateway 对 `HELM_MEMORY_WORKER_CONCURRENCY` 硬封顶 8；仍保留 `batchSize`、`maxBatchesPerDrain`、`maxDrainMs`、批次间 yield 与 wake debounce，避免在 1GB 自托管容器上产生无上限后台 LLM fan-out。
- **运维建议**：生产先用默认 3 观察；若 CPU/内存仍低且 `done_1m - enqueued_1m` 不够，可逐步调到 4/5；不要直接把 batch 调到几百来追赶，因为那会增加 running lease 和单轮 drain 风险。
- **验证计划**：新增 scheduler 并发上限回归，覆盖同 batch 只启动 N 个任务、前一个完成后才启动下一个；再跑 memory scheduler、admin memory 页面、typecheck、lint、build。

## 2026-07-04 · 记忆页只读运行状态面板（Admin memory observability，docs/08/11/13，原则 1/7）

- **背景（Lukin）**：`/admin/memory` 只能看到已经形成的 facts/reflections，看不到 raw message 是否还在进入、后台 job 是否在跑、队列是否滞后或是否有 running lease 卡住；排障需要直接查日志/SQLite。
- **接口决策**：新增 `GET /admin/api/memory/stats`，复用记忆页现有 scope/key 过滤语义，返回线程、消息、观察、事实、反思、job 状态分布、最早 pending/running、最近 activity 与生成时间。
- **安全/性能决策**：接口只读、无请求正文、无明文 key/payload 输出；统计用 count/max/min 聚合，不触发 worker、不创建 job、不读取正文内容。全局视图直接聚合原表，只有选中 scope/key 时才 join scope 过滤，避免打开页面就反复扫全量 join。缺少 stats 能力的 store 返回 503，不影响现有记忆管理和网关请求路径。
- **UI 决策**：记忆页顶部增加状态面板，15 秒轻量刷新一次；按当前选中的 scope/key 同步切换，能直接看到 queued/running/stale、滞后时间、raw input、learned output 和 jobs by type。
- **验证计划**：覆盖 SQLite/Postgres store 聚合、admin route、admin 页面加载/筛选联动与 locale 文案；再跑目标 Vitest、typecheck、lint/build。

## 2026-07-04 · Claude scoped weekly quota 不触发账号级限流（Admin providers / OAuth quota，docs/04/11，原则 3/5/7）

- **背景（Lukin）**：providers 页出现 `7d · Fable` 100% 后，账号被显示为“已限流”，并且路由池把整个 Anthropic OAuth 账号排除；但账号级 `7d` 全模型额度仍有余量，只有 Fable / Sonnet 这类 scoped model cap 不可用。
- **根因**：`windowsToUsageLimit()` 与 `windowsToActiveUsageRecovery()` 把所有 100% quota window 都当作账号级 limiter；`7d-fable` / `7d-sonnet` / `7d-opus` 这种 scoped weekly model window 因而被错误写入 `usage_limited_until_ms`，扩大成全账号 cooldown。OAuth pool 的 429 backstop 也没有区分 Anthropic 模型级 429。
- **语义决策**：只有账号级窗口（`5h`、`7d`、Codex `primary/secondary` 等非 `7d-*` key）能 park 整个账号；`7d-*` 只说明对应 Claude 模型的周限额已满，不能阻止同账号继续服务其它模型。
- **执行路径决策**：Anthropic `claude-fable-*` / `claude-sonnet-*` / `claude-opus-*` 的 429 不写全局 cooldown；当前请求仍可在池内尝试 sibling account 或交给执行 fallback，但不会把该账号从所有模型的调度池里移除。
- **UI 决策**：providers 页渲染“已限流”时只用账号级窗口解释恢复时间；如果页面已有账号级窗口且它们未触顶，旧的全局 cooldown 不再显示为 active rate limit。
- **验证计划**：新增 core quota helper、OAuth pool、admin `/oauth/quota`、providers 页面回归测试，覆盖 Fable/Sonnet scoped window 100% 但 `7d` 仍有余量时不触发账号级限流。

## 2026-07-04 · 跨协议 reasoning 历史不兼容按候选跳过（执行 fallback / 协议转换，docs/04/05/07，原则 3/5/8）

- **背景（Lukin）**：Claude/Anthropic thinking-mode 请求在 fallback 到 OpenAI-compatible DeepSeek（如 `deepseek/deepseek-v4-pro`）时，多次暴露 `400 invalid_request: The reasoning_content in the thinking mode must be passed back to the API.` 给客户端。
- **根因**：Anthropic 原生历史不携带 OpenAI/DeepSeek 风格的 assistant `reasoning_content`；如果跨协议 fallback 仍把 Anthropic `thinking` 控制或不适配的 `reasoning_effort` 带到 OpenAI-compatible 上游，DeepSeek 会把它理解成 thinking-mode continuation，并要求上一轮 assistant reasoning history 原样回传。
- **出站改写决策**：跨协议转到 OpenAI-compatible wire 时剥离 Anthropic `thinking` 控制；当 catalog 已知该目标没有 OpenAI reasoning wire 支持时，同时剥离 `reasoning_effort`。同协议 Anthropic passthrough 和真正支持 reasoning wire 的 OpenAI-compatible 目标不受影响。
- **fallback 决策**：`reasoning_content` + `thinking mode` 的上游 400 不是全局 request-shape 错误，而是当前候选模型/协议组合缺历史字段；执行器记录 `skipped:true` + `skip_reason:"reasoning_history_incompatible"`，不熔断 provider，继续尝试后续候选。
- **边界**：其它确定性 400/413/422（例如坏参数、图片过大）仍按 `invalid_request` 终止，因为换候选无法修复请求本身。这里只针对明确的 reasoning-history 缺失错误 fail-open。
- **验证**：新增执行器回归覆盖跨协议剥离 thinking/reasoning 控制，以及 DeepSeek 类 400 后继续 fallback；目标 `execute.test.ts` 119/119 绿，`pnpm typecheck` 绿，`pnpm lint` 退出 0（仅既有 style info）。

## 2026-07-04 · memory idle-flush 防饥饿与受控追赶（Memory worker / store，docs/08/12，原则 3/7）

- **背景（Lukin）**：生产 `openclaw` key 已持续写入 raw memory，但 `/admin/memory` 看不到事实/反思；排查发现后台 worker 不是完全停了，而是大量旧项目候选反复进入 idle-flush 队列，导致新项目长期排不到。
- **根因**：Observer 实际按 `message_index, created_at, id` 读取消息并生成 `source_message_range`；但 `listIdleFlushCandidates()` 用 `created_at/id` 判断 observation 覆盖范围。旧线程在 observer 顺序下已覆盖，却在候选 SQL 里被误判为未覆盖，形成永远不会消失的假候选。
- **查询决策**：SQLite / Postgres 的 idle-flush 候选判断改用与 `listMessages()` 完全一致的 tuple order，并支持 range 两端反向的历史数据；这样同一线程被覆盖后会真正退出候选集。
- **公平性决策**：候选排序增加 `ROW_NUMBER() OVER (PARTITION BY owner_id, project_id, resource_id ...)`，按 scope rank 交错输出，避免 `ww/luke/skillstore` 这类旧项目 backlog 独占整页，使 `openclaw` 这类新项目也能进入处理窗口。
- **追赶决策**：worker 支持单次 tick/wake 连续 drain 多批，但仍是串行执行；gateway 默认 `batchSize=50`、`maxBatchesPerDrain=10`、`maxDrainMs=30000`，并在批次之间让出事件循环。也就是说默认最多 500 个任务/轮，明显快于旧的 10/轮，但不会引入并发洪峰；线上可通过环境变量逐步调大。
- **索引/迁移决策**：新增 memory thread scope 索引与 message observer-order 索引；迁移只在目标表/列真实存在时建索引，兼容早期被部分标记为已迁移的自托管库和测试 fixture。
- **验证**：新增 SQLite/Postgres observer-order 覆盖回归、project fair-interleaving 回归、scheduler 多批 drain 与时间上限回归；目标 memory/scheduler/migration 测试 83/83 绿。

## 2026-07-03 · 策略级 reasoning_effort 覆盖 Lane 默认值（Routing policies / Admin policies，docs/04/11，原则 2/5/6）

- **背景（Lukin）**：Lane 已支持 `reasoning_effort`，但 policy 命中后只能强制车道，不能针对某类任务把思考等级调高/调低；这导致同一 Lane 内的请求无法按策略更细粒度控制推理预算。
- **语义决策**：Policy 新增可选 action `reasoning_effort`，与 Lane 使用同一严格枚举：`none|minimal|low|medium|high|xhigh|max`。最终优先级为 **policy > selected lane > client request**；其中 `none` 是显式覆盖，可关闭 Lane 的高思考等级。
- **first-match 决策**：`reasoning_effort` 跟 `use_lane` 一样取第一条命中 policy 的值；`allowed_lanes` 仍保持原有“所有命中策略取交集”的 cap 语义。这样不会让靠后的 restrict-only rule 意外改写思考等级。
- **执行路径**：`routeRequest` 在生成 `ExecutionPlan` 后用 `policy.reasoning_effort ?? lane.reasoning_effort` 覆盖 `req.reasoning_effort` 并设置 `reasoning_effort_forced=true`，复用现有 translated/native passthrough 出站改写链路，不触碰 provider 选择与 fallback 机制。
- **Admin 决策**：Policies 页面新增“Forced reasoning effort”下拉，复用 LaneEditor 的同一组选项；API client round-trip `reasoning_effort`，gateway 仍由 `PoliciesConfigSchema` 对整个 policy 列表 fail-closed 校验。
- **验证计划**：新增 shared/core policy schema、policy engine、routeRequest、admin API client、PolicyRow 回归测试；再跑目标 Vitest、typecheck/lint/build。

## 2026-07-03 · cron monitor 自动化请求降到低成本规则（Classifier / routing，docs/03/04，原则 2/4）

- **背景（Lukin）**：生产 `openclaw` key 的 monitor/cron 请求常请求 `gpt-5.4-mini`，但因 key 不允许 custom model，路由走分类器；请求带长历史、36 个左右工具和 `MONITOR.md` 文件路径，Layer-1 把它判成 `coding/medium`，最终第一候选落到 `openai-codex/gpt-5.5`。
- **根因**：这些工具和文件路径是自动化探针的环境能力，不代表当前用户 turn 是 coding 任务；`tools_floor`、`tool_count`、`detectFilePath()` 叠加后把“检查状态，无事不回复”的低成本请求误升到 coding/balanced 级别。
- **规则决策**：新增 `classifier.rules.overrides.low_cost_automation`，只有同时命中 `intent_markers`（如 `[cron:`、`MONITOR.md`）和 `no_reply_markers`（如 `NO_REPLY`、`nothing to action`）时，才 set 到 `simple`；普通“解释 NO_REPLY”不会触发。长历史不再让该自动化探针升档，真实窗口适配交给后续 capability filter。
- **task_type 决策**：低成本自动化模式下，task detector 忽略 ambient tool-prefix 和 file-path 证据，但仍保留显式 coding keyword（如 `debug/refactor/function`）的升级路径，避免真正要修代码的 monitor 任务被错误降级。
- **验证计划**：新增 openclaw cron monitor golden route 回归、override 单测、taskdetect 单测和 schema 默认值测试；目标是该形态走 `chat/simple/economy`，链首回到 `openai-codex/gpt-5.4-mini`。

## 2026-07-03 · 上下文窗口超限按候选跳过处理（执行 fallback / streaming telemetry，docs/04/07，原则 5/8）

- **背景（Lukin）**：生产请求 `69d5058f-ea6c-4bfc-91d8-0686a7c120f3` 最终由 `anthropic/claude-opus-4-8` 成功服务，但链中 `openai-codex/gpt-5.5` 先返回 Responses stream `context_length_exceeded`，admin 详情把它显示为普通 `upstream_error`。
- **修复决策**：`context_length_exceeded` / “context window” / “prompt is too long” 属于当前候选模型窗口不足；即使它来自首个有效输出前的 SSE error 且没有 HTTP 400，也记录为 `skipped:true` + `skip_reason:"context_too_small"`，继续执行 fallback。
- **熔断决策**：该类错误不调用 `breaker.recordFailure()`，不触发 OAuth 账号 auto-park，也不计入 execution fallback count；它和预检能力过滤的 `context_too_small` 语义保持一致。
- **保留边界**：非上下文类 request-shape 错误（例如图片尺寸超限、非法参数）仍短路为 `invalid_request`，因为换候选模型无法修复请求体本身。
- **验证**：新增执行器 stream 回归测试，覆盖 Codex Responses `context_length_exceeded` 先失败、后续 Opus 成功、首个 attempt 显示跳过且不记录 breaker failure；目标 `execute.test.ts` 117/117 绿。

## 2026-07-03 · API key 级 usage stats 给外部自动化读取（Gateway usage API / telemetry，docs/07，原则 7）

- **背景（Lukin）**：Skillstore 公开页需要每天同步 AI audit token / cost 快照；旧办法直接从 Helm SQLite 和 claude-relay Redis 取数，不适合作为长期自动化接口。新的来源应主要走 Helm 系统，并通过 API key 读取统计数据。
- **接口决策**：新增 `GET /v1/usage/stats`，复用现有 API-key auth，不挂 admin Basic Auth。默认 `start=0`、`end=now`，返回当前 key 的累计 request/token/cost 汇总；仍接受 `start/end/bucket/tzOffsetMinutes` 以便后续做日窗口或趋势同步。
- **隔离决策**：接口忽略 caller 传入的 `key_id`，只使用 `authMiddleware` 解析出的 `identity.keyId` 调 `TelemetryStore.aggregate(..., keyId)`；这样 Skillstore workflow 只能读它自己的 Helm key，不可能枚举其它 key 的用量。
- **返回形状**：返回紧凑 snake_case 机器格式：`prompt_tokens`、`completion_tokens`、`total_tokens`、`cost_usd` 等，避免让下游 workflow 依赖 admin dashboard 的 series/byModel 大结构。
- **限制 / TODO**：该接口反映 Helm telemetry 当前保留窗口内的数据；历史上还在 claude-relay 的用量需要 Skillstore 侧保留 legacy baseline 或临时兼容同步，等所有 audit 入口完全切到 Helm 后再移除 relay 补数。
- **验证计划**：新增 route 测试覆盖缺 key 401、当前 key 聚合、恶意 `key_id` 被忽略；OpenAPI 加入 bearer-secured usage endpoint。

## 2026-07-02 · API key 加密恢复与原地轮转（Auth / Admin keys，docs/06/11，原则 7）

- **背景（Lukin）**：管理后台原本只能创建后一次性显示 API key；如果操作员没有保存完整 key，只能删除或重新创建。现需支持查看已存在 key 的完整值，并支持不丢历史的轮转。
- **安全决策**：鉴权路径仍只用 `sha256(plaintext)` 查找；数据库不保存明文 key。新增 `api_keys.secret_enc` 只保存 AES-GCM 密文，复用 `HELM_OAUTH_ENC_KEY` 作为 at-rest 加密密钥。未配置该密钥时，新建/轮转仍返回一次性 plaintext，但后续 reveal 不可用。
- **兼容决策**：已有 hash-only 行无法从 sha256 反推出完整 key，因此管理后台 reveal 会明确返回不可恢复；操作员可对该行执行 rotate，让同一个 `key_id` 获得新的 hash/prefix/secret_enc。
- **轮转决策**：`KeyStore.rotateKey()` 只替换 `hash`、`prefix`、`secret_enc`，保留 `key_id`、name、role、account、caps、usage 与 telemetry 关联。旧 key 值立即失效，但请求历史仍挂在同一 key 下。
- **UI 决策**：Keys 页面新增「View full key」和「Rotate」。Reveal/rotated plaintext 只存在短暂 modal state；普通 list/detail 仍只显示 prefix，不返回 hash、plaintext 或 ciphertext。
- **验证计划**：覆盖 store contract（SQLite/Postgres）、cached keystore、admin routes、admin API client 与 Keys 页面交互；旧 hash-only 行 reveal 失败、新/轮转行可 reveal。

## 历史条目摘要（最近 2 条）

- **2026-07-02 · Claude Fable 周限额改读 `limits[]`（Admin providers / OAuth quota，docs/11，原则 3/7）**：Anthropic quota parser 优先读取新 `limits[]` weekly scoped payload，并在 providers 页显示 `7d · Fable` 等模型级周限额。
- **2026-07-02 · OAuth 测试成功与 quota PULL 同步账号可用状态（Admin providers / OAuth cooldown，docs/04/11，原则 3/5/7）**：已 park 账号的成功 quota PULL/Test 会用真实 quota 状态替换或清空旧 cooldown，并刷新 providers 页状态。

## 更早历史总览

2026-06-30 及以前的工作主要围绕 Helm API 的协议面、路由执行、admin 可观测性与自托管部署逐步成型：补齐 Gemini/OpenAI/Anthropic/Responses 双向转换、SSE 流式正确性、tool-call/JSON schema/思考参数保真、per-model reasoning effort、模型别名与能力/成本目录、provider fallback 与熔断语义、OAuth subscription providers、多账户池与 quota 处理、memory observe/inject/forgetting/admin/MCP、请求 payload 捕获与 request detail UI、API key 治理、admin 表格/过滤/分页/i18n、Docker/CI/release/deploy 验证，以及早期 Phase 0 的 Hono + SvelteKit static admin + Store 端口 + SQLite/Supabase 架构决策。更早细节不再逐条保留在本文件；需要精确背景时回查 git history。
