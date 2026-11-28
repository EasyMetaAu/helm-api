# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。完整原文可经 git history 回溯。

---


## 2026-11-28 · Portal 持有者调试 API 与重放边界（docs/12）

**已定范围。** 只改 Gateway、Store 与文档，不改 Portal/Admin UI，不升版本、不提交、不发布。列表增加分类来源、执行 fallback、流式结果、服务商与保留中的 session 标签；client trace 查找只在本 key 唯一时成立。`in_progress` 仅代表本进程写队列里已有该 key 的待持久化记录；不能据此判断仍在上游运行、其他实例运行或已丢失的记录。

**账号与诊断隐私。** ConfigStore 用 CAS 原子初始化随机 HMAC secret，账号代码按 provider/account 稳定，重启及多实例共用；不从 API key 或邮箱派生 secret。只给生产者写入的账号字段生成代码，任意 trace/error 文本中的邮箱固定脱敏，避免持有者用猜测邮箱查询 HMAC。保留选择策略、优先级、配额与 TTFT；移除 stack/cause、安装身份和非白名单 headers。Portal 转发正文中的生成身份元数据、JSON/SSE 错误及 session response 同样做有界投影，并标记 `X-Helm-Payload-Projection: portal`；原始用户正文不做邮箱过滤，Admin 仍读原始捕获。

**Blob 来源。** SQLite 59 / Postgres 58 仅新增 `request_payload_blob_refs`，与正文、真实图片字节同事务写入，替换正文同步替换引用，不建跨表 FK；保留清理用 DELETE RETURNING 取得实际删除的 request ID，同事务分批删除对应引用，两条语句各自只访问单表。chunk 元数据改为快照内的两次单表读取，SQLite 读事务与 Postgres repeatable-read 保持代次、字节数一致，避免跨表查询；不是按请求列表逐条查询。用户填入的 sentinel 不获得访问权限，历史无证明的引用不推测回填。Portal 逐请求校验拥有者后才读取有证明的图片，读前申请响应内存；MIME 校验失败回退二进制类型。重放图片按每次出现计入恢复上限，不能只按去重 hash 计费内存。

**重放取舍。** 调用实际 Chat/Messages/Responses/Gemini 客户端入口，compact 保持原操作；AsyncLocalStorage 仅在服务端传递调用 key，强制读取当前认证状态并把超预算降级改成拒绝，其余权限、速率、并发、预算结算和记录走正常请求链路，不使用 Admin/root fallback。要求 UUID Idempotency-Key；CAS 回执保留七天，窗口内避免重启和多实例重复执行；额外限每 key 十秒一次。十分钟未完成回执返回 outcome_unknown，不自动再发；SQLite 61 / Postgres 60 增加 nullable expires_at 和到期索引，按请求与分钟定时器分批清理；容量准入失败未出站时 CAS 删除自己的回执/限速行，503 可原 token 重试。正常请求遥测失败时返回 recording_pending，不声称已记录。原始 HTTP headers 不恢复；按当前调用者客户端身份及当前 key 设置执行。

**独立安全审查修正。** SQLite 60 增加 VIRTUAL trace_id 及按 key/trace/时间的复合索引，Postgres 59 用表达式索引避免重写历史 JSON 行；两个 Store 增加 key/会话标签索引，把 ref/标签 OR 拆成两次单表索引查询。memory stats 每实例每 key 十秒一次，blob 每 key 最多同时两个响应租约，消费/取消/失败均释放；不改待 owner 决策的 memory project 选择，也不动其他 worker 的 Portal/Admin UI。上游正文顶层采用内容/参数 allow-list，移除 prompt_cache_key、user、safety_identifier 及未知字段；所有 header 后缀容器（含大小写与数组形式）过滤，Unicode 邮箱与 org-ID 文本脱敏。有 HELM_OAUTH_ENC_KEY 时用既有 AES-GCM token-cipher 存储随机 HMAC secret，CAS 升级明文不改变代号；自定义 Store 缺原子能力或解密失败只令 Portal decision/list 503，不阻止 headless 网关启动。索引构建仍需扫描既有行并持正常迁移锁，不声称零耗时/在线无锁。

