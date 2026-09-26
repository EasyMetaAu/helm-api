# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-09-26 · 订阅账号重新连接入口（Admin / OAuth）

- **决定**：账号显示 `needs reconnect` 状态时，在账号行 Actions 区显示 `Reconnect`；复用现有 OAuth 对话框并预选原 provider/account，打开后自动开始授权流程。重新连接的启动请求带 account 标识，网关从已保存的账号设置恢复 egress proxy，避免重新授权时意外绕过原代理。
- **边界**：保留既有手动粘贴和 device-code 流程、账号标签和完成后的 pool rebuild；普通 `Connect` 仍从空白表单开始。代理密钥不经过管理端，只在网关内从加密设置严格恢复；读取或解密失败则拒绝启动。Copilot 沿用已保存的 Enterprise 域名。重连固定原账号，取消后不再打开迟到的授权页。


## 2026-09-25 · Claude OAuth 手动重置额度（OAuth / Admin，研究契约）

- **决定**：新增独立的 `reset-grants` 管理端点，读取官方 Claude OAuth usage/profile，并在二次确认后发送一次 `cedar_ember` reset 请求；保留现有 Codex `/reset` 路径语义。
- **安全边界**：POST 前重新读取并校验同一组织、下一个 grant、额度计数、有效期、scope 与冷却；请求 ID 在发送前持久化。超时或读回不确定时保持 pending，禁止自动重试和重复消费。不会在测试或部署验收中点击真实重置。
- **按钮信息**：管理页预取每个 Anthropic 账户的只读 grant 状态，在按钮上显示剩余重置次数和过期日期；确认 POST 边界不变，成功读回后同步更新按钮。
- **交互边界**：Claude 重置确认框禁止点击遮罩或按 Escape 关闭，必须明确点击“取消”或二次确认；避免把一次性额度操作误触成直接消费。
- **读回限制**：只有 grant 计数减少且受影响 quota windows 读回恢复才报告 `reset`；已确认后逐个刷新已验证同组织别名并更新 quota store/cooldown。刷新失败仍返回已确认的上游结果，但 `quotaRefreshed=false`，需后续只读刷新。
- **读回校验**：仅对重置前可观测的 scope 要求恢复，nullable overage 不阻止确认；已观测窗口消失仍拒绝确认。部分重置复用既有 95% 活跃限额恢复判定，保留未清除周窗的 cooldown。同组织身份核实后即纳入刷新集合，暂时读取失败标记刷新不完整；结果不明时关闭确认框并提示可能已扣次数，需人工核查。
- **供应商差异**：Claude 的 early-use grant 不套 Codex 的 90% 阈值；未知 scope 不授权消费。上游接口若变化，管理端点 fail-closed，普通 Anthropic quota PULL 保持原 schema。

## 2026-09-25 · 内存复查：Replay 分块落盘与已接收请求防重放（Runtime / Provider / Store，docs/04、05、07、08）

- **修复**：generic Responses 已收到 HTTP 成功响应后遇到本机内存准入失败，沿用结果不明的禁止重放边界；保留原始容量错误，不惩罚 provider 熔断。MCP 与 Portal 请求体接入现有共享预算，没有新增正文大小、输出长度或批量数量上限。
- **Replay**：关闭 capture 时只留有界 usage 尾部；开启时 SQLite/Postgres 使用现有 codec 分块写入并等待存储，完整保留输出。SQLite v53 / Postgres v52 为增量迁移；旧行保持可读。新 writer 仅接受新的服务端 request_id，先保存请求，提交时发布 response generation；失败清理暂存分块，保留请求。FK 让暂存及正式分块跟随 payload retention 清理，包括进程崩溃后的未提交分块。
- **读取与边界**：管理界面按原下载契约流式读取分块，校验初始分块数和字节数；清理/替换导致缺块时终止流，不能把前缀当作完整正文。完整物化接口仍保留，管理路由先用大小元数据执行既有准入检查。自定义 Store 若未实现可选 streaming port，仍沿用原 insertPayload 行为；archive 的旧全量行契约没有在此变更。
- **引用释放**：Responses 有界 delta 前缀使用独立 UTF-16 副本；Memory stats 每次访问回收过期 scope，不增加条目上限。定向测试及 heap probe 验证引用释放；不能据此承诺任意负载下永不 OOM。数据库备份、完整 CI、确切 SHA 镜像和生产回读须分别验收。

