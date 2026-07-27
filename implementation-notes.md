# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-07-27 · 请求内存准入只计算未物化 headroom（Gateway runtime，docs/02/05/07/10，原则 3/7/8）

- **根因**：实时 V8 高水位把 `heapUsed + active reservations` 相加，但长 Responses SSE/WebSocket 请求在 `JSON.parse` 后已进入 `heapUsed`，其 reservation 仍持有到流结束，导致同一请求被重复计账并高频误拒为 503。
- **修复**：活动请求总额度继续由 `reservedBytes` 和 `activeRequestBytes` 限制；live heap 只叠加尚未完成正文读取、schema 校验与同步协议物化的 `pendingBytes`。lease 物化后仍占活动额度，但不再占 pending；重复物化/释放幂等，物化后禁止 resize。所有 HTTP JSON/multipart 入口与 Responses WebSocket 共用该语义。
- **安全边界**：heap ceiling 仍全额扣除 response work、write queue、Session cache、response capture 与 5% GC 余量；未新增配置、队列、依赖或阈值放宽。413/503 客户端协议形状保持不变。
- **可观测性**：`request.memory_rejected` 增加拒绝原因、wire/charge、active/pending 与 heap/ceiling 数值；不记录正文、header 或密钥。

## 2026-07-25 · 图片上游参数拒绝保持客户端 400（Gateway / Provider execution，docs/05/07，原则 3/5）

- **根因**：OpenAI provider 已把 ZenMux 的真实 HTTP `400` 保存到 `UpstreamError.upstreamStatus`，但共享请求拒绝分类只识别 `invalid_request_error`、`413` 与超大图片提示，遗漏 ZenMux 的结构化 `invalid_params`，导致图片链继续按 provider 故障耗尽并返回 `all_providers_failed / 502`。
- **修复**：共享 `isUpstreamRequestRejection` 在原有 `400/413/422` 状态白名单内识别 `invalid_params`；图片链复用现有上游消息提取，Images 路由返回 OpenAI 形状的 `invalid_request_error / invalid_request / 400`。不按错误字符串或具体参数名特判，也不删除客户端字段。
- **边界不变**：`401/403/404/429`、provider `5xx`、网络/超时、熔断与真实链耗尽仍走原有认证、重试、breaker、fallback 和 `5xx` 语义；回归测试覆盖 ZenMux 形状、provider `500`、网络失败与链耗尽。

## 2026-07-25 · 上游过载（529/503）在 fetch 边界退避重试（Provider，docs/02/04，原则 3/5/8）

- **根因**：`provider/retry.ts` 的重试分类是严格白名单，只覆盖裸 socket/连接失败；HTTP 529（Anthropic Overloaded）/503 直接变成 `UpstreamError` 抛出，**零延迟零重试**。OAuth 账号池确实把 `status >= 500` 当作可换兄弟账号的瞬时故障，但那也是立即换、无退避；单账号或普通 API key 的 provider 根本没有这条通路，一次 529 就烧掉一个候选，单候选链直接 502 给客户端——而同样的请求体隔一秒重发通常就成功。
- **修复**：新增 `overloadRetryDelayMs` + `withOverloadRetry`，包在四个 provider client 的 fetch 边界外层（anthropic、openai、codex-responses、generic-responses、gemini）。过载答复是**正常 Response 而非 throw**，所以过载重试必须套在 `withConnectionRetry` 外面，而不是塞进它的 `shouldRetry`。首字节前才重试、body 从未消费，因此幂等（原则 8）；被丢弃的 response 会 `body.cancel()` 释放 socket，codex 那条延迟到 body 的 timeout 定时器通过 `release` 钩子显式清理。
- **刻意收窄**：只认 **529 + 503**。500/502 是不明服务端故障，重试只是拖延真正的失败；429 是真限流，账号池 park 账号后走链才对。退避 **1s → 3s**（共 2 次重试）；上游给出数字 `Retry-After` 则优先，但**钳制在 10s**——一个上游不该占住客户端 socket 十分钟，那时换候选才是更快的答案路径。HTTP-date 形式的 `Retry-After` 不解析，退回默认表。
- **下游不变**：重试耗尽后仍抛原来的 `UpstreamError(upstreamStatus: 529)`，账号池换号、熔断计数、fallback 链、遥测字段**逻辑一行未改**——只是现在它们只在真的持续过载时才启动。客户端断连时立刻停止，不再多烧一次上游（此时返回的 response body 已被 drain，error detail 退化为 null；无人在听，可接受）。
- **测试影响**：三个老测试用 503 当"随便一个 5xx"占位（openai 401 分支、gemini/codex 非 JSON body 保留、generic 首 chunk 前抛错），503 现在会触发重试，已改成 500 并注明原因；意图不变，provider 套件同时从 9s 回到 2.5s。
- **TODO / 边界**：退避参数目前是代码常量，未做成配置（与原则 2 的"会撒谎的旋钮比没有旋钮更糟"一致，先观察线上真实 529 分布再决定）；OAuth 池**换账号之间**仍无延迟，本次未动——换号本身就是在换容量，加睡眠反而拖慢。

