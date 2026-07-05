# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-07-05 · 避免浪费策略纳入周额度与 Codex reset credits（OAuth provider pool / quota，docs/04/11，原则 3/5/7）

- **背景（Lukin）**：`use_expiring` 不能只看单个快重置窗口；用户实际关心的是 5 小时额度、周额度，以及 Codex 账号还剩多少次 reset credit。周额度快到 reset 且还有大量剩余额度时应被优先使用；有 reset credits 的账号也具备额外恢复能力，应进入评分。
- **评分决策**：`use_expiring` 从“取最佳单窗口”改为“汇总适用窗口分数”：每个窗口按 `(100 - usedPercent) / hoursUntilReset` 计分，周额度窗口（Codex `secondary` / Anthropic `7d*` / 7 天窗口）加权更高；Codex reset credits 作为折扣后的虚拟周窗口加分，影响账号选择但不触发消费。
- **安全边界**：选择策略只把 reset credits 当软评分信号，不会自动花掉 credit。真正消费仍走手动 Reset limit / auto-reset 的硬门禁（weekly snapshot、阈值、guard、审计）。
- **实时性修正**：providers 页 `/oauth/quota` PULL 成功后不只写入 `oauth_quota`，还会刷新当前 live OAuth pool 的 soft quota snapshot；Anthropic/Codex 的新鲜 quota 不再必须等待下一次 rebuild 才影响策略。
- **验证计划**：覆盖 `use_expiring` 汇总短窗口+周窗口、reset credits 参与评分、SQLite/Postgres reset_credits round-trip 且 header PUSH 不清空、admin quota PULL 写库并刷新 live pool；再跑 targeted Vitest、typecheck、lint、build。

## 2026-07-05 · Codex reset-credit 消费改为硬门禁（OAuth quota / Admin providers，docs/04/11，原则 3/5/7）

- **背景（Lukin）**：Codex rate-limit reset credit 是稀缺上游额度，不能因为 providers 页刷新、容器重启、持续 saturated header 或误开 auto-reset 而快速消耗。既要保留手动/自动恢复能力，也要默认 fail-closed 保护 reset credits。
- **消费门槛**：手动和自动 reset-credit consume 都必须看到 Codex weekly `secondary` window，且 `usedPercent >= 90`；5h `primary` window 自恢复，永远不能作为花费 reset credit 的理由。缺少 quota snapshot 时手动接口返回 409，不直接 PULL 上游再消费。
- **自动 reset 边界**：auto-reset 仍只在 weekly `secondary >= 100` 时尝试；手动和自动消费都共享同一持久 guard：同一 shared ChatGPT account 一小时内只能 reserve 一次，同一 weekly window 只能 reserve 一次。guard 写在 `config_kv`，key 只含 shared account 的 sha256，不保存 ChatGPT id 明文。
- **并发/重启决策**：进程内 shared-key in-flight 折叠同进程 sibling burst；真正的一小时 reservation 用 `ConfigStore.setIfMissingOrNumericLte` 在 SQLite/Postgres 单条 SQL 原子抢占，防多实例同时 read-then-write 双消费；持久 `window` guard 防同一 weekly window 在冷却过后继续消费。guard/store 出错或缺少原子 reservation 能力时 fail-closed，宁可不 reset，也不能快速烧额度。
- **审计决策**：`consumeCodexResetCredit` 生成并记录 `redeem_request_id`；auto-reset 在上游 consume 成功后立刻打 `oauth.auto_reset.consumed`，本地 unpark 失败单独记 `oauth.auto_reset.unpark_failed`，避免“credit 已花但日志看起来像 consume 失败”。
- **UI 决策**：providers 页 `Reset limit` 按 weekly >=90、resetCredits >0、quota snapshot 存在才可点；确认弹窗里的 auto-reset 勾选只在 consume 成功后保存，失败不会悄悄开启未来自动消费。
- **验证计划**：覆盖纯 eligibility、持久 cooldown、跨 guard 实例原子抢占、同 weekly window 手动/自动去重、admin route fail-closed、redeem id 审计、providers 按钮禁用和失败不保存 autoReset；再跑 targeted Vitest、store contract、gateway typecheck、admin svelte-check、Biome/Prettier。

## 2026-07-05 · OAuth 账号池支持可选额度使用策略（OAuth provider pool / routing / Admin providers，docs/04/11，原则 3/5/7）

