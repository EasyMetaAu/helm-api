# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-08-04 · Codex 请求跨协议 fallback 全军覆没（Provider execution / Protocol，docs/03/04/05，原则 3/5/8）

- **现场根因（三个叠加的独立 bug）**：一个带 Codex 原生 items（`custom_tool_call` / caller-linked PTC）的 Responses 请求，在 GPT 订阅池耗尽后返回 `all_providers_failed`——Grok 422、Claude/DeepSeek/zenmux/openrouter 全被 skip。用户切 Grok / Claude 都用不了。
  - **Bug A**：`protocolGuardSkipReason`（execute.ts）对“源 Responses + 目标非 Responses + 带 native items”一律整体跳过候选，连协议翻译都不做——过度保守。实测 IR 折叠器 `toIRRequest` 已能把 `custom_tool_call` / 无 caller 的 `function_call` 无损折进 `assistant.tool_calls`；真正跨协议装不下的只有 unknown item 类型与 caller-linked PTC 并行链。
  - **Bug B**：`canUseNativePassthrough` 只比协议，把 Codex(responses)→Grok(generic responses) 判为“同协议→透传”，逐字（只换 model 名）把 Codex 私有 body 发给 Grok → 422。
  - **Bug C（矛盾根因）**：`candidateGuardSkipReason` 的 profile 检查读 `target.provider?.nativeProtocolProfile`，但 `createSerializingClient` 逐方法转发时**漏了 `nativeProtocolProfile` 这个数据字段**。多账号 OAuth 池（box xai 有 2 个账号）因 pool 要求“所有成员 profile 一致才暴露”而塌成 `undefined`，profile 检查失效 → Grok 漏过 skip 发出 422。这解释了诊断时“Grok 未 skip 却 422、Claude 被 skip”的字面矛盾（两 guard 条件不对称，非数据被 mutate）。
- **修复**：(A) 新增纯函数 `responsesInputItemsAreCrossProtocolLossy`（core，导出），把两个 guard 收窄为“仅 unknown_items 或 caller-linked/unknown item 才 skip”，可折叠 items 放行走翻译。(B) `canUseNativePassthrough` 新增 `sourceCarriesResponsesNativeItems` + `targetIsGenericResponsesProfile` 两个输入与新 disable reason `responses_native_body_provider_incompatible`：Codex-origin body → generic responses provider 不透传，fall through 到 `chatCompletion(Stream)` 翻译，`openaiToGenericResponsesRequest` 天生产出干净 body。(C) `createSerializingClient` 补透传 `nativeProtocolProfile`，让多成员池正确暴露 profile。
- **权衡与边界**：profile 判据选择读 pool client 运行时字段（Bug C 修好后可靠）而非 `resolveAttemptTarget` 静态标志——更贴近“这个成员实际讲什么协议”。有损降级会丢 `reasoning.encrypted_content`（Grok 本就不认）；caller-linked PTC / unknown items **仍保持 hard skip**，不做有损翻译。判据读 `provider_raw.responses_input_items`/`unknown_items`（copy-on-write 恒定、是“带不可翻译结构”的精确信号），**不改读** `native_request.body.input`（任何 responses 请求都有 input，会误判）。TDD 全绿：新增 predicate 单测、pool profile 透传测、两个 guard 收窄测、Grok 走翻译集成测（411 tests）。
- **Grok 双轮 review 追加修复**：(High) 放行 `type:"custom"` 工具后必须真正降级——`normalizeResponsesTools` 把 custom 工具声明转成标准 function tool 进 `IR.tools`（不再进 `responses_native_tools`），否则跨协议到 Claude 时工具声明整个丢失、agent 工具环断（`responses_native_tools` 不在 anthropic forward 白名单）。custom 降级后 `responses_native_tools` 只剩服务端工具，guard 恢复无条件 hard-skip（删掉了中途加的 allowlist 判据，净简化）。原始 custom 形状仍由 `responses_tools`（rawTools 快照）保护 Codex→Codex 同协议回渲染。(Medium) generic responses target 不再 forward `responses_input_items`（`renderProviderRawForTarget` 加 `targetIsGenericResponsesProfile` 参数删该 key），正确性不再依赖 Grok 客户端碰巧 ignore 它。(Medium) serialize-client 补透传 `streamReframed`（连同 profile）。
- **已知限制（Grok 次要发现，本 PR 不修）**：`custom_tool_call.input` 是 free-form 文本（apply_patch 的 patch / shell 命令），fold 进 IR `function.arguments` 后，Anthropic 侧 `JSON.parse` 失败会回退成 `{}`——历史轮 tool call 的**参数**在跨协议翻译时降级为空对象。这是既有 fold 语义（本 PR 只是让该路径可达），影响历史工具调用的参数保真度，不影响 Claude 理解“上一轮做过什么”（结果在 tool_output 里）与调用新工具。修它需改 IR tool-call arguments 的 non-JSON 承载语义、波及所有 provider，超出本 PR 范围，留作 follow-up。
- **数据完整性论证（回应“服务端数据取不回”质疑）**：原跳过的理由是“Responses body 不完整、部分数据只在服务端”。代码+OpenAI 文档双证：真正“历史在服务端”的机制只有 `previous_response_id`，该 guard **原封不动保留**（`protocolGuardSkipReason` 在收窄的 items 检查之前先 return，换 provider 续接另有 `_provider_mismatch`）。Codex 恒发 `store:false`，语义是服务端无状态、客户端每轮重发完整历史——`sanitizeStoreFalseInputItems` 主动删每个 item 的 `id` 死引用，正证明 `input[]` 自包含、正文全在 body（`custom_tool_call.input` / `function_call.arguments` 皆 inline `z.string()`）。翻译丢弃的 `reasoning.encrypted_content` 是 OpenAI 私有的**加密推理 token 缓存（跨轮 reasoning 连续性优化），不是对话内容**——对话由 message/tool item 承载并完整保留，且任何非-OpenAI provider 本就无法消费该加密串。故“可折叠 ⇒ 自包含 ⇒ 可翻译”成立，放行范围无需再收窄。