**本轮安全验证。** 定向 RED 复现索引缺失、顶层稳定身份、header/Unicode/org 脱敏、secret 明文/缺 CAS、资源限流、回执过期及容量重试；最终 15 个文件级命令串行完成，128 个测试通过。EXPLAIN 验证两种 Store 的 trace rows/count、会话及到期索引；真实 server 验证无 CAS 仍可启动和处理普通流量。`CI=true pnpm typecheck`、`pnpm lint`、`git diff --check` 均通过，lint 234 warnings / 6 infos、无 error。未改既有 migration 测试，Postgres 用 PGlite 验证，未做远程 CI 或生产访问。

**升级兼容修正。** Postgres 的 `request_payloads` 在 v6 创建，但历史升级测试用已应用 ledger 搭配最小表集合，v58 的新 FK 会因目标表不存在导致启动迁移失败。SQLite 59 / Postgres 58 改为独立复合主键表，既有迁移测试保持原文；新增无 payload 表的升级、幂等与主键验证，以及两种 Store 的跨批次保留清理验证。没有按 sha256 单独查询引用的路径，因此不加无用途的索引。修正后按文件串行跑完指定迁移、Portal 与真实 Server 回归，13 个文件共 109 个测试通过；既有 Postgres、media-spend 和 SQLite migration 测试未改。最终 `CI=true pnpm typecheck`、`pnpm lint`、`git diff --check` 均通过（lint 228 warnings / 6 infos，无 error）。

**检查与限制。** 用定向 RED/GREEN 覆盖越权、邮箱猜测 oracle、诊断白名单、真实图片来源、重放去重/预算/限流/并发及主库归属；SQLite 与 PGlite/Postgres 共用 Store 合同测试。初次实现按文件串行运行 11 个定向命令，160 个测试通过，含 Admin 请求读取回归与 SSE 解析；`CI=true pnpm typecheck`、`pnpm lint`、`git diff --check` 均通过，lint 有 228 warnings / 6 infos、无 error。本机 SQLite 二进制 ABI 147，使用已安装 Node 26.5.0 跑 Store/真实 Server 测试，不重建共享依赖。未运行远程 CI、独立 Postgres 服务或真实上游验收。完整接口形状、返回码及历史图片/队列可见性限制见 docs/12。

## 2026-11-28 · 同优先级跨池共享流量（docs/04）

**决定与范围。** 在 #1070 相同 wire model 与 #1071 lane 共享组内，同级不再按 chain index 耗尽前池，而按当前最低可用级中各池的合格账号数分配首选机会。两个订阅、一个官方 key、一个 ZenMux key 均为 10 时，独立请求按 2:1:1 概率使用；Kimi20 只在 10 级对本请求已不可用或耗尽后进入。组成员、默认 50 绕过、严格账号亲和、媒体排除和 manual_priority 门槛均沿用既有规则；不增加配置、管理接口或 SQLite/Postgres schema，不修改版本。

**最小机制。** 复用游标快照与请求级协调器，按 pool 身份去重账号，以加权 rendezvous（指数竞赛）产生池顺序。未携带软会话信号时使用可注入随机源；有信号时复用池原有 native/chat 黏性提取并散列，不创建新的 session 规则。选择阶段不 acquire、不预占 quota、不改 LRU。池内保留 OAuth 策略和 key LRU；发生 pre-output 故障后，本请求先给同级其他池机会，再回到尚有 sibling 的池。每级 visited 集只属于当前请求；故障修订计数识别重复抛出同一 Error 对象，正常 count_tokens/send 之间的暂停则保持同一次池选择。别名翻译、延迟 exact count、breaker/probe、deadline、usage park、400 短路、free429、断连和输出后不重放继续由原执行路径负责。

**可观测性与取舍。** 原 `provider.account_priority` 日志增加 pool、pool_selection_reason、pool_weight、tier_pool_count 和截断 affinity_hash；静态成员也在真正到达发送路径后记录。不输出原始 session/cache key。相同候选集及权重保证同会话选同池；删去其他池且剩余权重不变时保持存活首选。资格/权重改变或新增池可能重新映射，这是无跨请求状态的加权共享边界，不承诺永久绑定。概率分配不保证短窗口精确比例，也不提供跨进程配额事务。客户端 requested-model promotion 不再决定不同池的同级首选；同池多个 alias 仍沿用链顺序。该条更新前两条历史记录中的同级 chain-index 规则。