## 2026-09-24 · 流式累计内存与读取生命周期（Runtime / 协议 / 可观测性，docs/02、05、07、08）

- **边界**：单帧 SSE 限制不能约束整轮累计状态。Responses 的完整终止输出、Gemini 的完整工具参数、协议工具索引及暂存参数，统一计入现有共享 response-work 准入；在追加前检查，在完成、异常和消费者取消时释放。Responses 超限输出结构化错误，不伪造 completed；Codex 保留发送后结果不明的恢复边界。
- **减少复制**：Anthropic 与 Responses 转译不再保存已转发的工具参数；有界文本读取逐块解码 UTF-8，不再保留所有二进制分块并拼接第二份完整字节数组。原生流的 usage 逐帧提取为计数器，保留已有计费语义。
- **生命周期**：客户端取消时主动终止请求体读取并释放 reader/租约。管理 API 与 Memory/eval 内部 HTTP 读取复用共享预算，预算覆盖 JSON 解析；超大可选 Memory 文本沿用既有 fail-open 丢弃策略，字节计数改为逐片累计。关键词正则缓存限制为 1024 项，避免多次配置热更新长期积累。
- **限制与验证**：JSON 路由校验、完整终止事件及显式开启的 Codex 整轮恢复仍需要有界暂存；不为降低内存删除这些契约。详见 `docs/memory-safety-audit-2026-09-24.md`。本条记录源码与本机验收边界；提交、CI、发布及生产回读须分别验证，不能将局部压力验证解释为任意负载下永不 OOM。

## 2026-09-24 · Responses 内存准入与 Codex 恢复诊断（Runtime / Provider，docs/04、05）

- **决定**：新增运行时 `global_concurrency_limit`（0 关闭，默认 0），并由现有 `concurrency_queue_enabled` 作为总开关；Remote 保持 0，只有运维明确在设置中启用后才生效。复用本地有界 FIFO semaphore 控制当前进程的执行并发。该上限独立于 per-key limit，共用 queue min-size 与 wait-timeout 设置；全局队列不访问分布式 key 租约表。先取得 key 租约，避免 key 等待者占用全局名额；全局等待失败会释放 key 租约。排队满或超时返回既有 429。
- **生命周期**：全局名额随真实请求/流结束释放，不使用会提前释放长请求的 watchdog。WebSocket 每轮经 Responses 路由取得名额，结束时释放。上限在线调整作用于之后的准入；既有排队者与持有者按原生命周期退出，不中断运行中的请求。
- **诊断**：记录 `codex_stream_recovery_eligible` 与无正文的 `codex_stream_recovery_skip_reason`，区分 disabled、HTTP、hosted tools、缺少历史、parent mismatch、unsupported input/event、capacity、不可重试 close/error 和 retry exhausted；保留 attempts/cost-unknown 字段。诊断失败不影响执行。
- **限制**：并发 cap 降低峰值但不保证单个大响应永不触发内存准入，既有内存保护仍生效；初始 4 是保守运维值，需结合线上等待/失败率调整。长回答在 buffered 模式下仍延迟首字；上游断线并非全部可安全重放。
- **验证**：定向回归覆盖进程/分布式隔离、key 等待公平性、取消释放、配置回读及恢复拒绝原因；发布须等待完整 CI 和确切 SHA 的 Publish，并回读 Remote 的版本、digest、配置与真实请求 telemetry。

## 2026-09-23 · Codex 整轮暂存与同账号断流恢复（Provider / 流式协议，docs/04、05，原则 8）