## 2026-07-25 · Responses WebSocket terminal 立即释放并关闭失效连接（Gateway / Protocol，docs/02/05/07，原则 3/8）

- **成功终态**：内部 SSE 一旦转发 `response.completed` 就停止读取并异步取消正文，不再等待 provider body EOF；请求与 ingress lease 随即释放，同一 downstream WebSocket 可以立即处理下一 turn，避免长期 `processing=true` 导致 1008、中断或卡住。
- **每轮取消边界**：downstream 连接只保留 connection controller，每个 `response.create` 另建 turn controller；终态后主动 abort 当前内部 fetch，但不 abort 可复用连接。客户端断连、bridge error 或并发发送第二个 active turn 时同时 abort 当前 turn 与 session，释放内存/并发 lease，不等待可能挂起的 body cancel。已观察到的 `completed` / `incomplete` / `failed` 优先于随后发生的 teardown `client_abort`，避免把真实结果误记为客户端中断。
- **失败终态**：`response.failed`、`response.incomplete`、`error`、非 2xx 与本地桥接错误均先发送协议终态，再幂等销毁 connection-local 上游 Session，并以 1000 正常关闭 downstream socket；终态本身已携带失败事实，不再用 1011 诱发客户端错误退避。Codex 下一次请求会新建连接并清除旧 `previous_response_id`，不会在已失效 Session 上续接。
- **Codex 增量续接**：真实客户端既会发送带完整 input 的 `generate:false` 预热帧，也会在启动预连接时发送严格的 `input:[] + generate:false` 预热帧；后一形状只有 normalized/native 两层都明确 `generate:false` 时才允许空 IR messages。下一帧可只带 `previous_response_id` 与空 `input`，此时仅当 Responses registry 已验证该 id 并固定原 provider 时放行；registry 在对客户端发送 terminal frame 前先持久化实际 provider alias、与成功 alias 相符的 OAuth account 及 selected lane，重启后仍恢复同一账号，fallback 前选中过但未实际服务的账号不会被写入。该持久化不伪造上游 connection-local state：Codex 在 WebSocket 重连时会清除旧增量状态并重发完整 input。续接在分类前固定为单 provider，真实 lane 继续受 `allowed_lanes` 约束，显式 custom-model 延续首轮既有语义；旧 registry 行缺少 lane provenance 时保持 fail-closed，`blocked_models` 与预算 degrade 同样不可绕过。普通空请求、未知 id、无 provider pin 与跨协议请求仍拒绝。`generate:false` 无 native Responses passthrough 时直接拒绝，不允许翻译路径意外产生计费输出。首 chunk 后的 `AbortError` 只记录为 `client_abort`，不误报上游截断，也不触发 breaker failure。
- **连接超时边界**：Codex 上游 WebSocket handshake 与非 101 error body 的等待上限为 `min(request_timeout_ms, 60s)`；正常流式请求仍使用既有 request/idle timeout，不因连接建立保护而缩短。没有新增配置、依赖、后台 drain 或 graceful-shutdown 重构。

## 2026-07-24 · Codex Voice、Responses 音频与图片编辑补齐代理面（Gateway / Protocol / Provider，docs/01/05/06，原则 1/2/3/7/8）