**独立复审修正。** 快照另带忽略瞬时 busy/capacity 的 sharingEligible，跨池权重据此计算；原 eligible 与池内容量避让、排队/失败兜底不变，disabled、模型许可、park、冷却及额度仍约束权重。软亲和提取出错返回 null，严格身份校验继续在实际派发边界处理。未托管 key 池代理回落到静态客户端时，在真实文本调用处补发原选择事件，避免代理始终暴露 accountPriority 导致日志缺失。固定 user/device 等软信号会把所有流量稳定映射到一个池；分享比例适用于不同信号或无信号请求。未启动池在长失败尝试期间沿用发现快照、权重不实时刷新，这是既有快照时效边界。 本轮先运行 gateway 回归得到 4 个预期失败（会话漂移、两种身份提取异常、静态代理漏日志），修复后仅跑本轮改动测试：gateway 14 / core 8 均通过；`CI=true pnpm typecheck`、`pnpm lint` 均 exit 0，lint 206 warnings / 5 infos。未触碰 controller 的 apps/admin 改动。

**验证状态。** 真实 gateway→OAuth/API key 池测试先复现 400 次全走订阅、key 为 0、失败后 A→B 而非 A→key→ZenMux，再实现共享；覆盖流式/非流式、软会话、同 wire model、默认绕过、单池、最终归属及选择日志。纯函数/协调器覆盖资格、去重、稳定映射、动态 park、重复 Error 和并发请求隔离；静态成员日志另经 RED→GREEN。最终定向回归 10 文件 / 263 测试通过，config samples 21 测试通过；`CI=true pnpm typecheck` 与 `pnpm lint` 均 exit 0（lint 报 206 warnings / 8 infos，其中新增测试有 3 个模板字符串风格提示），`git diff --check` 通过。原默认顺序表征文件未修改。未提交、未部署、未执行真实上游验收。

## 2026-11-28 · Lane 作为共享账号池：已实现本地切片（docs/04）

**管理界面。** Lanes 编辑器新增「按优先级混用账号」开关（共享 `Switch` 组件）。开启后，主选和备选中的每一项都会标上「进池」或「通道 · 兜底」。管理端 API 客户端 `normalizeLane` 原本只保留已知字段，现在也会保留 `shared_account_priority`；否则在页面上保存任意一个通道，都会悄悄把这个开关从配置里删掉。Providers 页面优先级列的提示文字也已同步更新。

**状态与范围。** 基于 main `d44da493` / #1070 实现，尚未提交或部署。新增 lane 字段 `shared_account_priority?: boolean`，缺省不补值、行为等同 false，旧配置及出厂默认均不变。只改变明确开启此字段的已授权文本 lane；不开启时仍使用 #1070 的相同 wire model 分组和 manual-priority API key 门槛，不改分类兜底字段。

**嵌套规则（按 controller 复审修正）。** 只有选中 lane 自己的 primary/fallback 中直接写出的 `provider/model` alias 加入共享组；任何 lane 名引用及其所有后代都不因引用关系入组，裸模型名也不入组。要让 Kimi 替代 Claude，必须直接列出 `kimi/k3.1-pro[1m]`，不能只写 `kimi`。账号 priority 是全局设置，组成员却是 lane 局部配置；因此否决原来的递归 primary 规则，避免 `claude-sonnet → balanced → gpt-sol → openai-codex/gpt-6.2-sol` 把为 GPT 工作设置的 Codex10 偷带入 Claude 组。若同一个 alias 同时在根 lane 直接列出及嵌套展开中出现，按直接成员处理并沿用原展开去重位置。组在首个成员的原链位置执行，之前的 lane 展开不挪动；组结束后按原展开顺序继续其余候选、跳过已消费成员。授权、blocked_models 交集及原展开算法保持。

**调度与默认兼容。** 组内按账号 priority 升序、再按原 chain index；同池同级保留原策略/LRU。OAuth 与两种策略的 API key 池都可参与，lane 开关只在本请求覆盖 round_robin 的旧优先级门槛。无池的静态/环境 key 和免密钥 provider 视为 priority 50。存在非默认可用优先级时，在首个成员位置执行共享组再继续剩余链；全为 50 则完全保留原展开链及原池策略，包括嵌套 fallback 的位置。`auto` 上游选择器及媒体 alias 不参与；严格账号亲和、延续身份或发现失败继续走旧顺序。