## 2026-08-03 · 受限容器不再重复套用宿主机固定内存预留（Gateway runtime，docs/02/05/10，原则 3/7/8）

- **现场根因**：1.5 GiB cgroup 当时仍有约 457.96 MiB 可用内存，但动态准入先扣除面向非受限宿主机的 384 MiB 固定预留，再只使用剩余量的 70%，把安全工作容量压到约 51.78 MiB；一个 25.64 MiB Responses 请求按 6 倍 JSON 放大计为约 153.86 MiB，即使共享协调器没有任何活动 lease 也会稳定返回 503。
- **最小修复**：受 cgroup 约束时只按容器总量的 5%（最多 1 GiB）保留 native headroom；未受约束进程继续使用原有 384 MiB 下限。V8 128 MiB emergency reserve、70% utilization、HTTP/WebSocket/response-work 共享协调器和 maintenance drain 均保持不变。事故快照下容量变为约 266.81 MiB，单请求可通过，而两个同体积并发请求仍超过共享容量。
- **e2e 边界**：Playwright gateway 注入确定性压力门，普通后台观察始终允许，重型维护始终禁止，避免 hosted runner 的瞬时 PSI 暂停 60 秒 Memory worker。生产入口不注入，继续读取真实 cgroup、可用内存与 PSI；request、WebSocket 与 response work 仍共享同一个全局 coordinator。
- **边界**：不恢复固定 HTTP/WebSocket/Session 大小上限，不为空闲协调器增加超额旁路，也不以扩大容器替代算法修复。有限进程仍可能对真正超过实时安全 headroom 的请求返回结构化过载错误。

## 2026-08-03 · 多候选上下文溢出优先恢复客户端压缩信号（Provider execution / protocol errors，docs/04/05/07，原则 3/5/8）

- **终态优先级**：单个候选的上下文溢出若混有真实 provider failure，仍返回 `all_providers_failed / 502`；同一链中至少两个不同 provider/model 通过精确 `count_tokens` 或结构化 `context_length_exceeded` 分别确认溢出时，即使夹有其他候选故障，也返回 `invalid_request / 400` 并保留上游消息，让 Claude/Codex 客户端进入既有自动压缩路径。
- **流式诊断保真**：首输出前的原生 Responses SSE 错误现在只把 `type/code/message/param` 与嵌套 error envelope 放入 `UpstreamError.providerRaw`，并读取 top-level `message`；既保留 fallback 分类依据，又不让 `response.failed.response` 中的 instructions、tools、metadata 或 output 进入常规 telemetry。
- **保守边界**：近似字符/token 估算和自由文本错误仍可用于“整链只有上下文/能力 skip”的既有 400，但不能压过真实 5xx/422；没有增加请求、Session 或上下文固定上限。top-level `error` 的 exact-once 终态统一和 CRLF SSE framing 属于独立协议问题，本次不扩大修改面。

## 2026-08-02 · Responses WebSocket 首输出前恢复并提前释放物化准入（Protocol / Gateway runtime，docs/05/07/10，原则 3/5/8）

