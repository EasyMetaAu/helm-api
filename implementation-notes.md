# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-07-04 · cheap-model 短低风险当前轮不被长历史抬价（Classifier / routing，docs/03/04，原则 2/4/5）

- **背景（Lukin）**：生产 `openclaw` 24h 数据显示，部分请求显式请求 `gpt-5.4-mini` / cheap alias，最后一条 user 只有约 200 字且是 read/check/status 类低风险动作，但因为完整 transcript 很大、tools 很多，被 Layer-1 长上下文/工具信号抬到 `balanced/coding`，最终使用 `gpt-5.5`。
- **规则决策**：新增配置化 override `cheap_model_low_risk`。只有 `requested_model` 命中配置 cheap markers、最后一条 user 在 `current_turn_max_chars` 内、命中低风险 marker、且没有 blocked marker 时，才把 complexity 设为 `simple`。判断只看当前 user turn，不用历史正文。
- **安全边界**：显式 `gpt-5.5` 请求不受影响；JSON response_format、vision attachment、代码变更/调试/部署/安全/数学等 blocked marker 均不触发。真正的窗口 fit 和 provider 能力仍交给后续 capability filter / fallback。
- **配置取舍**：默认 markers 包含 `economy`、`gpt-5.4-mini` / `gpt-5.4-mini-*` / `spark`、`deepseek-v4-flash`、`claude-haiku` 及其主要 provider/dating 形态，但没有把 `gpt54` 当成 economy hint，避免把用户想要的中档模型继续压到 mini。
- **验证计划**：新增 override 单测和 golden routing 回归，覆盖 cheap-model 短低风险长历史降到 economy、重模型请求不降级、code-changing/JSON/vision 不触发；再跑 targeted Vitest、typecheck、build。

## 2026-07-04 · 视觉上下文压缩以 observe/off 为默认接入（Request optimizer / native Anthropic，docs/04/05/07/11，原则 1/3/5/7/8）

- **背景（Lukin）**：pxpipe 证明“密集文本渲成图片”在特定模型/价格结构下可能降低输入 token 成本，但该方法不是无损压缩；模型视觉路径会丢失精确字符串、数字、路径、hash、ID 等细节。
- **产品决策**：运行时设置新增 `visual_context_compression: off|observe|enabled`，默认 `off`。`observe` 会在副本上跑压缩并记录 would-apply telemetry，但实际仍发送原始文本；`enabled` 才会发送压缩后的 body。
- **执行边界**：MVP 只接 Anthropic native passthrough。它在当前候选 provider 调用前工作，不改变 lane、candidate chain、provider selection、fallback_count 或 breaker 语义。压缩失败 fail-open 回原 body，只记安全日志，不算 provider fault。
- **上下文窗口决策**：Anthropic `count_tokens` 预检前先尝试压缩，因此“原文超窗口但压缩后可进入窗口”的候选不会被过早 `context_too_small` 跳过。非 passthrough/非 Anthropic/非 vision-capable 目标保持原行为。
- **安全决策**：core 包装器内置 `keepSharp`，命中 UUID/hash/长数字/URL/path/line-ref/secret-like/request-id 等精确字段时保留文本，避免把必须逐字可靠的内容压进图片。DecisionRecord 只存计数、reason、image_count/image_bytes 等无正文摘要，不存 PNG 或 imaged source text。
- **实现取舍**：不把几 MB 字体 atlas 复制进 Helm；直接依赖 pxpipe 的公开 `transformAnthropicMessages` 渲染器和 gate。这样保持 Helm core 的 headless 约束，也让后续 pxpipe 修复可通过依赖升级吸收。
- **验证计划**：新增 shared runtime schema、core optimizer、gateway execute、admin settings API 回归；再跑目标 Vitest、Svelte check、typecheck、lint、build。

## 2026-07-04 · Memory stats 队列统计避免扫全量历史 job（Admin memory performance，docs/11/13，原则 1/7）

- **背景（Lukin）**：线上逐页排查 admin API timing 后，绝大多数接口在 1–20ms，`/admin/api/oauth*` 稳定约 140–160ms；真正稳定慢的是 `/admin/api/memory/stats`，每次约 8.6–11.2s，导致 Memory 页面打开/刷新时明显卡住。
- **根因**：生产 `memory_jobs` 已接近 10 万行且全部为历史 `done` job。stats 接口每次刷新都用 `CASE WHEN status = ...` 对整张 job 历史做时间统计，又额外做 `type/status` 汇总；这些读是同步 SQLite 路径，会阻塞 Node 事件循环，放大成后台页面卡顿。
- **查询决策**：队列时间统计拆成按状态查询：pending 查最早 `created_at`，running 查最早/过期 `updated_at`，done/failed 查最新 `updated_at`。这样没有 open job 时不再为几个空指标扫描全部 done 历史。
- **索引决策**：SQLite/Postgres 都新增 `memory_jobs(status, updated_at, created_at)` 与 `memory_jobs(type, status)`，分别服务状态时间统计和 jobs-by-type 汇总；迁移对缺少 `memory_jobs` 的老 fixture/部分升级库保持兼容。
- **保持不变**：返回 JSON 语义不变；仍然是只读 admin observability，不读取 message body、不输出明文 key/payload、不触发 worker。
- **验证计划**：覆盖 SQLite/Postgres stats 返回语义和迁移索引存在性；部署后用线上 `/admin/api/memory/stats` timing、`/admin/memory` 浏览器点击、`/healthz`/`/version` 验证。

## 2026-07-04 · OAuth 账号池改为会话亲和调度（OAuth provider pool / routing，docs/04/11，原则 3/5/7）

