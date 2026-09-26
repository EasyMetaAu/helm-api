# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-09-26 · Admin UI 走查整改 + 首次安装 key 验证修复（docs/11、12；方案见 docs/ui-audit-2026-09-26.md）

- **安装向导 key 验证（用户反馈"DeepSeek key 一直验证不过"，确认为 bug）**：`testStaticProviderKey` 过去只要非 2xx 就判失败，而 DeepSeek 对**余额为 0 的有效 key** 返回 402，向导又要求测试通过才允许完成，结果有效 key 根本存不进去；错误信息只有 `upstream returned 402`。现改为：401/403 等才判无效；402/429 视为"key 已通过鉴权"，放行并返回 warning；错误与警告都带上脱敏后的上游 `error.message`；服务端与页面都会 trim 粘贴的 key；探测模型跳过图像/视频/TTS/embedding 类（ZenMux 的 `models[0]` 曾是 `gpt-image-2`）；修复错误显示成 `[object Object]` 的问题。未做：代理环境（`HTTPS_PROXY`）下的出站连接，egress 仍是直连 undici Agent。
- **布局策略**：所有页面铺满窗口，不设最大宽度（用户拍板：限宽在全屏外接显示器上显得局促、偏在一边，不好看），统一用 `.page` 外壳，并有测试禁止页面容器加 `max-w-`/`mx-auto`。笔记本屏的可读性靠合并列与折叠次要信息来保证，而不是限宽。侧栏去掉会被截断的副标题（改为 hover title），顶栏不再重复页面标题。验收标准：1440×812 下主表格不出现横向滚动。
- **表格收敛而不删字段**：Requests 12→8 列（Session 并到 Key 下、Serving 并到 Model 下、请求体大小并到 Performance、Request ID 挪到时间链接的 title）；Keys 只显示非默认的限额（全是默认值时显示灰色 "Defaults"），Rotate/Revoke/查看完整 key 收进原生 `<details>` 做的 `⋯` 菜单；Providers 11→7 列（优先级/可调度/Fast/过期时间合并为一个 Scheduling 列）。三张表在 1440 下所需宽度从 1966/1869/1653px 降到 ≤1150px。`cell-request-body`、`request-detail-link` 等 testid 保持不变（e2e 依赖）。
- **长配置页**：Lanes 卡片默认折叠为一行摘要（主模型 → +N fallback · 推理强度），页面高度从约 15.5k px 降到约 2k px；校验失败的 lane 会自动展开，避免错误被藏起来。e2e 的 lane 编辑用例先展开卡片再填写。Policies 用一句话概括每条规则；Settings 增加吸顶的分区跳转导航，两个同名的 "Queue wait timeout (ms)" 分别改为 Key/Account 排队超时。
- **修复**：`requests/[traceId]/+page.ts` 导出了 `safeBackTo`，SvelteKit 开发模式的路由校验会拒绝这种非标准导出，导致 `vite dev` 下请求详情 500（生产构建不做这项检查）。函数移到 `$lib/nav.ts`，并加测试固定路由模块只能导出合法名字。
- **验证方式**：本机起 admin/portal 开发服务器，只读代理到线上（非 GET 一律本地 403），在 1440 和 2560 两种视口下截图逐页走查；admin 单测 834/834，svelte-check 0 错误，admin e2e 14/14（真实 gateway + adapter-static 构建）。
- **TODO（后续 PR）**：方案文档第 6 期"配置 UI 化"——把运行时调优类配置（超时、memory worker、signal feedback 等）并入 DB runtime settings；providers/model-aliases/pricing/capabilities 走 YAML 回写并做跨文件引用校验；引导与密钥类配置在 UI 上只读展示。

## 2026-09-26 · Self-Service Portal UI 审计整改（docs/12）

