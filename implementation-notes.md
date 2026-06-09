# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 3 条**完整记录。新条目入栈时，把被挤出前三的条目压缩成一行要点（保留日期、标题、关键决定/坑/TODO），移入文末「历史条目摘要」。完整原文可经 git history 回溯。

---

## 2026-06-09 · LLM 记忆提取/压缩接线与可配置模型（docs/08 记忆；docs/12 遗忘/事实层；CLAUDE.md 原则 2/3/7）

- **缘起**：记忆 observe/inject、worker、compaction trigger、forgetting/facts 已是生产接线，但 Observer/Reflector 仍用确定性 stub 做 summarize/merge/extractFacts；这让“记忆提取/压缩”可用但不具备真正 LLM 归纳能力。
- **修复**：新增 `memory.llm` 配置子树（默认 `enabled:false`），支持 `model` 基础模型与 `observation_model` / `reflection_model` / `facts_model` 分任务覆盖；同组 `HELM_MEMORY_LLM_*` 环境变量可覆盖模型/开关/超时/温度/max_tokens。网关新增 `memory-llm.ts`，后台 Observer 用 LLM 压缩 raw messages -> observation，Reflector 用 LLM 合并 observations -> reflection，并用 LLM 提取 atomic facts。
- **安全/降级**：LLM 调用只发生在 memory worker 后台 job，绝不进请求路径；配置错误 fail-closed（Zod strict + enabled 必须有 model），运行时模型不可用、上游失败、超时或 JSON 无效全部 fail-open 回原确定性 stub。日志只写 task/model alias/error class 等安全元数据，不写 prompt/response/memory 正文。
- **模型解析**：memory model alias 复用执行层语义：OAuth 订阅别名受 live `oauthAliasSet` gate，providers.yaml alias 经 registry 解析，`provider/model` 结构化别名走对应 provider client，裸模型名走 primary provider passthrough；不会因为记忆任务跨过订阅/凭证边界。
- **PR 评审修复**：LLM merge/fact prompt 不再包含 `previous_reflection`，避免旧 reflection 中已归档/剪枝内容绕过 active-observation filter 复活；LLM facts 强制 `valid_from_observation_id` 且必须命中 active observation，否则整次回退确定性 extractor；observation/reflection/fact 文本改 trim 后 min(1)，纯空白输出触发 fallback；LLM `priority` 标尺改 0–10，对齐 Observer 的 `priority/10` salience 推导。
- **测试/取舍**：TDD 覆盖 schema 默认关闭与 fail-closed、loader YAML/env 覆盖、observer 使用配置模型、reflection JSON 无效 fallback、fact `valid_from_observation_id` 映射 observation 时间与 `[obs_id, obs_id]` 审计范围、模型不可用 fallback。暂不把 LLM usage 精确计入 cost bucket，沿用 observer/reflector 现有启发式 token 账本；后续若要精确计费可扩展 deps 成本接口。

---

## 2026-06-09 · Agentic Signals 反馈接入 ranked-lane 路由（docs/02 架构；docs/04 路由；docs/07 可观测性）

- **缘起**：路线图里 `RoutingSignal` 聚合、sqlite/pg store 与后台 collector 已存在，但请求路径从不读取信号，导致 Agentic Signals 只能观测不能反馈，仍属于“未接线”功能。
- **修复**：新增 `runtime.signal_feedback` 配置（默认 `enabled:false`，`HELM_SIGNAL_FEEDBACK_ENABLED` 可覆盖；阈值在 `config/runtime.yaml`），网关把 `store.signals.getSignal` 接入 `routeRequest`。启用后，只有当当前 **ranked lane**（`economy/balanced`）在同一 `task_type` 下样本数达标且 error/fallback 率超阈值时，才会提升到更强且更健康的 ranked lane；不会降级，也不会越过 explicit passthrough、policy `use_lane` pin、usage-budget degrade、policy/key caps。
- **安全/可观测**：信号只含聚合计数/率/延迟/成本，不含 key/payload；读取异常完全 fail-open，保持原 lane 并继续请求。发生提升时在 `classifier.explanation` 追加 `routing_signal_feedback`（from/to lane、阈值、信号摘要），不新增敏感字段。
- **取舍/TODO**：本次只做 ranked-lane 健康提升，暂不让信号改写未排名任务 lane（如 `coding`）或做成本驱动降档，避免生产反馈绕过 operator 明确策略。若后续要对 task lane 做反馈，应先定义“task lane → ranked lane”的可解释映射和更细粒度的决策字段。
- **测试**：TDD 新增 route tests 覆盖 degraded balanced → premium、signal store fail-open、key allowed_lanes 不越界、policy pin / explicit passthrough / budget degrade 不被覆盖；config schema + loader 覆盖默认关闭、阈值 fail-closed 与 env 开关。

---

## 2026-06-09 · 生产路径四协议 LiteLLM 参数保真 + payload 原文记录修复（docs/05 协议互译；docs/07 可观测性；CLAUDE.md 原则 7/8）

- **缘起**：复审发现 transformer 层已覆盖大量 OpenAI/Anthropic/Responses/Gemini 字段，但生产路径 `route -> InternalRequest -> execute` 仍只保留 `messages/tools/response_format/max_tokens/stream`，导致 `temperature/top_p/tool_choice/parallel_tool_calls/reasoning_effort/max_completion_tokens` 等 LiteLLM/OpenAI 参数被静默丢弃；同时 payload capture 用 `JSON.stringify(parsed)` 重建请求体，不符合 docs/07 的 verbatim 记录承诺。
- **修复**：扩展 `InternalRequestSchema` 与 OpenAI Chat 边界 schema，新增共享 `copyLiteLLMRequestParams`/`providerRawFromRequest`，让 OpenAI Chat、Anthropic Messages、OpenAI Responses、Gemini 三条 pipeline face 都把 LiteLLM 兼容参数带进执行层；`execute.stripInternal` 转发这些字段，并对流式请求合并客户端 `stream_options` 后强制 `include_usage:true` 以保留成本回填；Responses transformer 补 `user/service_tier/web_search_options/context_management`，Anthropic native provider 补 `max_completion_tokens -> max_tokens`、`top_k/thinking/tool_choice/parallel_tool_calls:false`。
- **记录修复**：四个 HTTP route 改为先读取 `c.req.text()` 再 `JSON.parse`，payload 表保存原始请求 JSON 文本（保留空白/顺序等原文细节），响应仍保存实际组装出的响应体；记录路径仍 fail-open，`capture_payloads` 关闭时不写 payload 但 telemetry row 保持。
- **测试**：新增/加强生产边界测试：OpenAI Chat route -> execution request、三种非 chat protocol pipeline -> InternalRequest、execute -> provider request body、四 route payload requestJson 原文断言，以及 OpenAI/Responses/Anthropic provider 参数回归。重点锁定“transformer 测试通过但生产路径丢参”的老问题。
- **取舍/TODO**：`metadata` 与网关内部 `metadata` 字段同名，provider metadata 存在 `provider_raw.metadata`，执行前再恢复到上游 body，避免污染 memory/session metadata。未把 auth/rate-limit/concurrency 等 pre-pipeline 拒绝统一写入 request history；当前修复范围是已认证且进入协议/路由面的 served/failure 请求。

---

## 历史条目摘要（压缩归档）

> 以下为更早条目的一行要点（新→旧）。完整原文见 git history（本文件在 2026-06-05 压缩前的版本）。

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
