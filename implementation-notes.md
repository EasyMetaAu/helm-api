# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-09-24 · Responses 内存准入与 Codex 恢复诊断（Runtime / Provider，docs/04、05）

- **决定**：在 gateway 入口增加固定的进程级并发上限 4，并复用现有有界 FIFO semaphore；它独立于 per-key `concurrency_limit`，因此没有配置 per-key 上限的 key 也受保护。队列满或等待超时继续返回既有 429，数据库租约不可用继续 fail-closed。该上限按 Remote 1.5 GiB 容器的当前观测值保守设定，后续只有在测得足够 headroom 后才提高。
- **诊断**：Codex buffered recovery 的 eligibility 失败不再静默；passthrough mutation 记录 `codex_stream_recovery_eligible` 与 `codex_stream_recovery_skip_reason`，并保留现有 attempts/cost-unknown 字段。skip reason 只记录无正文的原因（例如 hosted tools、previous response mismatch、unsupported input、capacity exhausted）。
- **限制**：进程级 cap 是单一固定值，不是按实时 RSS 自动调节；它先控制并发峰值，单个响应仍受现有 response-work admission 保护。提升上限前必须有新的生产内存证据和定向压测。
- **验证**：新增 global-cap 与 recovery skip reason 定向测试；发布前仍需完整 CI、不可变镜像核对，以及 Remote `/version`、`/healthz`、配置和 telemetry 回读。

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


## 2026-09-22 · E2E 的 main 与 PR 使用同一隔离 runner（CI / 部署，docs/10）

- **证据**：Grok 4.7 的 PR 全绿；相同合并提交在共享 runner 上三次执行，第一次 100 项通过但 Chromium 下载重试耗尽 job 时间，后两次分别为五秒并发队列和固定等待 1.5 秒的记忆 worker 测试失败，其余 99 项通过。不是稳定复现的 Grok 配置失败。
- **决定**：main E2E 与 PR 一样使用独立 ubuntu-24.04 runner，沿用 verify/store 的隔离做法。保留原有 100 项断言、十分钟 job 上限、真实 PostgreSQL、浏览器安装、只读权限和完整发布门禁，不增加重试或放宽超时。版本仍为尚未发布的 0.30.7。

## 2026-09-22 · Grok 4.7 与 Build Fast 配置（Config / 路由 / 计费，docs/04、07）

- **来源**：[官方模型页](https://docs.x.ai/developers/models/grok-4.7)、[官方价格页](https://docs.x.ai/developers/pricing)及已认证的 Grok CLI 目录。两个型号均为 500K 上下文，支持 low/medium/high/xhigh；沿用订阅通道的工具、图片和流式能力，未知输出上限保留 null。公共 API 的结构化输出声明不代表订阅代理已验证，JSON 能力继续关闭。
- **价格**：每百万 token 的输入/输出/缓存读取，标准版为 $2/$6/$0.5，超过 200,000 prompt tokens 为 $4/$12/$1；priority 按官方 2 倍计。Build Fast 为 $4/$12/$1，长上下文为 $6/$18/$1.5，不能套用标准版 priority 的长上下文价格。订阅仍按 API 等价估算计入遥测与 key 预算，不是 SuperGrok 订阅账单。
- **通道与边界**：稳定 grok 主模型从 4.6 切到 4.7，所有引用它的 fallback 链随之升级；新增 grok-fast，并把 grok-*-build-fast 别名导向该通道。旧型号能力与价格保留，媒体通道不变。不添加未公开定价的 Fast priority 档，不为当前订阅代理启用美国区域 API 费率。

## 2026-09-21 · HTTP 降级后禁止发送增量 continuation（Provider / WebSocket，docs/05）

- **证据**：`223a933e-f396-4556-98d9-18523b0aa3c6` 与前一成功请求绑定同一 Codex 账号，HTTP 上游却拒绝 `previous_response_id`。旧分支让 HTTP fallback 会话绕过 WebSocket continuation guard，现有测试还错误假设 HTTP 能接受该参数。
- **修复**：HTTP fallback 中的增量 continuation 在发送前走已有 `response_create_not_sent` 恢复协议。可信 WebSocket 桥发送 1012，客户端重连补全历史；完整历史仍可 HTTP fallback。原账号绑定、结果不明时禁止重放、鉴权与恢复证明校验保持原样。
- **边界**：不能拿旧账号的 response ID 盲轮转；自动恢复依赖客户端重连并重发完整历史。没有保存完整历史时不伪造上下文。无需配置或数据库迁移。

## 2026-09-21 · 外部 Jev Decisions 与强制无正文审计（Provider / Auth / Telemetry，docs/05、06、07）

- **接口**：新增 `POST /v1/decisions`，复用 Jev transport 与服务端 OpenRouter 凭证；接受 noul／choice／score，严格校验完整分布、实际模型和有限用量。业务模板留在调用方，无聊天回退或自动重试。契约与示例见 `docs/integrations/jev-decisions.zh-CN.md`。
- **权限与计费**：要求 allow_custom_model；有模型封禁规则时必须日期固定版本。缺失用量／费用为 null；token／金额硬额度 key 拒绝。请求次数在现有 SQLite／Postgres budget 表原子预留，失败或结果不明仍计尝试；其他入口保留既有事后结算语义，无迁移。
- **隐私与资源**：直接写无正文 telemetry，绕过通用 recordServed 的失败强制捕获，禁止该接口任何 payload／session 留存。正文上限 32,000 字节、响应 256,000 字节、上游最多 30 秒；共享有界读取器增加可选取消信号以释放慢上传资源。此保证不覆盖 OpenRouter／TypeSafe 或调用方自身留存。
- **交付边界**：本地 mock 和临时数据库验证不等于上游真实付费调用或生产验收；无凭证／费用授权未执行真实 smoke，未提交或部署。

## 历史条目摘要（最新要点）

- **2026-09-21 · Codex 工具历史 namespace（Provider，docs/05）**：只按已声明工具规范化 `namespace::name`，冲突/未声明不猜测；完整记录见 git history。

## 更早历史总览

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