- **背景（Lukin）**：订阅 provider 的多账号池不只有一种合理用法。有的用户希望低风险、少 429、尽量均摊；有的用户希望避免额度浪费，把快重置且还剩较多额度的账号优先用掉；有的用户希望完全按自己设置的 priority 操作。
- **产品决策**：策略是全局账号池级别，而不是 account 级别，也不是每个 provider 单独配置。用户选择的是“整个系统如何使用订阅账号额度”；该策略在每个订阅 provider 的账号池内统一生效。跨 provider/model 的选择仍由 lanes/policies/fallback 负责，不被这个账号策略替代。
- **策略集合**：`balanced` 保持现有 sticky/hash/LRU 均衡；`manual_priority` 按 priority + LRU 分配新会话，已有会话继续 sticky；`low_risk` 在最低 priority 层里优先选择 quota pressure 更低的账号，降低打到上限/429 的概率；`use_expiring` 优先使用“剩余额度多且离 reset 更近”的窗口，目标是减少快重置前未用完的额度。
- **额度语义**：quota windows 只作为软评分输入，缺失或超过 freshness 窗口时自动回退到 balanced 行为；`usageLimitedUntilMs` 仍是硬调度门禁。Codex reset credits 只在 `use_expiring` 中作为折扣后的软评分信号，不会自动触发消费；真正消费仍只在手动/auto-reset 流程里发生。
- **会话边界**：`previous_response_id` 是强亲和，必须回到产生该 response 的账号，即使 quota 策略觉得另一个账号更优；普通 sticky 会话在 quota 策略下只允许在软阈值内保持，以避免长期卡在高压账号。
- **Scoped quota 边界**：Anthropic `7d-*` scoped windows 只在当前模型匹配对应 slug 时参与评分，不扩大成全账号压力或全账号 cooldown。
- **实现路径**：core OAuth pool 统一负责策略选择；gateway 从 encrypted global OAuth settings 读取策略，启动/热重建时注入所有订阅账号池，并把 quota snapshots seed 到 pool member；Codex header PUSH 捕获后即时刷新 live pool member 的软 quota snapshot。Admin Providers 页面提供一个系统级下拉选择，保存后热重建生效。
- **验证计划**：覆盖 core 策略、provider settings round-trip、admin API、Providers UI、Svelte check、typecheck、lint；SQLite-backed 测试依赖本地 `better-sqlite3` ABI，若本机 Node ABI 不匹配需先重建 native addon。

## 2026-07-04 · internal LLM prompt 输入用 XML 数据边界隔离（Memory / classifier eval，docs/03/08/12，原则 3/4/7）

- **背景（Lukin）**：生产 request `4fa73a51-56d3-4f40-a34d-7ce1e9d1194b` 显示 `internal-llm` key 的一次普通 chat self-call 把任务规则、runtime context、群聊历史和输出契约拼在同一个 user message 里；最后一条群消息包含“可以合并”等业务动作词，容易让小模型把 untrusted chat content 当成可执行指令或错误语境。
- **Helm 边界**：这条具体 Feishu reply-gate prompt 是调用方发给 Helm 的普通 `/v1/chat/completions` 请求，Helm 不能自动知道哪段是可信规则、哪段是聊天记录；调用方仍需把业务 prompt 改成 XML 分区。Helm 本次修复的是自己创建的 internal LLM prompt：Layer-2 classifier eval 与 memory observation/reflection/fact extraction。
- **实现决策**：新增 `prompt-boundary` helper，对 XML text 做 `&/< />` escaping；eval 把最后真实 user turn 包进 `<user_request>`；memory 把 schema/时间放进 `<trusted_task_json>`，把 raw messages / observations 放进 `<untrusted_messages_json>` 或 `<untrusted_observations_json>`。
- **安全语义**：system prompt 明确要求模型把 untrusted XML section 当数据而不是指令；用户内容里伪造的闭合标签会被转义，不能提前关闭数据区。现有 JSON output schema、temperature、timeout、fail-open fallback、日志不记录 prompt 的约束保持不变。
- **排查结论**：除 memory LLM 与 classifier eval 外，`memory-self-http` 只是把已构造请求走 loopback 以便观测，`memory-embedder` 是 embedding 输入，不是指令型 prompt；未发现第三个 Helm 自己拼自然语言 prompt 的 internal key 调用面。
- **验证计划**：新增 eval 与 memory prompt-boundary 回归，先证明旧实现裸放数据会失败，再验证 XML section 和 tag-breakout escaping；跑 focused Vitest、typecheck、lint。

## 2026-07-04 · 请求记录最终订阅账号并重排请求列表字段（Telemetry / Admin requests，docs/04/07/11，原则 1/5/7）