- **Realtime V1/V2/V3**：新增 `/v1/realtime/calls`、`/v1/live` 与对应 WebSocket sideband。Call-create 复用现有 static/OpenAI-Codex provider client、OAuth pool、账号 token 与 egress proxy；ChatGPT backend 继续使用 JSON call shape，官方 OpenAI 使用 multipart。`call_id` 以进程内短 TTL 绑定创建它的 Helm key 与实际 provider/account sideband，WebSocket 必须使用同一 key，且不会重新选账号；OAuth HTTP/WS 401 各只刷新重试一次。Call-create 接入现有进程内或 PostgreSQL 分布式并发 lease，DB 不可用时 fail-closed 为 503，持有期间 lease 丢失会中止上游请求。双向文本/二进制帧按实际字节占用动态内存预算，关闭压缩并保留 close code。当前部署为单 gateway replica；水平扩容前必须把 registry 换成支持原子 claim 的共享存储。
- **Codex upstream 线缆**：Codex 实际 WebRTC 请求使用 `x-session-id`，因此仅保留旧 `session-id` 会丢失会话身份；Realtime 只额外转发 `x-session-id` 与 `x-oai-attestation` 两个明确安全 header。ChatGPT backend 的 V3 `/v1/live` 不携带 query，但上游仍要求 `intent=quicksilver&architecture=avas`，只在 backend shape 且 query 为空时补该固定值；V1 sideband 使用 `/v1/realtime?intent=quicksilver&call_id=...`，V3 使用 `/v1/live/{call_id}`，custom/public base URL 保留已有路径前缀。同时复用目录运行时已生成的 Codex User-Agent，不信任或透传调用方任意 User-Agent。
- **Voice 授权边界**：ChatGPT Desktop 宿主会为 Realtime call-create 即时生成 `x-oai-attestation`，Helm 仅将该明确 header 转发到创建调用的 ChatGPT backend 与同一 `call_id` sideband，不接受或透传任意扩展 header。OpenAI OAuth 对 Voice 返回的推理 403 属于产品访问拒绝：账号池会尝试尚未试过的兄弟账号，全部拒绝后保留真实 403，但不会持久禁用仍可服务文本 Responses 的账号；真正的 401 与永久 token-refresh 失败仍按原策略隔离账号。
- **Responses 与模型目录**：Responses `input_audio.audio_url` data URL 进入统一 audio IR；provider 明确声明 `responses_audio_url` 时恢复同一 carrier，旧 `input_audio:{data,format}` 保持兼容。Codex 模型目录的 `input_modalities` 接受 `audio`，不再因新目录字段丢弃模型。
- **Images edits**：`/v1/images/edits` 复用现有 Images 的鉴权、限流、并发、预算、blocked-model、breaker/fallback、成本与 payload/telemetry 链；支持 Codex JSON `images[].image_url|file_id` 和 OpenAI multipart `image`/`image[]`、`mask`，binary bytes 在 fallback 间可重放。线上验证发现 ZenMux 虽在 `/models` 发布 `openai/gpt-image-2`，但 `/images/edits` 对它返回 `404 invalid_model`，而 OpenAI 官方对同一 JSON/multipart 请求均成功；因此客户端 `gpt-image-2` 改为 ZenMux 优先、OpenAI 官方操作回退。Gemini edit 未发现兼容契约，确定性返回 unsupported，不做有损转换。
- **暂缓边界**：按用户确认不代理 `alpha/search` 与 `memories/trace_summarize`；未引入新依赖、媒体存储、共享 registry 或第二套路由器。

## 2026-07-24 · 请求准入增加实时 V8 堆高水位（Gateway runtime，docs/02/07/10，原则 3/7）

- **线上根因**：`v0.28.7` 已限制请求、响应、写队列、Session cache 与 SSE capture 各自的静态容量，但生产容器仍在 12 小时内因 V8 heap OOM 重启 8 次；崩溃前 Mark-Compact 后仍有约 647 MiB live heap，而 heap limit 约 674 MiB。分池上限没有把当前 live heap 与其他分池尚可增长的容量合并判断，因此下一次 UTF-8 请求正文转换仍可触发进程级 OOM。
- **统一边界**：复用所有 HTTP JSON 与 Responses WebSocket 内部请求已经经过的 `BodyMemoryAdmission`，在读取、扩容和 `JSON.parse` 前同时检查 `heapUsed + active reservations`。高水位为 heap limit 扣除 response work、write queue、Session cache、response capture 与 5% GC 余量；超过时沿用现有协议形状返回 503，单请求 wire 上限仍返回 413。未新增配置、依赖、队列或并发限制。
- **运维边界**：该保护把聚合内存压力转成可恢复的拒绝，不负责物理缩小生产 20 GiB SQLite；历史正文清理与 VACUUM 仍必须通过既有维护 drain、磁盘与内存门禁执行，不能在线手工 VACUUM。

## 2026-07-24 · Admin 登录在 Host 被代理改写时复用浏览器同源证明（Admin auth，docs/10/11，原则 3/7）

- **根因与修复**：Admin 登录/登出的 CSRF 校验原本只比较 `Origin` 与请求 `Host` / `X-Forwarded-Host`；部分反向代理或 NAT 会把 `Host` 改成内部地址且不补 `X-Forwarded-Host`，导致浏览器从同一外部 origin 提交表单也稳定返回 403。校验现在优先接受浏览器提供的 `Sec-Fetch-Site: same-origin`，再保留原有 Host 比较与 opaque-origin 边界；`cross-site` 仍拒绝。该 header 不能由网页脚本伪造，而无 `Origin` 的非浏览器客户端原本就允许，因此不新增配置、代理白名单或信任任意 forwarded header。

## 2026-07-24 · Responses WebSocket ingress 改为按活动消息计费（Gateway / Protocol，docs/02/05/07，原则 3/8）

