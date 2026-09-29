# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-09-29 · Claude Sonnet 5.5 模型接入（docs/04、05、07、10）

- **官方依据**：[模型](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)、[迁移](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide)、[价格](https://platform.claude.com/docs/en/about-claude/pricing)、[推理档位](https://platform.claude.com/docs/en/build-with-claude/effort)。1M 上下文、128K 输出，支持 low/medium/high/xhigh/max，默认 high；输入/输出每百万 token $2/$10，缓存读取/5 分钟写入/1 小时写入 $0.20/$2.50/$4，美国区域 ×1.1。不添加未公布的 Fast 价格。
- **配置与路由**：补齐能力、价格、OAuth 发现失败时的候选及转换路径模型提示；`claude-sonnet` 首选 5.5 并回退到 `balanced`；旧 Sonnet 5 请求随通配别名进入 5.5；活动 YAML 删除旧能力和价格键，保留数据库历史记录和独立历史计费测试。复用现有通配别名，不增加重复 provider。账号实时发现优先，静态目录不代表订阅授权。
- **兼容边界**：复用已配置的采样字段和旧 thinking 模式移除策略，enabled/disabled 被移除后采用上游默认 adaptive；不将 disabled 擅自改写为 between_tools。原生 between_tools、adaptive/display、签名历史和逐消息 effort 保留；between_tools 仅支持 low/medium/high，不能携带其他 thinking 字段或在会话中改变 effort。强制工具调用、旧 computer 工具及不支持的 advisor 组合交给上游拒绝，不静默降级工具语义；无新协议分支。
- **运维限制**：挂载配置须同步能力、价格及 lane，单独更新镜像不足以启用完整配置。自动化验收使用合成请求，不执行真实付费推理；发布后须核对运行时版本、目录和路由。

## 2026-09-28 · 原生透传取消模型准入名单，兼容规则归入配置（docs/04、05、10）

- **根因修复**：同协议 Anthropic 不再因 Sonnet、未知模型或 inline system/developer 进入整包转换。上游负责原生角色校验；原始缓存边界与 native 400 保留。显式开关、跨协议/continuation 校验和不可重放保护保留。
- **配置归一**：Anthropic 采样字段/旧 thinking 模式、OpenAI Chat token 字段/工具 reasoning 规则归入 `capabilities.yaml` 的 `requestCompatibility`，按路由 alias 解析并传至最终序列化。未配置即保留；非法字段 fail-closed。上下文上限复用 `maxContextTokens`，删除重复源码名单。
- **迁移边界**：自定义 alias 需自行声明经验证的兼容例外；挂载配置的部署需合并字段并重载，单独升级镜像不更新配置。模型目录/别名/价格仍按既有配置与同步流程维护，本次未宣称新增模型无需提供这些业务数据。

## 2026-09-28 · GPT lane 换代与线上配置回收（docs/04、11）

- **配置基线**：先读取用户指定的 Remote 当前配置，再合并默认配置；保留线上 Grok 4.6 及其他未要求修改的通道。GPT 模型 lane 按 Astra → Sol → Luna 排列，质量与任务 lane 沿用线上已切换的 GPT-6 主通道。
- **兼容决定**：删除 GPT-5.6、Sol/Terra/Luna 与 GPT-5.4/mini 独立 lane；旧客户端名称经别名分别进入 Astra/Sol/Luna，5.4-mini 进入 Luna，5.4 沿现有 gpt-5* 规则进入 premium。GPT-6 Sol 继承 Terra 的 balanced 兜底，避免普通档升级到 premium；历史能力与价格目录保留。
- **部署边界**：此次仅同步 lanes/model-aliases，保留其他线上配置；部署前校验源文件哈希、别名目标及旧 lane 的 key 限制，保留回滚副本，部署后核对管理 API 实际顺序与链路。

## 2026-09-28 · GPT-6 Sol / Luna 模型接入（docs/04、05、07、10）

- **路由决定**：新增 `gpt-6-sol` / `gpt-6-luna`、日期后缀和 `openai.` 兼容别名；沿用 Codex 订阅优先 → DeepSeek Responses → premium/economy 的链路，保持现有质量档默认模型。付费 `openai/*` 仅供显式指定。
- **官方依据**：[Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)、[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、[价格](https://developers.openai.com/api/docs/pricing)，核对日期 2026-09-28。API 上下文 1,050,000、最大输出 128,000；推理 none/low/medium/high/xhigh/max。Chat 工具调用复用现有 `reasoning_effort: none` 适配，输出上限用 `max_completion_tokens`；Responses 保留推理档位。
- **成本**：每百万 token 的输入/缓存读取/缓存写入/输出为 Sol $2/$0.20/$2.50/$10，Luna $0.10/$0.01/$0.125/$0.50。输入超过 272K 时整单输入及缓存 ×2、输出 ×1.5；Flex ×0.5，priority/fast ×2。订阅遥测沿用 API 等价价格，不表示订阅实际扣款。
- **订阅边界**：通过现有同步脚本更新至官方 Codex `rust-v0.157.1`，两款模型要求最低客户端 0.155.0；不手写或伪造 bundled metadata。Codex 账号的实时模型列表与上下文限制仍优先于 API 静态能力；新增目录不代表所有账号都已获授权。未执行真实付费调用或生产配置变更。

## 2026-09-27 · 原生辅助接口兼容性补修（docs/04、05、07）

- **重放边界**：真实连接拒绝与 DNS 解析失败可继续安全 fallback；发送结果不明、断管和响应正文失败仍禁止重放。
- **协议兼容**：Lite 恢复 function/custom 工具返回值中直接图片的 detail 清理，不递归改业务数据；Interactions 允许已实现的 `delivery: inline`，仍拒绝 `uri`。
- **计数路由**：按 registry alias 或唯一原生 provider 所属关系解析 wire model；未知、歧义、lane 和模型/lane/预算受限 key 均本地估算，避免绕过生成权限外发正文。明确禁用模型与上游请求/鉴权/权限错误仍拒绝；计数端点不支持（404/405）、限流和故障可估算。

## 2026-09-27 · 原生协议、缓存与重放边界修复（docs/04、05、07）

- **Claude**：更新已公布模型的 inline system 支持，删除默认日期改写，保留原生 thinking/context、缓存标记及未变化请求的 raw JSON；缓存超限交给上游拒绝，不静默裁剪。保留鉴权、路由、明确治理和有实际依据的兼容处理。
- **Responses**：保留原生 context_management 和标准 custom tools；xAI 订阅端显式声明不兼容。Codex shim 只匹配 Codex profile；指令只提升前导纯文本，密文只识别已知外来 UUID 形状，Lite 图片清理不递归修改工具数据。移除工具转换附带的图片重编码。
- **安全与成本**：Claude/Responses 按协议白名单转发头；只有 Codex 和显式 Helm relay 可转发 Codex 元数据。生成/compact 的发送结果不明或 HTTP 200 后正文失败均禁止自动换账户重发；非流式正文读取有超时。Gemini 媒体抓取复用 Node BlockList 验证映射 IPv6，DNS 失败或空结果拒绝，连接必须固定到已验证地址；保留 provider-managed Files 引用并记录实际变换。
- **辅助入口**：Responses 查询参数沿 registry 所属账户传递；计数接口保留确定性 4xx。Images→Gemini 不能表达的选项、Interactions 未支持字段/输入块、Realtime 多余 multipart 块在调用上游前拒绝；这修正了过去接受后静默忽略的行为，调用方须移除不支持字段或选择支持的原生接口。
- **保留的显式策略**：账户 installation ID 隔离、Codex 超大历史优化、可选 Memory/视觉压缩/XML 恢复仍有各自用途，不因“透传”取消安全与治理。passthrough_used 表示绕过 IR，不代表完全没有已记录的策略或传输适配。
- **验证边界**：三角色审查，核心/辅助接口先红后绿，mock 覆盖实际执行器、provider、OAuth 包装和原生 SSE；本机类型检查及定向测试不代表 CI、合并、部署或线上缓存改善。没有重放用户长会话或执行真实付费调用。私有请求审计只保留本地，不进入公共 PR。

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


## 更早历史总览

2026-09-25：Claude OAuth 手动重置额度，含组织/额度校验、二次确认、结果不明禁止重试与权威读回，详见 Git 历史。

2026-09-25：Replay 分块落盘、已接收请求防重放与响应内存边界，详见 Git 历史。

2026-09-24 · 流式累计内存与读取生命周期：累计预算覆盖协议/管理读取、完整终止语义及取消释放，保留原生 usage 与 key 隔离。完整记录见 git history。

2026-09-24 · Responses 内存准入与 Codex 恢复诊断：进程级并发上限默认关闭，保留 key 租约、公平排队、取消与预算边界，并增加无正文恢复诊断；生产启用须单独验收。完整记录见 git history。

2026-09-23 · Codex 整轮暂存与同账号恢复：可选缓冲整轮，严格限定同账号重放一次，保留取消/预算/容量和结果不明保护；上游可能重复计费，需独立线上验收。完整记录见 git history。

2026-09-23 · WebSocket 断线时保留已接收响应：先消费已到达的文本、工具和完成帧再报告断流；不自动重放已接收请求，保留容量和取消保护。完整记录见 git history。

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