**执行边界与预检成本（按独立复审修正）。** 成组前仅进行本地能力、协议历史、上下文估算及 breaker 预览，不发送 exact `count_tokens`、不选账号、不写 attempt/skip 行。预览临时取得的 HALF_OPEN token 立即释放；真正执行 alias 时才重新解析 live target、检查 breaker 与能力，并带该成员的 cursor 延迟执行 exact count。精确计数发现 context_too_small 时协调器继续下一个成员，未到达成员不占 quota/LRU、不因计数错误 park。skip 行只在原执行顺序真正到达 alias 时写入；客户端 abort 立即停止后续发现/预检，计数取消不冒充 provider 警告。没有跨 alias 缓存 native body 或 count 结果，避免 target 替换后复用旧验证。仍使用原游标和池重试，保留 transient sibling retry、usage park、真正 400 短路、free429 skip、abort 不算故障、有效输出后不重放和最终 serving_account 归属；分类与执行 fallback 不合并。

**单成员与剩余链。** 只有一个直接成员时跳过 lane 发现及协调；资格过滤只剩一个成员时也不进入协调器。组外 lane 引用展开的候选继续应用 #1070 相同 wire-model 分组和 manual-priority 门槛，直接成员作为分段边界，防止旧组跨越新 lane 组。零直接成员时完全等同 flag-off。snapshot 在各发现过程按 provider/model 缓存，协调器不额外重读，真正出站 refresh/acquire/settle 保持。配置/账号并发修改不是跨进程调度事务；无数据库 schema 变化，SQLite/Postgres 保持原存储。客户端 requested-model promotion 只影响组内同优先级的链顺序，不能盖过更高优先级账号；这是 lane 作为一组可替代模型的预期语义，显式单 alias 与严格亲和仍保持原行为。

**Admin 契约与验证。** `GET /admin/api/lanes` 返回 `[{name,...Lane}]`，单项 GET 返回 Lane；单项 PUT 接收完整 Lane，批量 PUT 接收完整 lane map。新字段是顶层可选 boolean；省略表示关闭且不写默认字段。测试覆盖 true、false、省略删除经过 GET/PUT→真实 YAML→schema 重载。测试覆盖跨协议流/非流、直接成员与嵌套尾链、blocked_models、全默认顺序、真实计数溢出、断连、breaker 所有权、单成员、组外旧排序、客户端模型 promotion。此次先复现未到达 key 被 count、skip 提前入账、nested remainder 的 A10→B30 顺序、单成员发现及断连计数警告，再修复并运行仅两个改动测试文件（机器负载高，不重跑全套）。前次 17 文件/748 测试记录仍是前次验证，不能视作本次全套验证；本次两个定向文件共 81 测试通过（lane-priority 34、shared-priority 47）；最后各运行一次 `CI=true pnpm typecheck` 和 `pnpm lint` 均 exit 0，lint 为 206 既有 warnings / 5 infos，`git diff --check` 通过。未修改并行 controller 的 apps/admin 文件，未提交或部署，也未做真实上游/生产验收。

## 2026-11-28 · 跨订阅与 API Key 的账号优先级：首个切片已实现（docs/02、03、04、07、11）

**状态：已实现本地切片，未提交、未运行远程 CI、未部署。** 基线 `49263aa28e8e952347fac5106c77974d86a037e9`。用户解除前次设计门槛后，按原方案补齐可恢复的池执行状态和请求级协调器。原默认顺序表征测试保持原文；新增真实 `routeRequest → createExecute → OAuth/API key pool` 边界测试先证明 A10→B30→K20 的旧行为，再验证 A10→K20→B30。独立只读审查发现的冷却更新、容量/付费额度、legacy key 与错误脱敏问题均补了回归用例。