- **根因与修复**：机器推导的 native ingress 池原本在 Upgrade 时为每条连接预留一个完整最大帧，导致空闲/预热连接达到 `floor(ingressBytes / maxPayload)` 后稳定返回 503。Upgrade 现在只瞬时探测零容量或暂停状态，空闲连接不保留 ingress lease；收到 `response.create` 后按消息真实 wire bytes 申请 ingress 与既有 JSON amplification 两级预算，并在请求结束时一起释放。
- **握手错误正文**：一旦上游已经返回非 101 HTTP response，关闭 `ws` 的 opening-handshake socket timeout，改由既有的有界 response-body timeout 接管；避免两个同期限时器竞争，把确定性 timeout 偶发误报为 generic body failure。正文大小上限、socket 销毁与客户端错误形状保持不变。
- **安全边界**：`ws.maxPayload` 继续按运行时机器容量动态限制单帧，超限仍以 1009/413 失败；活动消息超过 native ingress 池仍返回结构化 503，超过共享请求池也继续拒绝。没有新增固定连接数、队列、配置或依赖；定向测试同时覆盖“第三条空闲连接可建立”和“第三条并发活动消息被预算拒绝”。

## 2026-07-23 · PostgreSQL API-key 分布式并发 lease（Phase 1，docs/06/10，原则 1/3/7）

- **一致性边界**：仅 `supabase`/PostgreSQL 使用 state-row `FOR UPDATE` + DB `clock_timestamp()` 的 lease 表实现跨 replica 上限；SQLite 保持既有 process-local FIFO。statement-time clock 避免等待 row lock 后仍使用事务开始时间；lease 过期回收不依赖 Node clock，也不维护独立 active counter。
- **本地调度边界**：每 replica/key 只让本地队首轮询 DB；默认 TTL 30s、heartbeat 10s，失败轮询使用可注入的 100–250ms jitter。manager 同时以 DB 返回 `expiresAtMs` 和本地 RPC 开始时间 + TTL 的较早值作为 ownership deadline，防止 acquire/renew 响应延迟或挂起越过已知租期。renew 失败使持有者 signal 以 `concurrency_lease_lost` abort，release 为 async/idempotent best-effort，gateway 将它与 client abort/request timeout 合并；流 lease 到 body final close/cancel 才释放。shutdown 会等待正在进行的 acquire，并在返回前清理 late-success orphan。
- **真实 PG 验收**：`apps/gateway/e2e/concurrency-postgres.spec.ts` 用两个独立 postgres-js pool、两个 distributed manager 和两个请求级 Hono app 验证 100 并发全局上限、key 隔离、TTL crash recovery、heartbeat、lease-loss no-cooldown、stream final/cancel 与 DB-unavailable 503。`pnpm test:e2e` 的 launcher 按 `PG_TEST_URL` > `HELM_TEST_POSTGRES_URL` 取外部测试库；无 URL 时自动启动 digest-pinned PostgreSQL 17 + pgvector 并 finally 清理，Docker 不可用则明确失败。PGlite 仍只算 SQL/contract coverage，不计真实多 pool AC。

## 2026-07-23 · Session 恢复与在线响应共享内存池（Admin requests，docs/07/11，原则 3/7）

- **恢复窗口**：Admin Session 恢复单次最多预占 response-work 池的一半，允许两次有界恢复并行，也为在线 API 响应保留容量；第三次并发恢复或超过半窗口的会话继续返回 `session_recovery_limited`。保留先准入、后物化正文的顺序，不新增队列、配置或独立内存池。

## 历史条目摘要（最新要点）