- **选择**：用户明确选择延迟首字来换取透明恢复；新增运行时开关 `codex_buffered_stream_recovery`，默认关闭，Remote 按本次授权开启。仅 Codex 原生 WebSocket 的合格请求暂存整轮，收到终止事件后按原序交付；不合成完成、不让失败尝试的文本或客户端工具调用泄漏。
- **恢复**：`store:false` 且只有客户端执行的 function/custom（含 namespace）工具时，接收阶段真实断线在原账号内部重建连接并最多重放一次。续轮仅使用同会话、同模型、完整的上一轮输入和输出快照，移除 `previous_response_id` 后重发完整历史；保留加密 reasoning，缺失时不猜测。明确 provider 错误、超时、取消、发送回调结果不明、内存溢出、未知事件/远端工具、无完整历史均不自动重放。
- **限制**：首字要等待整轮（含可能的重试），生成长回答时等待明显增加；上游失败尝试可能已消费额度，其用量不可得，记录 `codex_stream_recovery_cost_unknown` 与 `provider.stream_recovery`，不宣称零重复费用。客户端已断开后无法继续无感交付。buffered 模式不应用首字超时，仍保留总请求/attempt deadline、接收 idle timeout 和取消。
- **资源**：帧与快照复用共享响应内存租约；所有账号的快照总计最多占同一准入预算的四分之一，每账号最多 128 个会话。会话关闭、替换、淘汰释放快照，容量不足时不缓存/不恢复，不挤掉必要的输入校验。无持久化历史或数据库迁移。
- **验证**：失败尝试包含文本和工具调用的真实 ws 断线测试、实际 OAuth pool 同账号测试、续轮重建、重试上限、HTTP 降级禁入、解析/容量/超时/取消及 live 设置回归均先红后绿。真实上游另有 `codex.response.metadata` 与 `responsesapi.websocket_timing` 两种非输出事件，明确允许并保留；未知事件仍拒绝重放。发布验收还须完成线上同 socket 续轮和真实上游受控断流验证。

## 2026-09-23 · WebSocket 断线时保留已接收响应（Provider / 流式协议，docs/05，原则 8）

- **问题**：上游 close/error 回调清空待消费队列，包括已到达的 `response.completed`；慢消费者会把已完成请求误报为 `response_create_outcome_unknown`。真实网络断流与本地丢帧原先共用同一错误，线上历史记录无法区分二者。
- **处理**：传输断开只标记终止，消费者按顺序读完有界队列后才收到 EOF/error；显式关闭、取消和容量溢出仍释放所有待消费租约。完成帧正常交付，不合成成功、不重复创建推理。
- **恢复边界**：发送前安全重连与 HTTP 降级继续使用既有逻辑。Codex 使用 `store:false`，没有可依赖的 GET 取回契约，Remote 的只读接口探测也未成功（403），因此不新增取回轮询。真正丢失上游输出后，透明重放仍可能重复工具或计费，保留结果不明错误；本修复不能承诺所有网络断线都无感。
- **验证**：真实 ws connector 覆盖正常关闭、1006 reset、协议错误下的已收创建/文本/完成帧顺序，以及关闭后的租约释放；保持容量保护与安全重试回归。

## 2026-09-23 · 远端 Helm 建连重试与 WebSocket 降级（Provider / 协议透传，docs/04、05）

- **证据**：内网 Helm 到远端公网入口间歇出现 Undici `UND_ERR_CONNECT_TIMEOUT`，请求未建立 TCP 连接；共享 API key 尚未参与鉴权，不是该故障原因。此错误加入现有严格连接错误白名单，generic Responses 复用已有两次短退避重试。
- **WebSocket 边界**：首轮 `response.create` 发送前发生网络失败或非鉴权 upgrade 拒绝时，改走同一 Responses HTTP/SSE 请求。401/403/429、增量 `previous_response_id`、发送后结果不明仍原样失败，禁止自动重放。
- **部署限制**：请求总超时无法改变 Undici 独立的 10 秒 TCP 建连上限；生产内网节点应优先使用稳定的专网路径。代码重试只吸收专网短抖动，不掩盖鉴权、配额或确定性请求错误。
- **工具续轮边界**：真实 Codex 经远端 DeepSeek 回退后，`previous_response_id` 加单条 `function_call_output` 被误删为空输入。带有效非空 continuation ID 时保留工具结果，配对由上游已有响应校验；完整历史仍沿用孤立结果清理。generic HTTP 重试仅允许明确的建连超时，socket reset/pipe 错误不证明请求未发送。
- **错误终止边界**：真实链路的扁平 SSE `type:error` 在 WebSocket 出口补齐 Codex 所需的嵌套 `error` 和唯一 `status` 字段；复用共享错误状态映射，保留原 code、显式状态和恢复字段。Codex 0.154.0 将 `status_code` 声明为 `status` 的 serde 别名，两者同时出现会整条解析失败，因此自产错误与双字段旧节点事件移除 `status_code`；其余原生嵌套事件不改写，发送后结果不明禁止重放仍保持。