- **恢复边界**：上游 WebSocket 只产生 `response.created` / `response.in_progress` 后关闭时，丢弃未提交的 preamble，按既有连接重试预算重连，耗尽后回退 HTTP/SSE；最多缓冲协议正常需要的两个 preamble，第三个重复 preamble 立即提交为已开始输出，避免异常上游造成无界缓存。真实输出一旦开始则绝不重放。`response.cancelled` 在 provider parser 与 ingress bridge 都是失败终态，不再追加伪 bridge error。
- **准入生命周期**：Responses WebSocket bridge 用进程内 `WeakMap<Request, callback>` 把 request-body lease 交给可信内部路由；只有随机 proof 匹配的内部请求会在第二次 JSON parse 成功或失败后立即标为已物化，provider 等待不再长期持有 6 倍预留，而 parser 完成前的并发大请求仍受动态 headroom 保护。没有恢复固定请求、WebSocket 或 Session 大小上限。
- **保留边界**：bridge 到内部 Responses 路由仍有一次 `JSON.stringify` 与再次 parse；本次先修已证实的 503 放大根因，不抽取会绕过鉴权、schema、rate limit、并发与 telemetry 的第二条执行通道。

## 2026-08-02 · 流式错误的 telemetry 终态与 metadata-only 捕获短路（Gateway / Telemetry，docs/05/07，原则 3/7/8）

- **流式终态**：Chat、Messages 与 Gemini 在已经开始写 SSE 后遇到非取消错误时，共用取消边界旁的 helper，把同一份 `DecisionRecord` 标为 `final.status=error`、保留协议映射使用的 `error_reason`，并写入 `stream_outcome=failed`；客户端主动断连仍只走原有 `client_aborted` 语义。
- **metadata-only**：Session capture 关闭时，队列入口在计算 request/response 字节、查询饱和 cache 或创建 deferred DB write 前直接返回；不会产生 `session.capture_limited` 或 Session 存储工作，脱敏 telemetry 的正常记录不受影响。

## 2026-08-02 · xAI Responses 对象 input 在本地拒绝（Protocol / provider execution，docs/04/05/07，原则 3/5/8）

- **确定性边界**：xAI `grok-4.5` 对 `input` 对象返回 `invalid type: map, expected a sequence`；只为 xAI 的 generic Responses contract 增加对象形态预检，返回结构化 `invalid_request / 400` 且不发起上游请求。数组保持可用；未证实 string 形态，不猜测也不改写。
- **资源边界**：未修改 response-work admission、错误正文预算或 Session 容量。xAI 的 `error_body_capacity_exhausted` 是独立的上游正文边界，本次没有足够的稳定请求契约可做本地预判，仍保留其真实 provider 诊断而不虚构 Helm 固定上限。

## 2026-08-02 · Session 正文改为原子分块存储并以机器压力协调后台工作（Telemetry / Gateway runtime，docs/02/07/11，原则 3/7）

- **存储格式**：新 Session 正文按 UTF-8 安全的 256 KiB 原始块逐块 gzip/raw 写入，最多 4 块一批；revision 用请求/响应两个 generation 指针原子发布，响应回填不重写大请求正文，并发重试不会把一份元数据配到另一份正文。历史正文不扫描、不回填；legacy 行继续读取，首次响应回填记录准确的逻辑 `body_bytes`。Admin 恢复先按机器动态 response-work 预算分页，只读取已发布 generation；旧二进制正文在缺少可靠原始字节数时 fail-closed。
- **无 Session 容量上限**：不恢复 64 MiB 或其他累计上限；单次正文、写队列、HTTP/WebSocket 与响应解析共享基于 V8/cgroup/可用内存的动态协调器，允许更大机器自动使用更多内存，但在 PSI/内存压力下暂停 Memory、Signals 与 scheduled cleanup。健康连续 60 秒后才恢复，避免抖动。
- **维护边界**：SQLite Session prune 继续小批续跑；PostgreSQL 每次 cleanup tick 最多处理 128 个物理行、每批 16 行，并用持久 marker 续跑。scheduled cleanup 与 auto-VACUUM 在开始前检查压力，VACUUM 排空活动后、真正重写数据库前再次检查；压力恶化时不执行也不误记当天成功。手动维护语义保持不变。
- **模式切换**：全局 metadata-only 是 hard-off，任何 key override 都不能绕过；切换 generation 后，已排队的 payload/Session 正文写入会被丢弃，脱敏 telemetry 仍保存。`part=meta` 不读取正文。