- **2026-07-23 · Codex Responses 按运行时容量准入并让夜间 SQLite 维护收缩内存（Gateway / Session / Store，docs/02/05/07/10，原则 2/3/7/8）**：机器推导的共享请求/响应/缓存预算、活动消息准入和维护 drain 保留正文捕获与自动维护能力；后续物化重复计账、WebSocket ingress 与 terminal 生命周期修正见顶部更新条目，完整原文通过 git history 回溯。
- **2026-07-23 · SQLite Session 与 Memory 正文使用兼容 gzip 存储（Store / Memory，docs/07/08，原则 1/3/7）**：SQLite 以 value type + gzip magic 兼容压缩 Session/Memory 正文，不回写历史数据、不在线 VACUUM，完整原文通过 git history 回溯。
- **2026-07-22 · 全项目文案审查补齐多语言维护闭环（Admin / Portal / Setup，docs/11/12，原则 1/2）**：以 Opus 只读审查和七语言结构测试补齐 Admin、Portal、Setup 文案维护闭环，完整原文通过 git history 回溯。
- **2026-07-22 · Session 恢复补齐响应快照并限制默认留存范围（Telemetry / Admin requests，docs/07/11，原则 1/3/7/8）**：复用 `session_revisions.response_json` 不新增迁移，四种协议的成功非流式请求保存客户端形态响应快照，流式不新增 SSE 缓冲；单快照 16 MiB、Session 64 MiB 上限，来源恒为 `exact=false` 故 Retry 禁用，完整原文通过 git history 回溯。
- **2026-07-22 · 按会话增量保存请求正文并诚实区分恢复保真度（Telemetry / Admin requests / Store，docs/07/11，原则 1/3/7/8）**：新增 `capture_sessions` 与 `capture_payloads` 构成三种互斥留存模式（同时为 true 则 fail-closed），只解析高置信客户端会话信号并以不可猜测 `session_ref` 存储；Session head + 单调 sequence + 不可变 revision 按最长公共前缀存增量，Responses 续接建真实 `response_id → request_id` 父边、找不到父 response 时恢复 fail-closed 为 `session_incomplete`，完整原文通过 git history 回溯。
- **2026-07-22 · Lanes 批量保存、拖拽回退与可配置默认通道删除边界（Routing / Admin lanes，docs/03/04/11，原则 2/3/5/6）**：Lanes 整组原子保存、拖拽排序并只保护当前默认通道，非法默认配置 fail-closed，完整原文通过 git history 回溯。
- **2026-07-22 · Responses 状态续接严格绑定原 provider 与账号（Protocol translation / provider execution，docs/04/05/07，原则 2/3/5/8）**：`previous_response_id` 只允许同 account/key、原 provider 与原账号继续执行；未知、跨协议或不可用状态 fail-closed，完整原文通过 git history 回溯。
- **2026-07-22 · Codex 客户端默认启用 Responses WebSocket，并补齐反向代理边界（Deployment / Protocol / Admin client setup，docs/05/10/11，原则 3/5/8）**：Admin 的 Codex 配置复用既有 Responses WebSocket；代理只在真实 Upgrade 时转发 hop-by-hop header，Claude 图片 shim 延后，完整原文通过 git history 回溯。
- **2026-07-21 · 首次安装改为令牌保护的浏览器向导并允许订阅-only 启动（Deployment / bootstrap / Admin，docs/10/11，原则 2/3/7）**：无完整 Admin 凭据时只开放令牌保护的浏览器向导与健康端点，完成后同进程启用 Gateway；凭据保存到 `0600` managed env，CLI/无 `.env`/OAuth-only Linux 安装路径均完成实测，完整原文通过 git history 回溯。
- **2026-07-21 · Grok Build 复用 OpenAI 模型发现接入 Helm（Admin client setup，docs/05/11，原则 2/5/6）**：Grok Build 复用现有 `/v1/models` 与 Chat Completions，只新增七语言客户端配置引导，不引入专用路由或依赖；完整原文通过 git history 回溯。
- **2026-07-20 · `end_turn` XML 泄漏只按终态工具调用恢复（Protocol streaming / provider execution，原则 3/5/8）**：仅在终态、完整、白名单且无既有结构化调用时恢复 `end_turn` XML 工具调用，四个出口共用收紧边界；完整原文通过 git history 回溯。
- **2026-07-18 · 请求推理等级与实际路由等级分开展示（Telemetry / Admin requests，原则 1/7）**：单独保存客户端请求等级与覆盖后的实际执行等级，共享列表分别展示且不从旧记录反推；完整原文通过 git history 回溯。
- **2026-07-18 · 关闭正文捕获时仍保留推理等级（Telemetry / Admin requests，原则 1/7）**：完整正文关闭时仍把实际生效的 `reasoning_effort` 作为脱敏 DecisionRecord 元数据保存并显示；完整原文通过 git history 回溯。
- **2026-07-18 · Codex 自动压缩目录与无状态传输故障切换（OAuth subscription / Responses / provider execution，原则 3/5/7/8）**：对齐 Codex 自动压缩阈值，并只允许无状态 transport failure 在兄弟账号间切换；有状态续接与私有 Responses items 保持 fail-closed，完整原文通过 git history 回溯。
- **2026-07-17 · Anthropic XML 工具调用恢复边界（Protocol streaming / provider execution，原则 3/5/8）**：只在终态、完整、白名单且无既有结构化调用时恢复 XML 工具调用；四个实际出口共用边界并以有界缓冲保持流式保真，完整原文通过 git history 回溯。
- **2026-07-16 · 历史费用回填放宽 WAL 与磁盘恢复门槛（Catalog / telemetry repair operations，原则 2/3/7）**：在既有 100 行原子批次、资源门禁和 12 GiB 硬底线不变的前提下，按健康实测放宽 preflight WAL/磁盘恢复门槛，避免任务永久饥饿；完整原文通过 git history 回溯。
- **2026-07-16 · 路由白名单改为真实交集并让分类开关兑现配置语义（Routing / classifier / CI，原则 2/3/5/6/7）**：Policy 与 key 白名单求真实交集并让空集 fail-closed；rules/eval cache 开关兑现配置语义，CI Actions 固定到核验 SHA；完整原文通过 git history 回溯。
- **2026-07-16 · xAI 订阅协议跟随官方 grok-build 并收紧动态目录边界（OAuth subscription / model catalog / Responses / Admin providers，原则 2/3/6/7/8）**：以真实 wire 和账号 entitlement 分离模型目录 ID、执行 slug、能力与配额，未知能力保持 fail-closed，跨账号冲突拒绝；完整原文通过 git history 回溯。
- **2026-07-16 · 收紧发布信任链、请求归属与 Memory 项目隔离（CI / observability / Memory，原则 1/3/7）**：PR 信任链固定到受核验 merge ref 与只读权限，发布绑定已验证 main SHA；内部 `request_id` 与客户端 trace 分离，Memory thread/project 迁移保持租户隔离与事务原子性；完整原文通过 git history 回溯。
- **2026-07-16 · 文档以当前源码为准完成全量运行时事实校准（docs/01–14 / README / operations，原则 1–8）**：以当前路由、schema、Store、配置与测试校准全部当前文档和中英文 README，明确 Portal、部署、安全、Memory 与协议实现/缺口边界；完整原文通过 git history 回溯。
- **2026-07-16 · Admin 首次点击卡顿改为非投机加载与汇总读（Admin / Store performance，docs/08/11，原则 1/3/7）**：以 `memory_threads` 的事务维护汇总替代正文表冷扫描，Admin 改为非投机 data preload，并以有界 stale-while-revalidate 缓存保护统计读取；在线 VACUUM 继续禁止。
- **2026-07-15 · Codex 配额 PULL 饱和后触发自动重置（OAuth quota / reset credits，docs/04/11，原则 3/5/7）**：仅新鲜 PULL/PUSH 在账号级周窗口饱和后经共享幂等 guard 触发 reset credit，成功后强制回读并同步 durable/live quota；cache-only 读取始终无副作用。
- **2026-07-15 · Anthropic 不可用地域哨兵按全球基础卡计费（Catalog / telemetry accounting，docs/07/08，原则 2/3/5/7）**：仅把 `usage.inference_geo=not_available` 解释为地域缺失并使用全球基础卡，真实未知地域继续 unknown；实时与历史重算共用规范化且保留原始 provenance。
- **2026-07-15 · 终端事件缺失的 Responses 流使用部分估算计费（Protocol streaming / telemetry accounting，docs/05/07，原则 3/5/7/8）**：原生 Responses 流缺终态时按 truncated/client_aborted 记失败，仅对已收 semantic delta 做有界 partial usage/cost 估算，并让 telemetry、attempt、budget 与 OAuth 账号结算一致；完整原文通过 git history 回溯。
- **2026-07-15 · 历史费用回填改由常驻 supervisor 持续推进（Catalog / telemetry repair operations，docs/07/08，原则 2/3/5/7）**：systemd 常驻 supervisor 以单实例、100 行原子批次、checkpoint、slice verification、微型恢复库、资源门禁和 5,000 行冷却推进固定截止点前的历史修复；完整原文通过 git history 回溯。
- **2026-07-15 · 历史重算兼容旧版 completion-only 顶层费用（Catalog / telemetry repair，docs/07/08，原则 2/5/7）**：仅在顶层、attempt 与 breakdown 同时精确证明旧版只保存 completion cost 时接受回填，任何其他漂移仍 fail-closed；完整原文通过 git history 回溯。
- **2026-07-14 · 官方模型费率与多模态计费校准（Catalog / telemetry / protocol usage，docs/04/05/07/08，原则 1/2/3/5/7/8）**：以官方价格和响应中可证明的 tier、地域、缓存与 modality 证据计费；未知分价、动态 alias 与已丢失的历史证据保持 unknown，历史修复只经 manifest、微型恢复库和资源门禁渐进执行。
- **2026-07-14 · 确定模型名优先于兼容通配别名（Routing / model alias precedence，docs/04，原则 2/5/6）**：精确 lane 与已配置 model 必须先于 `claude-*` / `gpt-*` / `gemini-*` 等宽泛兼容映射解析，避免显式模型被错误改写到其他 lane。
- **2026-07-14 · 通道模型选择器复用自动发现缓存（OAuth subscription / Admin lanes，docs/04/11，原则 1/3/6）**：通道目录保持 network-free，依次复用共享进程缓存、加密账号设置中的 durable last-known-good 与 curated fallback；空目录/失败不覆盖旧快照，重连以 cache generation 隔离旧身份，并保持 Manual/Codex entitlement 边界。
- **2026-07-14 · 丢弃 Codex 空 secondary 配额占位窗口（OAuth quota / Admin providers / reset credits，docs/04/11，原则 3/5/7）**：写入、cache-only API 与 UI 三层过滤 0%/无时长/已重置的空 positional 窗口；明确 `windowMinutes >= 10080` 的账号周窗口优先，避免脏 secondary 覆盖真实周额度与 reset marker。
- **2026-07-14 · Subscription Providers 改为缓存优先与全局串行刷新（OAuth Admin / provider observability，docs/04/11，原则 1/3/6/7）**：Providers 首屏与兼容读 API 严格 cache-only；显式刷新由进程级单 worker 串行账号、合并并发点击并保留 last-known-good 数据。
- **2026-07-14 · Avoid Waste 在 provider 池内限制 reset-credit 偏置（OAuth provider selection，docs/04/11，原则 3/5/6）**：reset credits 只作为同一 provider 池内的弱恢复容量信号，不能压过明显更多的真实即将过期额度；套餐标签不参与分池或评分。
- **2026-07-13 · Responses 工具结果的 multipart 文本使用 input_text（Protocol translation / provider execution，docs/05/07，原则 3/5/8）**：provider 与共享 transformer 统一把请求侧 multipart 工具结果文本编码为 `input_text`，保留字符串、图片、文件与助手输出的既有 wire shape。
- **2026-07-13 · Codex 周配额按真实窗口时长识别（OAuth quota / Admin providers / reset credits，docs/04/11，原则 3/5/7）**：账号级 Codex 周窗口以 provider 报告的 `windowMinutes >= 10080` 为权威，旧快照仅在缺 duration 且有真实用量时回退 secondary；Admin、reset-credit 与 model-scoped 隔离共用同一规则。
- **2026-07-12 · Grok premium fallback 与 Composer 评估边界（Routing / provider evaluation，docs/04/07，原则 2/3/5/6/7）**：移除 official OpenAI/ZenMux 自动付费候选，premium 以已验证的 SuperGrok Grok 4.5 作为订阅 fallback；Composer 因真实 A/B 的空响应与质量不足不进 lane，底层 transport/发现保留，xAI Admin 选择器补 curated 展示但运行时 entitlement 继续 fail-closed。
- **2026-07-12 · SuperGrok 周配额使用现有 OAuth 读取私有 gRPC-Web credits（OAuth subscription / Admin providers，docs/04/09/11，原则 3/6/7）**：复用现有 xAI OAuth bearer 严格读取 weekly gRPC-Web credits，按账号持久化 quota/cooldown 并以 cache epoch 隔离重连竞态；不保存 Cookie、不混用月度/public billing。
- **2026-07-12 · SuperGrok/X Premium OAuth 实验性订阅 Provider（OAuth subscription / Responses / Admin providers，docs/04/09/10/11，原则 2/3/6/7/8）**：通过受限 device-code OAuth、加密 token、generic Responses executor 与严格 host/redirect/body-size 边界接入实验性 SuperGrok；动态 entitlement、SSE 聚合、Admin 状态及真实协议矩阵完成验证，Composer 保持 unpriced，Grok 4.5 后续按公开 API 等价费率计 telemetry。
- **2026-07-11 · 上下文链耗尽恢复 Claude CLI 自动压缩信号（Provider execution / protocol errors，docs/04/05/07，原则 3/5/7/8）**：候选级 context overflow 继续 fail-open fallback；仅上下文/能力 skip 的整链耗尽统一返回 Claude CLI 可识别的 `invalid_request / 400` 与精确 token 上限消息，混合真实 provider failure 保留原分类。
- **2026-07-11 · Subscription Provider 自动模型展示使用账号级发现与共享缓存（OAuth subscription / Admin providers，docs/04/11，原则 1/3/6）**：Providers 表格与 Manage 弹窗改用账号实时发现；非 Codex 使用共享进程缓存与 last-known-good，手动 allowlist、Codex entitlement 和运行时 curated fail-open 边界保持不变。
- **2026-07-11 · Claude Sonnet 5 订阅流量 API 等价成本与能力目录（Provider catalog / cost telemetry，docs/04/07/11，原则 2/5/7）**：默认 Anthropic 订阅路由升级到 Sonnet 5，并按官方介绍期 API 等价费率记录 telemetry；补齐 1M context、128K output、tools/vision/stream/structured outputs/document 与 adaptive-thinking 能力，2026-09-01 需更新标准费率。
- **2026-07-11 · 退休 GPT-5.3-Codex-Spark 及其订阅配额投影（OAuth subscription / model catalog / Admin providers，docs/04/11，原则 3/5/6/7）**：从 live/bundled/cached catalog 与手工设置过滤退休模型，并从 WHAM/header/durable/Admin quota 投影移除其 model-scoped 限额，保留最小历史识别以阻止旧缓存复活。
- **2026-07-11 · Portal 请求详情对齐 Admin 查看器但保持供应链边界（Self-Service Portal / Requests，docs/12，原则 1/6/7/8）**：复用 Admin viewer 并按 metadata-first 懒加载请求/响应与图片，同时保持 ownership 和 `upstream_request` 隔离边界。
- **2026-07-11 · API-key 门户自助 Memory 默认设置（Self-Service Portal / Memory，docs/06/08/12，原则 2/7）**：bearer key 可在 Portal 安全配置 observe/inject、共享项目与线程来源；root 只读，显式请求头仍覆盖默认值。
- **2026-07-10–11 · Codex CLI GPT-5.6 subscription parity（OAuth subscription / Responses / model catalog，docs/04/05/11，原则 3/5/6/7/8）**：按 Codex 源码补齐 GPT-5.6 模型目录、Responses/WebSocket/compact、usage、订阅 entitlement 与 reset-credit 安全边界，并完成真实 CLI 验证。
- **2026-07-10 · Direct DeepSeek Responses reasoning history pre-skip（Provider execution / protocol translation，docs/04/05/07，原则 3/5/8）**：检测到 Responses reasoning history 时预跳过无法接收回传 `reasoning_content` 的 direct DeepSeek Chat 候选；OpenRouter mirror 保持可尝试，避免确定性 400 而不改变最终 fallback。
- **2026-07-10 · GPT-5.6 Chat tools force reasoning_effort none（Provider execution / protocol translation，docs/04/05/07，原则 3/5/8）**：official GPT-5.6 Chat fallback 带 tools 时强制 wire `reasoning_effort:none`，保留 tools 并记录专用 body shim，避免 Responses-only 组合返回确定性 400。
- **2026-07-10 · GPT-5.6 family support in Helm defaults（Routing / provider catalog / cost telemetry，docs/03/04/07，原则 3/4/5/6）**：默认 lanes、能力/价格目录与 wire 参数升级到 Sol/Terra/Luna，同时保持 official API 与 Codex subscription 的 entitlement/context 边界。
- **2026-07-06 · 请求总超时驱动下游 abort 与失败 telemetry（Gateway runtime / telemetry，docs/02/07，原则 3/5/7）**：总超时统一 abort 下游并把客户端可见终态固定为 timeout，晚到 provider 成功只保留为 attempt 事实，不得覆盖最终失败或 payload。
- **2026-07-06 · API key 绝对模型黑名单（Key governance / routing / Admin keys，docs/04/06/11，原则 5/6/7）**：每把 key 的 exact/glob `blocked_models` 同时约束 direct、lane expansion、fallback、model list 与各协议入口，空链 fail-closed，SQLite/Postgres 与 Admin 表单保持一致。
- **2026-07-06 · 折叠会话行显示工具调用参数预览（Admin requests / conversation view，docs/11，原则 1）**：工具参数预览改为 whitelist-free，按 args 形状泛化提取 readable scalar，覆盖自定义/大小写不同工具并保留展开详情。
- **2026-07-06 · 配额 PULL 的 100% 账号级窗口必须同步停车（OAuth provider pool / Admin providers，docs/04/11，原则 3/5/7）**：quota PULL 看到账号级 100% 窗口时立即写入 cooldown 并同步 live pool，scoped model 窗口不扩大成全账号停车。
- **2026-07-05 · OAuth 凭证失效持久化为 needs reconnect（OAuth provider pool / Admin providers，docs/04/11，原则 3/5/7）**：refresh/持久 upstream 400/401/403 标记 credential failure、写入账号设置并摘出调度，reconnect 成功后按手动/自动停车边界恢复。