**等价范围与默认兼容。** 只处理已经经过授权、lane 展开和 `blocked_models` 过滤的文本候选；按解析后的实际 `providerModel` 严格相等分组，不根据 UI 名称、alias 后缀或相似能力推断等价。只在同模型组内同时存在可用订阅账号和策略为 `manual_priority` 的可用 API key 账号、且至少一个可用账号的优先级不是 50 时启动协调。全部为默认 50、单一认证类型、显式单 alias 请求仍走顺序执行和原池策略，不使用游标。不合并 `auto`、不同 wire ID 或媒体输出；例如 ZenMux 的 `anthropic/claude-X` 与官方 `claude-X` 不等价。没有管理账号的 legacy key alias 不进入共享组，仍由原候选循环处理，不能以“空优先级”抢到队首。

非默认组按首次出现的 alias 位置进入执行；组内按可用账号的优先级从小到大选择，同级先按原 alias 顺序，同池同级仍用既有策略。组耗尽后再处理后续候选，因此启用共享优先级会有意把同组 alias 之间原先穿插的其他候选排到该组之后。先保留原有模型许可、启停、usage park、冷却、健康额度及用户消息容量规则，再比较优先级；不会为了低数字而绕过健康账号去花超额 credits，或选择已有空闲 sibling 时仍排队的账号。按用户确认的兼容规则，API key 只有 `manual_priority` 池参与共享排序；`round_robin` 继续忽略历史非默认优先级，并作为候选链分界，后续 manual 池不能借更早的 OAuth alias 越过它。普通黏性只能在选中优先级内生效；池识别的 Responses ID、Codex turn state、WebSocket session、Anthropic UUID 和持久化账号绑定使请求整体退出共享排序，保留原身份/恢复边界。

**最小机制与资源所有权。** core 的 `AccountPriorityCursor` 只在选账号前暂停原调用；`completeWithRetry` / `streamWithRetry` 仍持有 tried 集、最后错误、重试预算、usage park 和有效输出提交点。只读快照不调用 select、不改 LRU、不预占额度。每次请求只对存在相同 wire model、相反认证类型的候选读取调度快照，按 provider 客户端和 model 缓存一次，重复 alias 及协调器直接复用。没有匹配对的链不产生调度存储读取；默认优先级的混合匹配对仍各读取一次以确认实际设置。授予执行机会时保留尚未启动游标的初始候选集，已启动池通过内存回调重新检查 tried、冷却和容量，恢复时再次验证最低可用优先级；例如 K20 执行期间 B30 被 quota poll 停放，后续仍能选 C40，而不会把 A10 的旧错误冒充整个池耗尽。API key 出站仍执行原 refresh/acquire/settle、凭据代次及 CAS 校验，这些安全读取不被调度缓存替代。实测 A10→K20→B30 的 API key 调度快照调用从 6 次降到 1 次，两类池均只做一次发现快照；本次 fixture 比同样的 key provider 直接调用仅多 1 次 store.get。未暴露成员客户端或凭据。

网关把原单 alias 执行体提取为 `runAlias`，协调器一次只允许一个 alias 执行，其余保留异步调用帧。能力/上下文检查、协议翻译、计价和 breaker 键仍是原 alias。HALF_OPEN 的 probeToken 在暂停期间保持归属，成功或真正耗尽才结算健康；同组另一 alias 成功或终结时用内部取消信号唤醒并清理暂停调用，不伪造 client_abort，也不把未耗尽的池记为故障。与原设计相比，deadline 明确按**剩余上游执行时间**续用：调度等待暂停 attempt 和原生 first-output 计时，避免另一池的延迟误伤本池；不会重新发放整段预算，整个请求的断连/超时仍始终生效。alias latency 同样扣除调度暂停，避免总延迟重复累计 peer 的执行时间。已经提交有效输出后不再调度或重放。

确定性 400、队列背压、`:free` 429 skip、usage park、abort 不计故障以及现有错误终结逻辑保持。暂停调用被取消时，已发生的 pre-output 失败仍保留为一次 alias 尝试并经该 alias 的凭据 scrubber 脱敏；`:free` 429 仍记 skipped。每个 alias 的池内 sibling 重试不额外增加 `fallback_count`，不会因为成功的 peer 提前结束而漏掉前面实际尝试过的 alias。分类的 `classifier.decided_by` / `fallback_reason` 与执行的 `provider_attempts` / `fallback_count` 继续分开。新增结构化日志 `provider.account_priority` 记录 alias、逻辑 account、priority、组内 sequence 和 trace_id，以解释真实 A→K→B 顺序；不记录正文、密钥或原始亲和标识，也没有新增 DecisionRecord 字段。每个协调 alias 使用独立 serving-account holder，清理后仅当最终 alias 存在于本组 holders 时才写回请求 holder；本组没有最终尝试时保留此前非组 alias 的身份，避免 usage park 和计费串号。

