# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 3 条**完整记录。新条目入栈时，把被挤出前三的条目压缩成一行要点（保留日期、标题、关键决定/坑/TODO），移入文末「历史条目摘要」。完整原文可经 git history 回溯。

---

## 2026-06-05 · 遗忘策略 Codex 评审修复 VII（2 项；docs/12）

第七轮 review 仅剩 2×P2（持续收敛 5→3→3→3→3→2→2），全部修复（+1 回归测试）：

1. **（P2）reinforcement 仍在请求 tick 上执行**：`void bump().catch()` 只保证不 await，但默认 sqlite 适配器的写是**同步**的（better-sqlite3 `.run()`）——promise 体当场执行，写库时间仍花在请求路径上。**修复：调用整体 `setImmediate` 延后到 macrotask**，并 try/catch 包同步抛错（macrotask 里未捕获异常会崩进程）。测试的微任务 flush 升级为 macrotask flush。
2. **（P2）空集归档分支缺 `enabled` 门控**：只查了 archiveReflections 方法存在与否——遗忘关闭时，「有 reflection 但 observation 为空」的 scope 跑普通 reflector job 会被归档，违反「enabled:false 字节级不变」。**修复：分支加 `deps.forgetting?.enabled === true`**；既有归档/版本延续测试显式开 enabled。

---


## 2026-06-05 · 遗忘策略 Codex 评审修复 VI（2 项；docs/12）

第六轮 Codex review 发现 2 个问题（均为前几轮修复的次生缺陷），全部修复（+4 回归测试）：

1. **（P1）有界扫描的饥饿**：第三轮加的 limit-only 分页按 observed_at 取最旧 N 行——若这一页全是幸存者（被强化/高分），每轮 sweep 重选同一页，limit 之外的 condemned 行永不被处理。**修复：score 谓词下推进 SQL**（`candidates` 参数；sqlite `pow`/`ln`、pg `power`/`ln`，与 forgetting/score.ts 同一公式）——页内只含低于阈值的行，幸存者不占页、归档行离开 active 集，每轮必有进展。TS 复算保留作纵深防御（浮点边缘分歧 → 无害跳过）。docs/12 的「SQL 与 TS 同一公式」承诺至此兑现。
2. **（P2）archive→rebuild 后 reflection 版本重置**：getReflection 过滤 active 后，nextVersion 只从 active 行推导 → 归档 v4 再复活会重写 v1（reflection_version 对客户端/缓存回退）。**修复：新增 `getReflectionVersionHighWater(scope)`（跨全 status 取 MAX(version)），写 highWater+1**；merge/inject 内容仍只读 active。可选端口方法，旧 fake 回退旧行为。

---


## 历史条目摘要（压缩归档）

> 以下为更早条目的一行要点（新→旧）。完整原文见 git history（本文件在 2026-06-05 压缩前的版本）。

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