## 更早历史总览

2026-07-07–09 压缩条目包括 self-service portal 完整实现与多语言、视觉压缩后的 cache-control 收敛和 Anthropic 兼容路径 CCH 稳定化。

2026-07-06 压缩条目还包括 Anthropic native passthrough 稳定 Claude Code billing `cch`、Admin 模型搜索预计算列、payload 分段懒加载、纯工具 turn 去空 header/默认展开，以及 Claude Code 风格 inline tool peek。2026-07-04 更早条目还包括 cheap-model 当前轮低风险降级、视觉上下文压缩 observe/off 接入、Memory stats 队列索引优化、OAuth 会话亲和调度、idle-flush 碎片段优先压缩最大连续段、memory worker 受控并发追赶、记忆页只读运行状态面板、Claude scoped weekly quota 只影响对应模型、跨协议 reasoning-history 候选级跳过、memory idle-flush 防饥饿、策略级 reasoning_effort 覆盖 lane 默认值、cron monitor 低成本规则等。2026-06-30 及以前的工作主要围绕 Helm API 的协议面、路由执行、admin 可观测性与自托管部署逐步成型：补齐 Gemini/OpenAI/Anthropic/Responses 双向转换、SSE 流式正确性、tool-call/JSON schema/思考参数保真、per-model reasoning effort、模型别名与能力/成本目录、provider fallback 与熔断语义、OAuth subscription providers、多账户池与 quota 处理、memory observe/inject/forgetting/admin/MCP、请求 payload 捕获与 request detail UI、API key 治理、admin 表格/过滤/分页/i18n、Docker/CI/release/deploy 验证，以及早期 Phase 0 的 Hono + SvelteKit static admin + Store 端口 + SQLite/Supabase 架构决策。更早细节不再逐条保留在本文件；需要精确背景时回查 git history。