**配置、持久化与 UI。** 没有数据库迁移、新的 YAML 字段或 admin 改动。仍使用加密 `oauth.account_settings` 与 `provider.api_keys.<poolId>` 中既有 `priority`，默认 50；SQLite 和 Postgres 的 ConfigStore 适配器都不需改动。调度快照读取失败时记录 `provider.account_priority_unavailable` 并保留原顺序执行，不让原本无需访问的 fallback 存储故障破坏可成功的请求；真正选到该 provider 时仍重新读取并执行原 fail-closed 凭据/配置检查。协调器不再重新读取并把错误替换成空数组，瞬时读失败不会将尚未启动的账号排到最高优先级。快照不是发送授权，也不提供跨进程全局调度事务。

UI 继续使用既有接口：OAuth 从 `GET /admin/api/oauth/:provider/account?account=<label>` 读顶层 `priority`，以 `PUT /admin/api/oauth/:provider/account` 提交 `{ "account": "<label>", "priority": 10 }`；API key 从 `GET /admin/api/api-key-pools` 读 `pools[].accounts[].priority`，以 `PATCH /admin/api/api-key-pools/:pool/accounts/:id` 提交 `{ "priority": 20 }`。API key 范围是 0–1000，OAuth 为非负整数；统一输入框可用 0–1000 的交集，但不能截断已有更大 OAuth 值。只应对以上等价范围宣传跨类型优先级，不能将不同模型、legacy 环境 key 或媒体任务描述为共享账号调度。

**验证与剩余范围。** 新测试覆盖非流式及翻译/原生流、初始默认顺序、同级优先级、无资格账号、原生 preamble 后失败、严格 continuation、权限过滤、HALF_OPEN 暂停/独占/清理、真实 400、限额停放、断连与读取竞争、已输出后的禁止重放、计时预算、最终账号归属、失败脱敏和 free429 计数。运行范围限相关 pool/execute/config 样例文件，并执行完整 typecheck 与 lint；独立复审的四项修正另覆盖快照/store 读取次数、round_robin 旧优先级与链位置、瞬时重读优先级倒置和空组归属交接，均先验证回归再修复；具体命令和结果见本次交付报告。尚未扩展模糊/显式跨 wire-ID 等价关系、媒体调度或远程生产验收；现有跨进程管理变更及账号池重建仍遵循原凭据/生命周期约束。

## 2026-11-28 · 提供商列表统一列与列表内编辑（docs/11）

按用户要求重做 Providers 列表：订阅账号、API Key 和免密钥连接用同一套列，依次是账号（含类型标签）、状态、额度与余额、用量、连接、优先级、已启用、选项、操作；不按提供商分组。行模型、筛选、排序和 URL 编码放在 `routes/providers/account-list.ts`，用纯函数实现。搜索、类型、状态和排序写入 URL，通过 `replaceState` 更新，不重新加载数据。

- 额度与余额：每个额度窗口各有一根进度条，并显示剩余百分比和重置时间。供应商返回的余额信息全部直接显示，包括点数余额（0 也显示）、额度重置次数、月度额度、Claude 可重置次数、附加限额和已触发的限制类型。
- 列表内编辑：优先级用数字输入框。订阅账号走既有的 `PUT /oauth/:provider/account`，要求非负整数；API Key 走 `PATCH /api-key-pools/:pool/accounts/:id`，范围 0–1000，越界时前端直接拒绝、不发请求。「已启用」用共享的 `Switch` 组件：订阅账号写 `schedulable`，API Key 写 `enabled`。「选项」固定三个图标开关（快速、自动重置、限流后用余额），样式用新的 `.btn-icon-toggle` 配方，某个账号不适用的选项保留空位，所有行对齐。
- API Key 池的轮换方式每行重复太乱，不放在列表里，仍在编辑弹窗中修改。如果池是均匀轮换，优先级输入框的提示会说明：切换为「手动优先级」后优先级才生效。
- 模型、邮箱、ChatGPT ID 和登录凭证到期时间放在账号名的悬停提示里。点击整行时：订阅账号进入用量详情页，API Key 打开编辑弹窗。
- 新增共享的即时提示 `$lib/tooltip.ts`（`use:tooltip`）：鼠标悬停或键盘聚焦时立即显示，提示挂在 body 顶层并使用 fixed 定位，上方放不下时翻到下方，并左右平移以留在屏幕内。小图标按钮不再用会延迟出现的原生 title。除本页外，策略拖拽和删除按钮、通道拖拽和删除按钮、管理弹窗的关闭按钮，以及 API Key 和 Key 列表的 ⋯ 按钮也一并换成了即时提示。
- 上游用量区块的进度条宽度同步改为 `w-52`，和主列表一致（e2e 断言两者宽度相同）。