- **背景**：对 portal（key 持有者自助门户）做了一轮 UI/信息密度审计，修复 6 项：Overview 增加「按模型」表格与≥7d 的「每日用量」表；Requests 列表改为 ↑input/↓output+cached 分列显示、延迟按秒显示；请求详情页补齐请求时间、requested vs served model、reasoning effort、TTFT/TPS/生成耗时、fallback 尝试；Account 页三张卡片在宽屏并排（页面铺满、卡内两列 `<dl>`，标签与值不会被拉开）+ 用量/限额进度条；内容不限宽（见上一条），顶部导航直接放 LocaleSwitcher、新增 Account 导航项。
- **fallback 尝试展示边界（R7，docs/12 §8）**：详情页新增「Fallback attempts」区块，逐条只显示 outcome（success/timeout/rate_limited/circuit_open/skipped/error）+ latency_ms，**绝不**显示 provider、内部 alias 或 wire model——这些是供应链细节（CLAUDE.md 原则 6），且 `toPortalDecisionView` 的白名单投影本就没有透出这些字段。测试 `request-detail-parity.test.ts` 用 `not.toContain("attempt.provider")` / `not.toContain("attempt.alias")` 固化这条边界，防止未来有人为了"更详细"而误加。
- **删除 CostBreakdown.svelte（偏离字面任务措辞的决定）**：原任务描述是"修复 Cost 卡片，隐藏空行"，但检查 `CostBreakdownSchema`（`packages/shared/src/decision/schema.ts`）后发现 `routing_usd`/`eval_usd` 对 portal key holder 永远是 null（后端从不为 portal 填充这两项），补丁式"隐藏空行"只会剩一个多余的容器包着一个数字。按 CLAUDE.md「优先复用/删除过时路径而非加兼容层」的原则，直接删除该组件，详情页改为渲染 `detail.cost_usd` 单一 Total。测试同步固化为 `not.toContain("CostBreakdown")` + `cost-total` testid。
- **Overview 「按模型」表 / 「每日用量」表未引入新字段**：两者都复用既有 `GET /portal/api/usage/stats` 返回的 `by_model` 和 `series`（未新增/修改后端 schema），因此未新增安全边界测试——现有的 key 隔离测试（`apps/gateway/src/routes/portal/index.test.ts` 的 R5 write-force 断言）已覆盖这条数据源。
- **可视化走查发现并修复的布局坑**：Overview 页最初把「按模型」表放进了甜甜圈图所在的 `lg:col-span-1` 卡片（3 栏网格的 1/3 宽）——5 列（Model/Requests/Tokens/Cost/Share）在该宽度下右侧 Cost/Share 列被裁切。修复：表格移出，改为图表网格下方独立的 `lg:col-span-3` 全宽 `<section class="card mt-4">`（与「每日用量」表同一模式），甜甜圈卡片只保留图 + 精简色块图例。用真实生产数据（只读代理到 helm.easymeta.au）截图两种尺寸（1440×812、2560×1440）验证修复前后对比确认。
- **真实生产 box 验证发现请求详情页会报错（非回归，是预期的"字段未上线"场景）→ 已补防御**：本次给 `PortalDecisionView` 新增的 `attempts`/`tps`/`ttfb_ms`/`requested_reasoning_effort`/`reasoning_effort` 字段还没有部署到生产 box，代理到真实数据时旧响应缺这些字段（JSON.parse 后是 `undefined` 而非 `null`），`detail.attempts.length` 会触发 `Cannot read properties of undefined`。这不是代码 bug，但客户端理应对"字段未部署"宽容降级：新增 `apps/portal/src/lib/request-detail-normalize.ts`（`normalizePortalDetail`），在 `load()` 拿到响应后立即把缺失的 `attempts`→`[]`、`tps`/`ttfb_ms`/`generation_ms`→`null`，页面模板其余逻辑不用改。单测 `request-detail-normalize.test.ts` 覆盖"字段齐全原样透传"与"字段缺失时按各自类型的哨兵值归一化"两种情况；`request-detail-parity.test.ts` 新增一条固化调用点存在。原先 TODO 已解决。
- **可视化走查已完成**：真实生产数据 Playwright 走查全部完成（12 张 + 1 张 mock 截图），Overview/Requests/Connect/Memory/Account 五个页面在两种视口下逐一审阅，无遗留视觉问题；定向 vitest 57/57、`svelte-check` 0 错误 0 警告、i18n 对齐 12/12。

## 2026-09-26 · DeepSeek 兜底与 Responses 请求变更可观测性（Provider fallback，docs/04、07）

- **决定**：保留 DeepSeek 对 opaque reasoning history 的 `effort: none` 降级，并让 request-contract 生成的 body mutation ledger 回写到执行器持有的 carrier。这样首选上游 429 后，DeepSeek 的候选尝试既可成功，也能在管理记录中显示实际应用的降级。
- **验证与限制**：新增执行器回归覆盖 429 → DeepSeek fallback 成功与拒绝；保留真实 400 详情。原 trace 的历史已在现行部署做限输出回放，未复现 reasoning 400，但没有该失败尝试的完整出站正文，不能据此宣称原始拒绝已修复。此改动只修复诊断缺失。


## 2026-09-26 · 订阅账号重新连接入口（Admin / OAuth）

- **决定**：账号显示 `needs reconnect` 状态时，在账号行 Actions 区显示 `Reconnect`；复用现有 OAuth 对话框并预选原 provider/account，打开后自动开始授权流程。重新连接的启动请求带 account 标识，网关从已保存的账号设置恢复 egress proxy，避免重新授权时意外绕过原代理。
- **边界**：保留既有手动粘贴和 device-code 流程、账号标签和完成后的 pool rebuild；普通 `Connect` 仍从空白表单开始。代理密钥不经过管理端，只在网关内从加密设置严格恢复；读取或解密失败则拒绝启动。Copilot 沿用已保存的 Enterprise 域名。重连在服务端 session 固定原账号，完成或轮询时拒绝账号不匹配；原标签保留空白，不隐式改名。取消后不再打开迟到的授权页。


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

## 更早历史总览

2026-09-23 · 远端 Helm 建连重试与 WebSocket 降级：`UND_ERR_CONNECT_TIMEOUT` 加入严格连接错误白名单并复用两次短退避；首轮发送前 WebSocket 失败改走 HTTP/SSE（401/403/429、增量续接、发送后结果不明不重放）；保留带 continuation ID 的单条 `function_call_output`；自产错误移除与 `status` 冲突的 `status_code`。完整记录见 git history。

2026-09-23 · Claude Opus 5.5：新增原生 `anthropic/claude-opus-5-5`（1M 上下文/128K 输出），思考默认开启走 `output_config.effort` 五档；标准 $4/$20 每百万 token；旧 computer_20251124/强制工具/assistant prefill 不支持。完整记录见 git history。

2026-09-22 · Helm 上游通道转发：静态 `type: helm` + `target_provider_protocol: openai_responses` 复用 Responses 客户端并支持 WebSocket 续接；视频 lane 需显式 Helm provider；328 项定向测试通过，0.30.7 派生镜像验收。完整记录见 git history。

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