## 2026-07-31 · API key 单独覆盖请求内容存储模式（Key Store / Telemetry / Admin，docs/06/07/11，原则 2/7）

- **继承与优先级**：`api_keys.request_content_mode` 是 SQLite/PostgreSQL 的 nullable 枚举列；`NULL` 表示继承实时全局模式，`none` / `payload` / `session` 显式覆盖。历史 key 迁移后保持 `NULL`，不会因升级改变正文留存行为。
- **覆盖面**：鉴权身份把覆盖值传到 Chat、Messages、Responses（含 compact）、Gemini、Images、Interactions 与 Admin Replay，并复用同一个 capture helper；只替换本次请求的 capture getter，不冻结或修改全局设置。
- **保留边界**：`payload_retention_days` 仍是全局值，未增加 per-key retention。Admin Create/Edit/详情支持设置和清除覆盖；隐私提示与系统设置共用现有文案。

## 2026-07-31 · 保证 Session 捕获且删除累计字节上限（Telemetry / Session Store，docs/07/11，用户明确要求）

- **决定**：按用户要求删除单 Session 64 MiB 累计存储上限，不用更大的常量替代。共享 Session 捕获、SQLite 与 PostgreSQL adapter 都不再因 `stored_bytes` 拒绝新 revision 或响应回填；`stored_bytes` 只继续用于观测。现有 SQLite `INTEGER` 与 PostgreSQL `BIGINT` 均无需迁移。
- **Session ID**：当所有可信客户端标识都缺失或不可用时，以 `account_id + api_key_id + request_id` 派生一个只覆盖当前请求的 Session；这样保证正文落库，同时避免用内容或缓存亲和键把无关会话错误合并。`prompt_cache_key` 可能跨会话复用，因此不作为默认 Session 身份。
- **回滚兼容**：fallback 沿用旧版已接受的通用 `session-id` 持久化来源，不新增 DecisionRecord 枚举值；内部 ref 使用独立 `request_id` 哈希域，外部 ID 使用客户端不可占用的 `helm-request:` 保留前缀加请求哈希，避免与真实 `session-id` 的 ref 或数据库唯一键碰撞。v0.28.26 回滚后仍能读取新版写入的遥测记录。
- **边界**：单次请求/响应仍受进程动态 capture-body 内存预算保护，避免一个在途正文直接造成 OOM；10,000 revision 计数上限与既有 retention cleanup 保持不变。本次不补写已经漏掉的历史 revision，因为正文未保存时无法可靠恢复。生产必须切换到 `capture_sessions=true`、`capture_payloads=false` 才会使用该增量模式。

## 2026-07-31 · 请求列表记录并显示客户端正文大小（Telemetry / Admin requests，docs/07/11，原则 1/7）

- **计量口径**：新增可选 `request_body_bytes`，记录网关实际收到的客户端请求正文 UTF-8 字节数；不信任可能缺失或经过 transfer encoding 的 `Content-Length`，也不以字符数、Token 数、压缩后存储量或转换后的上游正文替代。该数字随脱敏 `DecisionRecord` 保存，不受正文捕获开关影响，不保存正文，因此无需 SQLite/Postgres 迁移。
- **协议边界**：共享记录路径覆盖 Responses、Messages、Gemini、Interactions 与 Images，OpenAI Chat 和 Admin Replay 的独立写入路径显式补齐；multipart 图片使用原始 wire bytes 覆盖其后生成的元数据 JSON 大小。尚不产生 `DecisionRecord` 的预路由拒绝、count-tokens 与 Realtime 请求不伪造该指标。
- **兼容与展示**：Admin 共享请求表按二进制阈值显示 `B / KB / MB`；旧记录不回填并显示 `—`，避免读取或扫描历史私密正文。

## 历史条目摘要（最新要点）