- **背景（Lukin）**：订阅 provider 有多个账号时，单纯 priority + LRU 轮询会让同一客户端会话在多个账号/多个上游设备身份之间漂移，容易呈现“账号池”特征。目标是同一 session/device 尽量固定到同一账号，只有账号不可用、额度/限流、或账号容量已满时才切换，同时让多个账号在新会话维度尽量均衡使用。
- **调度决策**：OAuth pool 优先从显式 `device_id` / `metadata.device_id` / `metadata.user_id` JSON envelope 里的 `device_id` 生成 affinity key；没有 device 信号时再使用 `prompt_cache_key`、`session_id`、`conversation_id`、`metadata.session_id/conversation_id/thread_id/user_id` 等稳定会话信号。有 key 时在最低 priority 的可用账号集合里用 rendezvous hashing 选择账号，保证新会话均衡分布且进程重启后仍尽量落到同一账号。无 key 的请求保留原 LRU 行为。
- **Responses 连续性决策**：`previous_response_id` 不再作为 hashable affinity key，因为它会随轮次变化；只有 pool 已经从成功的非流式响应 `id` / `response.id` 记录过“这个 response 由哪个账号产生”时，后续同 id 才作为 sticky hit 回到原账号。未知 `previous_response_id` 回到 LRU，不制造假粘性。
- **容量决策**：per-account user-message queue 新增 `wouldQueue()` 探针。账号被锁住、已有等待者、或仍在请求间隔窗口内时，pool 会优先选择同池其它可用账号；若所有账号都会排队，则回到 deterministic target 并让队列等待，避免无账号可用时误报 provider down。用户 turn 判定同时覆盖 Chat `messages[]` 和 Responses `input`，避免 Codex native `/v1/responses` 绕过队列。
- **切换边界**：401/403、429/usage cooldown、pre-output transient fault、以及账号队列 timeout 都作为账号级切换原因处理；确定性 4xx 仍不切 sibling。账号级限流仍会 forget 当前 sticky，避免后续会话继续命中不可用账号。
- **观测决策**：`oauth.pool.select` 日志只记录非敏感选择元信息（`selection_reason`、`affinity_key_source`、`capacity_avoided`、`busy_eligible_accounts`、`retry_attempt`），不记录具体 device/session key 值，便于生产验收“切换只因故障/额度/容量压力”。
- **验证计划**：新增 OAuth pool affinity/capacity 单测、serial gate `wouldQueue()` 单测、gateway `synthesizeOAuthProviders` 集成测试；再跑相关执行器回归、全量 Vitest、typecheck、lint、build 和 Playwright e2e。

## 2026-07-04 · idle-flush 碎片段优先压缩最大连续段（Memory Observer，docs/08/12，原则 3/7）

- **背景（Lukin）**：线上 `v0.23.0` 后记忆队列仍持续运行，排查发现总候选不是 30 多万 job，而是约 3.07 万个 idle candidate thread；最近完成的 observer 基本不会重新成为候选，未见大面积死循环。
- **边界问题**：个别超长历史 thread 已被旧 observation 切成很多碎片段。Observer 在 idle 模式下原本选择“第一个可压缩段”，如果最前面只是 1 条 message 的小洞，就会一次 internal LLM 只压缩 1 条，形成有限但很慢的长尾。
- **调度决策**：idle-flush 下仍然不把稀疏集合写成一个虚假的连续 `source_message_range`；但在多个可压缩连续段之间，优先选择 `compressedTokens` 最大、再按 `compressedCount` 打破平局的段。这样 source range 仍精确，同时优先消掉大尾巴，避免一个超长 thread 反复消耗小段 LLM 调用。
- **跳过决策**：新增可选 `compaction.idle_flush_max_age_s`，让 idle-flush 只处理最近窗口内变 idle 的 thread；线上可设 `86400` 跳过超过 24 小时的旧 backfill，避免为历史冷数据继续消耗 internal LLM token。未配置时保持旧行为。
- **保持不变**：非 idle 的 writeback/size/context-pressure 路径仍选最早可压缩段，保持时间顺序和已有 cache/keep 语义；open-job dedupe、worker 并发和 idle candidate SQL 不变。
- **验证计划**：新增 Observer 回归测试，覆盖 idle 且前方有 tiny gap、大段未覆盖尾部时选择最大段；新增 config/idle-flush/store 回归覆盖 max-age 窗口；再跑目标测试、typecheck、lint、build。

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

## 历史条目摘要（最近 2 条）

- **2026-07-03 · cron monitor 自动化请求降到低成本规则（Classifier / routing，docs/03/04，原则 2/4）**：monitor/cron + no-reply 标记命中时降到 `simple/economy`，但保留显式 coding keyword 升级路径，避免自动化探针误打高价模型。
- **2026-07-03 · 上下文窗口超限按候选跳过处理（执行 fallback / streaming telemetry，docs/04/07，原则 5/8）**：`context_length_exceeded` / prompt-too-long 类错误按候选 `context_too_small` 跳过并继续 fallback，不熔断 provider。

## 更早历史总览

2026-06-30 及以前的工作主要围绕 Helm API 的协议面、路由执行、admin 可观测性与自托管部署逐步成型：补齐 Gemini/OpenAI/Anthropic/Responses 双向转换、SSE 流式正确性、tool-call/JSON schema/思考参数保真、per-model reasoning effort、模型别名与能力/成本目录、provider fallback 与熔断语义、OAuth subscription providers、多账户池与 quota 处理、memory observe/inject/forgetting/admin/MCP、请求 payload 捕获与 request detail UI、API key 治理、admin 表格/过滤/分页/i18n、Docker/CI/release/deploy 验证，以及早期 Phase 0 的 Hono + SvelteKit static admin + Store 端口 + SQLite/Supabase 架构决策。更早细节不再逐条保留在本文件；需要精确背景时回查 git history。
