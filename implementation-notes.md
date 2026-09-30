# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-09-30 · Codex 连通性测试复用账号运行配置（docs/05、11）

- **根因**：管理测试只传账号凭证，遗漏 Codex 运行配置，导致客户端版本回退为 `0.0.0`，同时失去账号目录的模型参数与持久身份；正常路由已正确加载这些配置。
- **修复**：共享账号客户端构建器复用现有的账号目录加载逻辑；测试沿用运行时客户端版本、代理、模型元数据与账号身份，仍固定指定账号，不进入模型回退或写入请求遥测。
- **验收边界**：真实管理端点的合成回归覆盖默认版本、自定义版本、账号身份及 Responses Lite；目录不代表账号已获上游授权，真实上游拒绝仍原样展示。

## 2026-09-30 · Codex 账号详情只展示周额度周期（docs/11）

- **决定**：详情页复用已有的 Codex 账号周额度选择器，按实际时长识别周窗口，不再把 `primary` 固定当作周限；当前用量、历史、已用比例与倒计时统一使用周窗口，隐藏 5h 周期切换。
- **边界**：仅调整 Codex 详情展示，保留原始周期记录、API、5h 路由限额及按日/自然周汇总。没有可识别周窗口时不以 5h 冒充周额度；其他 provider 维持原行为。

## 2026-09-30 · GPT-6.1 Sol 接入与 Sol 配置迁移（docs/04、05、07、10）

- **官方依据**：[模型](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[价格](https://developers.openai.com/api/docs/pricing)、[Codex](https://developers.openai.com/codex/models)。API 上下文 1,050,000、最大输入 922,000、输出 128,000；推理 low/medium/high/xhigh/max，API 默认 medium，不支持 none/minimal。当前 catalog 没有独立输入上限字段，由上游继续校验 922K 输入限制。
- **协议与路由**：Sol lane 升级为 `gpt-6.1-sol`，balanced/json/vision 及旧 Sol/Terra 别名同步迁移；Codex 优先与既有 fallback 不变。工具调用必须走 Responses，付费 `openai/gpt-6.1-sol` 复用独立的 generic Responses provider；不继承旧 Sol Chat 工具的 `none` 规则。旧模型能力/价格保留历史兼容，旧原生 Chat 示例不代表 6.1 支持。
- **价格**：每百万 token 输入/缓存读取/缓存写入/输出 $2/$0.10/$2.50/$10；超过 272K 输入时整单输入和缓存 ×2、输出 ×1.5；Flex ×0.5、Fast/priority ×2、US/EU ×1.1。复用现有计价字段；未新增 Batch 执行能力或 Ultrafast 档位。EU 不支持 Fast；区域端点选择和该组合限制仍由部署配置及上游执行。
- **订阅目录**：使用官方同步脚本更新至 Codex `rust-v0.159.2`，bundle SHA256 `e0c1feb6be3e5d7f079b594a64255f4e8e6a97fba8cc5970e9b82abecf7d4b3c`。6.1 bundled 默认上下文 272K、最大 872K、默认推理 low、最低客户端 0.153.0；静态 Codex 能力采用默认 272K，实时账号目录优先。bundle 中的 ultra 属于编排，不作为 API effort；目录不代表账号授权。
- **迁移边界**：挂载部署需同步 lanes/model-aliases/providers/capabilities/pricing 五个 YAML；`allowed_lanes` 中显式列出旧 `gpt-6-sol` 的 key 需迁移到新 lane，别名不会绕过权限限制。Relay 的模型/lane 引用也须同步。此次仅修改仓库并以 mock 验证，未执行真实付费推理或生产变更。

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

## 更早历史总览

2026-09-26：Portal 用量、请求详情与布局审计，复用 key 隔离数据源，缺失字段兼容及真实页面验证；完整记录见 git history。

2026-09-26：DeepSeek fallback 保留 opaque reasoning 降级，request-contract mutation ledger 回写执行器；未据此宣称历史上游 400 已修复。完整记录见 git history。

2026-09-26：订阅重连复用 OAuth 流程及原账号代理、标签，解密和账号匹配失败时拒绝，详见 Git 历史。

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