- **背景（Lukin）**：请求 telemetry 只能看到最终 model/provider alias，无法确认使用订阅 provider 时最后落到哪个具体订阅账号；排查成本、额度、限流和账号池调度时缺少每次请求的账号级事实。
- **记录决策**：`DecisionRecord` 新增 `serving_account: { provider_id, account } | null`。OAuth pool 仍只在执行深处通过 ALS 标记候选账号；真正落库前由 gateway 在最终结果已知后 stamp，避免 core/provider 合同依赖 Hono 或 admin。
- **防误记边界**：只有最终 `final.model_alias` 仍属于被标记账号的 provider 前缀时才记录账号；如果订阅账号候选失败后 fallback 到其它 provider，写入 `null`，避免把 stale selection 错记成实际服务账号。
- **尝试元数据决策**：`provider_attempts` 保留 `provider_name`、`provider_model`、passthrough/protocol mutation 等执行层已有元数据。Admin 只展示已记录字段，不从 alias 重新推断业务事实。
- **UI 决策**：请求列表字段按排障优先级重排为：Time、Status、Key、Provider、Subscription account、Served model、Requested model、Lane、Fallbacks、Latency、TPS、Tokens、Cost、Task、Complexity、Decided by、Error、Request ID。Trace ID 仍可点击但降到末尾；详情摘要同步露出 Provider / Subscription account，执行链路每个 attempt 显示 provider、账号、alias 与上游 wire model。
- **安全/隐私**：只记录 provider id 与订阅账号显示名，不记录 OAuth token、明文 API key 或正文；key 仍只显示 prefix。旧记录和非订阅 provider 统一显示 `—`/`null`。
- **验证计划**：覆盖 shared schema round-trip、telemetry builder 元数据保留、gateway stamp guard、admin mapper、请求列表/详情/执行链路渲染；再跑目标 Vitest、typecheck、lint、build。

## 2026-07-04 · cheap-model 短低风险当前轮不被长历史抬价（Classifier / routing，docs/03/04，原则 2/4/5）

- **背景（Lukin）**：生产 `openclaw` 24h 数据显示，部分请求显式请求 `gpt-5.4-mini` / cheap alias，最后一条 user 只有约 200 字且是 read/check/status 类低风险动作，但因为完整 transcript 很大、tools 很多，被 Layer-1 长上下文/工具信号抬到 `balanced/coding`，最终使用 `gpt-5.5`。
- **规则决策**：新增配置化 override `cheap_model_low_risk`。只有 `requested_model` 命中配置 cheap markers、最后一条 user 在 `current_turn_max_chars` 内、命中低风险 marker、且没有 blocked marker 时，才把 complexity 设为 `simple`。判断只看当前 user turn，不用历史正文。
- **安全边界**：显式 `gpt-5.5` 请求不受影响；JSON response_format、vision attachment、代码变更/调试/部署/安全/数学等 blocked marker 均不触发。真正的窗口 fit 和 provider 能力仍交给后续 capability filter / fallback。
- **配置取舍**：默认 markers 包含 `economy`、`gpt-5.4-mini` / `gpt-5.4-mini-*` / `spark`，并用 `*deepseek-v4-flash` / `*claude-haiku-*` / `*claude-3-5-haiku-*` 覆盖 bare、provider-prefixed 与 dated 形态；但没有把 `gpt54` 当成 economy hint，避免把用户想要的中档模型继续压到 mini。
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

## 历史条目摘要（最近 5 条）

- **2026-07-04 · Claude scoped weekly quota 不触发账号级限流（Admin providers / OAuth quota，docs/04/11，原则 3/5/7）**：只有账号级窗口能 park 整个 OAuth 账号，`7d-*` scoped model cap 只影响对应模型，不触发全账号限流。
- **2026-07-04 · 跨协议 reasoning 历史不兼容按候选跳过（执行 fallback / 协议转换，docs/04/05/07，原则 3/5/8）**：跨协议转 OpenAI-compatible 时剥离不兼容 thinking/reasoning 控制，并把 DeepSeek 类 reasoning-history 400 作为候选跳过而非全局失败。
- **2026-07-04 · memory idle-flush 防饥饿与受控追赶（Memory worker / store，docs/08/12，原则 3/7）**：idle-flush 候选判断改用 observer-order tuple，按 scope rank 交错输出，并支持受控多批 drain，避免旧 backlog 饿死新项目。
- **2026-07-03 · 策略级 reasoning_effort 覆盖 Lane 默认值（Routing policies / Admin policies，docs/04/11，原则 2/5/6）**：Policy action 可强制 reasoning_effort，优先级为 policy > selected lane > client request，复用现有执行改写链路。
- **2026-07-03 · cron monitor 自动化请求降到低成本规则（Classifier / routing，docs/03/04，原则 2/4）**：monitor/cron + no-reply 标记命中时降到 `simple/economy`，但保留显式 coding keyword 升级路径，避免自动化探针误打高价模型。

## 更早历史总览

2026-06-30 及以前的工作主要围绕 Helm API 的协议面、路由执行、admin 可观测性与自托管部署逐步成型：补齐 Gemini/OpenAI/Anthropic/Responses 双向转换、SSE 流式正确性、tool-call/JSON schema/思考参数保真、per-model reasoning effort、模型别名与能力/成本目录、provider fallback 与熔断语义、OAuth subscription providers、多账户池与 quota 处理、memory observe/inject/forgetting/admin/MCP、请求 payload 捕获与 request detail UI、API key 治理、admin 表格/过滤/分页/i18n、Docker/CI/release/deploy 验证，以及早期 Phase 0 的 Hono + SvelteKit static admin + Store 端口 + SQLite/Supabase 架构决策。更早细节不再逐条保留在本文件；需要精确背景时回查 git history。