**限制：**
- 路由仍按各自池内的优先级生效，跨类型统一优先级尚未实现（设计见 feat/unified-account-priority 分支），优先级列头的提示说明了这一点。
- API Key 用量仍是近 24 小时口径，单元格明确标注，没有冒充今日用量。
- 统一的「查看+修改」详情页留作后续任务。
- 1280 宽度且侧栏展开时，表格容器宽度不到 64rem，会沿用卡片布局。

## 2026-11-27 · 客户端错误详情（docs/07、12）

终结失败及非透传流错误从已脱敏诊断中提取上游原因、code、param、HTTP 状态和上游请求 ID，拼入客户端 message，保持既有协议、HTTP 状态、错误分类和重试语义。媒体 outcome_unknown 继续说明结果未知；成功兜底不向客户端报错。Ark 媒体保留已有账号信息隔离，只附协议标识，不公开自由文本。未知本地异常不转发内部 message/stack；已经开始的二进制音频无法再插入 JSON 错误，仍终止传输并记录诊断。未记录的历史上游正文无法补回。

## 2026-11-27 · Portal 完整请求详情与媒体拒绝诊断（docs/07、12）

按用户新要求，Portal 自有请求详情展示管理端同样的分类、策略、候选链、提供商尝试、费用/Token、账户标签和错误字段；列表仍用原投影。详情使用管理端纯解析器与对应只读组件，保留 Bearer 身份和每次 requestId 归属校验，不开放管理重放。

正文/会话恢复复用管理端有界读取器；只有实际恢复会话时才校验会话行归属，完整正文不依赖会话行存在。Portal 不执行全局 blob 解引用；历史外置图片没有逐请求的归属证明时保留原引用并提示无法还原。非流式 encoded 正文先占响应预算，在单表查询中限制分配前字节数，消费/取消后释放；无数据库结构迁移。

上游失败统一保留有界、脱敏的实际返回正文、HTTP 状态、响应头和请求 ID，覆盖媒体创建/查询、语音/转录、实时握手与流式终止；无上游响应时仅记录实际本地异常。流式诊断在选中提供商处按真实凭据脱敏，保持转发字节、已提交尝试、用量/费用和付费重试语义。错误详情始终记录，不依赖成功正文捕获开关；签名 URL 的查询参数/片段及凭据不保留。超过错误正文预算或读取失败时明确记录原因。旧 MiniMax 失败正文未保存，无法事后恢复。

## 2026-11-27 · 提供商统一列表（docs/11）

上游用量未配置时同时隐藏折叠入口；加载失败时仍保留错误提示入口，避免把读取故障误认为没有配置。

按用户修正，OAuth、API Key 与免密钥内网连接统一放在原订阅样式的账户列表，以认证方式列区分，不再分别展示连接区和密钥区。API Key 账户按实际 poolId 只展示一次，共用连接的端点和模型映射从账户管理进入；不按协议硬编码分组。API 用量保留最近 24 小时口径，不冒充 OAuth 的今日用量或上游额度。

既有账户操作和弹窗复用原组件，连接编辑不再显示已有 Key 的空输入框，密钥更换只在账户设置里进行。免密钥连接从服务端配置派生只读标识，保留原配置文件管理方式；此次不改凭据、存储结构、路由和调度语义。

## 2026-11-27 · API Key 与 OAuth 统一供应商管理（docs/04、06、11）