## 2026-09-23 · Claude Opus 5.5（模型目录 / 协议 / 计费，docs/04、05、07）

- **来源与范围**：[官方模型页](https://platform.claude.com/docs/en/models/opus-5-5/overview)、[迁移指南](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)和[价格表](https://platform.claude.com/docs/en/about-claude/pricing)，于 2026-09-23 核对。新增原生 `anthropic/claude-opus-5-5`，1M 上下文、128K 输出；Claude Opus 通道优先 5.5，保留旧模型回退。未证实 ZenMux 上架，因此不新增其别名。
- **兼容决定**：思考始终开启，沿用 `output_config.effort` 的五档控制；适配器统一移除旧版 enabled/disabled 思考配置及 sampling 字段，保留合法 adaptive/display 和签名历史。此模型不声明手动预算策略，以免通用策略删除合法 adaptive 配置。不会把强制工具请求偷偷改为 auto；上游确定性 400 继续按原契约返回。
- **上线前实测**：远端旧版客户端标识 2.1.278 被上游以 `claude_code_version_too_old` 拒绝，要求至少 2.1.280；通过现有 `pnpm sync:claude-cli` 更新生成文件。真实 Claude Code 客户端仍需自行升级，不伪造其传入版本。
- **计价与限制**：标准输入/输出 $4/$20 每百万 token；缓存读/5 分钟写/1 小时写 $0.20/$5/$8，fast 全部翻倍，US 区域系数 1.1。订阅显示的是 API 等价费用。旧 computer_20251124 不兼容、强制工具和 assistant prefill 不支持；原生工具集直接透传。签名历史须保持 append-only，跨模型回退不保证签名兼容；不改客户端历史来伪造兼容。新模型是否可用仍由账号发现/手动名单决定，发布时需核对挂载配置与在线账号。

## 2026-09-22 · Helm 上游通道转发（Provider / 协议透传，docs/04、05）

- **决定**：静态 `type: helm` 配合 `target_provider_protocol: openai_responses` 复用 Responses 客户端，明确允许 Codex 原生 items；不应用 DeepSeek 的请求改写。客户端仍使用已有模型别名，内网仅把 lane 转发到远端同名 lane。
- **媒体边界**：视频 lane 可指向显式 Helm provider，由远端履行 Grok 订阅鉴权；普通静态 OpenAI provider 仍不可调用该入口。本机 API key 鉴权、预算、一次创建与轮询所属 key 校验继续生效。
- **验证与限制**：原生请求、鉴权替换及 SSE 回归先红后绿；视频创建、轮询隔离与普通 provider 拒绝有定向集成测试。映射采用当前通道快照，远端调整通道内模型无需同步；新增或删除通道需重新同步。远端额度及可用性仍决定最终是否成功。

- **WebSocket 续接修复**：真实两轮验证中，直连远端成功，经过本地 Helm 第二轮因中继降为 HTTP 而丢失上游连接。显式 Helm Responses provider 使用现有有界 WebSocket connector，按可信 ingress session 保持一条远端连接；不透传内部会话证明，不改模型名、不删除 previous_response_id、不重建用户历史。下游关闭时释放连接，复用现有收包超时与内存租约处理。
- **恢复边界**：原连接缺失或远端明确未发送时保持 response_create_not_sent 恢复语义；发送后连接失败标记结果不明，禁止自动重放。普通 HTTP 与其他 generic Responses provider 保持原路由。需要真实同 socket 两轮 continuation 作为验收，普通 CLI 或 SSE 成功不足以覆盖此问题。
- **本次验收**：328 项定向测试、core/gateway 类型检查与构建通过；独立审查提出的握手 401/403/429 错误保真已补测试修复。`.12` 的 0.30.7 派生镜像部署后，同 socket 两轮均 response.completed、远端账号一致；Claude/Grok/Codex CLI 工具调用通过，测试 Key 全部删除。正式发布仍需通过完整 CI 与不可变镜像验收。

## 更早历史总览

2026-09-22 · E2E 的 main 与 PR 使用同一隔离 runner（CI / 部署，docs/10）：完整记录见 git history。


2026-09-22：Grok 4.7 与 Build Fast 配置沿用订阅能力边界，按官方标准和长上下文价格计费，历史型号保留。

2026-09-21：WebSocket 降级到 HTTP 后禁止发送无法恢复上下文的增量 continuation；完整记录见 git history.

2026-09-19—20：DeepSeek 工具图片保留结构并有界压缩，缺失 reasoning 历史时关闭思考；Admin Responses 重放保留原生 carrier。分类器 Jev 有序回退复用总超时与严格校验。完整记录见 git history。

2026-09-18 Codex 短冷却在原账号等待，长冷却原样返回，禁止换账号和误触发重连；完整记录见 git history。

2026-09-18 OAuth 退出与刷新共锁，撤销缓存凭证并同步禁用 live pool，避免删除后刷新写回；完整记录见 git history。

2026-09-18 Grok 版本化 chat 别名进入稳定 lane，Imagine/video 按最长字面量区分；完整记录见 git history。

2026-09-18 DeepSeek 回放为缺少 call_id 的 function_call_output 使用非空 id，已有值保留；完整记录见 git history。

2026-09-18 Lite 将 DeepSeek 外源 reasoning 明文折入空 summary 并清空 content，已有 summary 和 OpenAI 密文不改；完整记录见 git history。

2026-09-18 Codex 回放前剥掉非 `gAAAAA` 外源 encrypted_content，保留可读正文，空项丢弃；完整记录见 git history。

2026-09-18 取消 Responses 默认首帧 15s 超时，保留 in-band 错误 fallback 与结果不明禁止重放；完整记录见 Git history。

2026-09-17 的外源 reasoning 缺明文时关闭 DeepSeek 思考、首字节超时、Lite reasoning、候选链解释、DSML 工具兼容、DeepSeek Responses、观测字段等记录已压缩，完整原文可从本次变更之前的 Git 历史回溯。

2026-09-06：Codex 模型发现使用上游 client_version 和可选 base_instructions；订阅模型自动/手动列表统一依据官方目录与数据库权威，完整记录见 Git history。

2026-09-05 Fable 5.1 目录/价格、2026-09-02 HTTP 结果不明禁止重放（保留明确拒绝的有界重试）、2026-09-01 超大历史发送前保护已并入历史；完整内容见基线 `8a7df80c6684b10bfa7ff7f4f07f237a92f95d58`。2026-08-30 及更早工作涵盖订阅图片/视频/TTS 的 entitlement、单写与价格边界，Responses HTTP/WebSocket 生命周期、发送前恢复证明、账号与 transport 亲和、超大历史与压缩，OAuth 模型发现、额度窗口、Retry-After、冷却、轮转和缓存，协议互译与 SSE/tool-call 保真、能力/价格目录、路由/分类/fallback/熔断，Memory observe/inject/反思/压缩/保留与并发治理，payload/session 分段持久化、失败记录、SQLite/Postgres 数据完整性与资源保护，Admin/Portal/i18n/可访问性、key 权限/预算/计量，以及构建、CI、Docker、发布和生产验收。具体默认值、兼容限制与历史实测均以对应提交为准；本次压缩前的完整条目可从基线 412c7cde02288d9b33d54a87f93b43925177b294 的本文件及 Git 历史回溯。

2026-09-21（docs/05、06、07）：Jev Decisions 独立协议面保留权限与请求数原子预留，强制无正文审计，采用 32 KB 请求、256 KB 响应与 30 秒上游边界。完整记录见 Git 历史。