- **2026-07-29 · 生产韧性：持续小批清理 + 无丢弃背压 + 执行 Token 租约 + 完整错误诊断**：SQLite retention 每批≤10 行让出事件循环、Session prune claim 可续；写队列删除 OOM shedding 改统一串行 admission 背压 FIFO；OAuth 保存真实 `expires`、执行 client 6 分钟提前刷新、刷新失败重读共享 Store 只用他实例轮换出的有效 credential；Provider 错误有界诊断（64 KiB body / 128 KiB 总预算），完整原文通过 git history 回溯。
- **2026-07-28 · 删除 HTTP 与 WebSocket 请求大小上限**：删除应用与 Remote Nginx 固定正文上限，继续由动态内存准入、鉴权、schema、maintenance drain 和 provider timeout 保护运行时；完整原文通过 git history回溯。
- **2026-07-28 · preflight/registry 内存放大与自动 VACUUM 空闲门禁**：Responses preflight 增加 deadline/abort，catalog 与 registry 改为有界热路径；自动 VACUUM 仅在空闲 drain 后执行，完整原文通过 git history 回溯。
- **2026-07-25 · 上游过载（529/503）在 fetch 边界退避重试**：只在首字节前对 529/503 做两次有界退避，保留账号池、熔断、fallback 与终态 telemetry 语义；客户端断连立即停止，完整原文通过 git history 回溯。
- **2026-07-25 · Responses WebSocket terminal 立即释放并关闭失效连接**：成功终态立即释放请求与 ingress lease，失败终态关闭失效连接；Codex 增量续接保持 registry/provider/account/lane provenance 与 abort 边界，完整原文通过 git history 回溯。
- **2026-07-25 · 图片上游参数拒绝保持客户端 400**：ZenMux 的结构化 `invalid_params` 在共享边界转为 `invalid_request / 400`，provider 5xx、网络、限流与真实链耗尽语义不变，完整原文通过 git history回溯。
- **2026-07-24 · Codex Voice、Responses 音频与图片编辑补齐代理面**：Realtime V1/V2/V3、Responses 音频与 Images edits 复用既有鉴权、路由、账号和遥测链；Voice attestation 与单实例 call registry 保持收窄边界，完整原文通过 git history 回溯。
- **2026-07-24 · 请求准入增加实时 V8 堆高水位**：曾以 live heap + 分池余量拒绝高风险请求；后被 2026-07-27 的启发式拒绝拆除与 2026-07-28 的请求大小上限删除取代，完整原文通过 git history 回溯。
- **2026-07-24 · Admin 登录同源证明兼容代理 Host 改写**：登录/登出优先接受浏览器不可伪造的 `Sec-Fetch-Site: same-origin`，同时保留 Origin/Host 与 cross-site 拒绝边界；完整原文通过 git history 回溯。
- **2026-07-24 · Responses WebSocket ingress 改为按活动消息计费**：空闲连接不再预留完整帧容量，活动 `response.create` 才按真实 wire/JSON bytes 申请并释放 ingress lease；上游非 101 body 统一由有界响应超时接管，完整原文通过 git history 回溯。
- **2026-07-23 · PostgreSQL API-key 分布式并发 lease**：PostgreSQL 用 DB 时钟和 state-row lease 实现跨 replica 并发上限、心跳与 crash recovery，真实多 pool e2e 作为验收边界；完整原文通过 git history 回溯。
- **2026-07-23 · Session 恢复与在线响应共享内存池**：Admin Session 恢复单次最多占 response-work 池一半，保留在线响应容量并坚持先准入后物化；完整原文通过 git history 回溯。
- **2026-07-27 · 请求内存准入只计算未物化 headroom**：曾修 live-heap 双重计账误拒 503；后被同日“拆除启发式请求内存拒绝并保留硬边界”取代，完整原文通过 git history 回溯。
- **2026-07-23 · Codex Responses 按运行时容量准入并让夜间 SQLite 维护收缩内存（Gateway / Session / Store，docs/02/05/07/10，原则 2/3/7/8）**：机器推导的共享请求/响应/缓存预算、活动消息准入和维护 drain 保留正文捕获与自动维护能力；后续物化重复计账、WebSocket ingress 与 terminal 生命周期修正见顶部更新条目，完整原文通过 git history 回溯。
- **2026-07-23 · SQLite Session 与 Memory 正文使用兼容 gzip 存储（Store / Memory，docs/07/08，原则 1/3/7）**：SQLite 以 value type + gzip magic 兼容压缩 Session/Memory 正文，不回写历史数据、不在线 VACUUM，完整原文通过 git history 回溯。
- **2026-07-22 · 全项目文案审查补齐多语言维护闭环（Admin / Portal / Setup，docs/11/12，原则 1/2）**：以 Opus 只读审查和七语言结构测试补齐 Admin、Portal、Setup 文案维护闭环，完整原文通过 git history 回溯。
- **2026-07-22 · Session 恢复补齐响应快照并限制默认留存范围（Telemetry / Admin requests，docs/07/11，原则 1/3/7/8）**：复用 `session_revisions.response_json` 保存四种协议的成功非流式响应快照，流式不新增 SSE 缓冲；当时的 Session 64 MiB 累计上限已于 2026-07-31 按用户要求删除，来源仍恒为 `exact=false` 且 Retry 禁用，完整原文通过 git history 回溯。
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