按用户新要求，Providers 同时提供 OAuth 和 API Key 入口。API 连接、模型关联及账号凭据由加密 Store 管理，支持自定义兼容端点、每账号优先级、模型许可、代理、默认请求参数、启停和轮换。请求或 lane 的显式参数优先；媒体账号禁用不走其他身份，代理失败不直连。网关仍可无 UI 运行。

未接管的 YAML 配置保持兼容；「接管配置」可导入已有环境变量凭据，接管后移除运行时 api_key_env，空账号池也不回退环境变量。删除记录和退役模型别名阻止重启复活或结构路由绕过。此改动不自动删除部署环境文件，实际生产迁移和旧密钥清理属于部署步骤。

托管连接文档以 AES-GCM 加密、CAS 更新；列表只展示 Key 掩码及代理密码是否存在。管理写操作校验来源。各进程在请求和出站前读取版本，账号变更刷新关联客户端。媒体任务绑定账号、密钥代次和端点；名称、优先级、参数或代理编辑保留任务归属，密钥或端点更换后旧任务拒绝跨身份查询。媒体专用连接不提供文本连通性测试。

接管时仅导入当前仍生效的环境凭据；已配置过的池（含空池）不复活旧环境 Key。导入账号保存旧媒体归属与原端点、密钥代次的加密映射，已有任务仅在同一绑定仍有效时继续查询，轮换或换端点后拒绝。界面统称「密钥提供商」。

本次无数据库结构迁移；复用 ConfigStore 双适配器接口和现有 HELM_OAUTH_ENC_KEY。该加密密钥仍需由部署安全注入，不是供应商 API Key。新增和接管不自动改 lane 顺序，跨供应商调用顺序继续在通道内配置。

## 2026-11-22 · 订阅账号代理与授权生命周期（docs/04、06、11）

账号设置读取、解密或代理校验失败时拒绝新的订阅出站，保留管理修复能力；已配置的代理不能因读取失败变成直连。代理实质变化、断开或重连更新账号内存代次，旧 HTTP 客户端、Responses WS 新轮次及未连接的 Realtime 票据不能继续出站。YAML 显式订阅的 primary 与直接 eval 随管理应用重建。SOCKS5 WebSocket 交由代理解析目标域名。

授权 start 即绑定账号；省略标签明确使用 default，不能在完成时改名。新增同名拒绝并引导重连，明确重连继承原代理。每次发包前及最终落库前检查代次，代理更新与授权提交按账号排序。PUT proxy 只接受显式字段，null 才清除。已发出的请求允许读取结果，特别是一次性 refresh token；重连和刷新共用凭据写入锁，避免旧刷新覆盖新身份。

范围限当前单进程设置管理；跨进程修改不具备即时通知保证。整条配置被外部删除与首次未配置仍无法区分。浏览器授权页使用浏览器网络；账号池切换仍遵循被选账号各自的代理。旧 WS 的新发送会关闭旧连接并拒绝，已发请求可完成；未再使用的连接沿用原会话关闭生命周期。Claude 原生 TLS 的 DNS 未做真实代理抓包验证；不能用 WebSocket 的测试代替该证明。本次无数据库迁移。

## 更早历史总览

2026-11-21 · 自有内网模型免上游凭据（docs/02、04）：仅允许显式配置的自有内网 provider 免凭据，公共上游与接管后 Store 权威规则不变；完整记录见 Git history。

更早工作涵盖 API Key 暂停与吊销、固定配额和预算，客户端身份与版本快照，Codex／Claude／Grok／DeepSeek 协议兼容、模型目录与订阅额度，HTTP/WebSocket/SSE 生命周期、发送后结果不明禁止重放、fallback 与熔断，Memory 观察／注入／压缩／保留，payload/session 持久化、SQLite/Postgres 一致性与资源保护，图片／视频／语音权限及计费，Admin/Portal/i18n，以及构建、CI、Docker、发布与验收。历史默认值和实测以对应提交为准；完整条目可从基线 632e2971db3363b1a2575cba1ed31cbac213634c 的本文件及 Git history 回溯。 Fun-ASR／Paraformer 录音识别、零用量空截断恢复、文件转写下载凭据与预算回执等更早补记一并归入上述历史范围。
