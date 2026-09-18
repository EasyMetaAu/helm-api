# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-09-18 · Codex 短冷却等原账号，长冷却原样回错误（Provider / OAuth 池，docs/04，原则 3/5）

- **现象**：`90aa083d` 带 `x-codex-turn-state`，原账号短暂停用约 28s。Helm 立刻抛 `response_create_not_sent`，WebSocket 桥还可能把它改成 1012。Codex 不读 `recovery.retry_after_ms`，12s 连打 6 次。
- **修复**：≤60s 的 sticky 冷却在原请求上等到点，再打原来的 Codex 账号；不换号、不换 DeepSeek。超过 60s 立刻失败，错误码/文案/`recovery`（含 `reason` 与 `retry_after_ms`）原样给客户端。长冷却不再改成 1012。客户端断连仍不算 provider 故障。
- **不改**：lane rung；不把错误改成假的 `rate_limit_exceeded`。

## 2026-09-18 · DeepSeek 丢掉无配对的 function_call_output（Provider / 协议互译，docs/05，原则 3/8）

- **现象**：`776fa8e7` 先打 `gpt-5.6-sol` 上游过载，落到 `deepseek-flash` 后 400：`No tool call found for tool output with call_id fco_01a0a7f2-…`。历史第 7 项是 Codex `automation_update` / `codex_app` 的 `function_call_output`，有 `id` 无 `call_id`，也没有对应的 `function_call`。v0.29.27 用 `id` 填 `call_id` 后，DeepSeek 仍要配对的 call。
- **修复**：`deepseek-responses` 增加 opt-in `dropUnpairedFunctionCallOutputs`，在填 `call_id` 之后丢掉没有 sibling `function_call`/`custom_tool_call` 的 output。配对的工具结果不动。不发明 call，不改 rung。第一条候选的 Codex 过载仍是上游故障。

## 2026-09-18 · 断开 OAuth 账号撤销缓存凭证并阻止刷新写回（Auth / Provider，docs/06、04、05）

- **已复现**：后台断开只删 Store 行，旧 token manager 仍能返回缓存 access token；并发刷新完成后会重新 upsert 该行。pool 重建失败时旧成员也仍可选择。另有流式已输出后出现确定性鉴权失败却未禁用账号的缺口。
- **修复**：删除与刷新复用同一 store/account 锁，删除成功后撤销旧 manager 的内存凭证使用权；管理端同步禁用 live pool 成员并丢弃复用缓存，不依赖后续重建成功。重新登录创建新 manager，旧 manager 永不复活，其断开错误也不会把新登录标为凭证失效。流式已提交后只禁用确定性失效账号并上抛原错误，禁止重放。
- **边界**：锁与缓存失效作用于同一网关进程共享的 Store；不承诺跨进程直接删库的一致性，也不撤回已经发送的上游请求。退出会等待已经开始的刷新完成后再删除；删除提交是退出生效点，重新登录的保证从退出完成后开始。删除失败不撤销现有凭证。普通 403、限流、5xx 与客户端断连不因此永久禁用。
- **证据范围**：回归测试先红后绿；这些代码缺陷已证实，但不能据此断言它们造成了本次截图中另一个账号的 429 冷却。尚未部署。

## 2026-09-18 · 补 grok 兼容别名：版本化 chat id 进 grok lane，Imagine/video 不抢（Config / 路由，docs/04，原则 6）

- **现象**：`bbcd8800` 自定义模型 key 发 `grok-4.6`，400 `unknown model or lane "grok-4.6"`。`grok` lane 已有（primary `xai/grok-4.6`），但 `model-aliases.yaml` 没有 grok glob，版本化 id 既不是 lane 名也不是 provider alias。
- **修复**：`grok-imagine-image*` → `grok-imagine-image-quality`；`grok-imagine-video-1.5*` → `grok-imagine-video-1.5-preview`（grok-build 当前 wire id，兼容 preview 后缀）；`grok-imagine-video*` → 纯文本/续写 lane；最后 `grok*` → `grok`。最长字面量优先。不把 1.5-preview 并进无版本 `grok-imagine-video`（那是另一份合同）。不钉 chat 版本，不改 rung。

## 2026-09-18 · DeepSeek 回放前补上缺的 function_call_output.call_id（Provider / 协议互译，docs/05，原则 3/8）

- **现象**：`28bacfd4` 先打 `gpt-5.6-sol` 上游 `server_error`，落到 `deepseek-flash` 后 400：`missing field call_id`。历史第 31 项是 Codex desktop 心跳 `function_call_output`（`name: automation_update`, `namespace: codex_app`），有 `id` 无 `call_id`。OpenAI 收；DeepSeek 反序列化更严。
- **修复**：`deepseek-responses` 增加 opt-in `fillMissingFunctionCallOutputCallId`。缺 `call_id` 时用非空 `id` 补上，已有 `call_id` 不动。不发明新 id，不改 rung。第一条候选的 OpenAI 5xx 是上游故障，不是这次 shape 问题。

## 2026-09-18 · Lite 把 DeepSeek 明文折进 summary，content 必须空（Provider / 协议互译，docs/05，原则 3/8）

- **现象**：v0.29.25 剥掉 `d8b7…8a-0` 后，同会话 `ffc6d4d6` 仍 400：`Invalid 'input[483].content': array too long. Expected … 0, but got … 1`（`array_above_max_length`）。mutation 已有 `foreign_encrypted_content_stripped`，失败项仍带着 DeepSeek 的 `reasoning_text`。Lite 不允许 reasoning `content` 非空；OpenAI 自己的项 `content` 是 `null`，明文只在 `summary`（`summary_text`）。
- **修复**：剥外源密文后，把 leftover `reasoning_text` 折进空的 `summary`，再把 `content` 清成 `[]`。已有 `summary` 不覆盖。Lite canonicalizer 对无 `gAAAAA` 的 reasoning 走同一折法；OpenAI blob 仍只清 content、不动 summary。不发明明文，不改 rung。

## 2026-09-18 · Codex 回放前剥掉外源 encrypted_content（Provider / 协议互译，docs/05，原则 3/8）

- **现象**：DeepSeek 成功后再打 `openai-codex/gpt-6-astra`，上游 400 `invalid_encrypted_content`。生产 `a8b37bb9`：历史 107 条 reasoning 里 106 条是 OpenAI 的 `gAAAAA…`，恰好 1 条是 DeepSeek 的 `d8b79690-…-0`，并带明文 `reasoning_text`。OpenAI 解不开别家密文。
- **修复**：Codex 发送前（`sanitizeCodexResponsesNativeBody` + Lite canonicalizer）删掉**不以 `gAAAAA` 开头**的 `encrypted_content`，保留明文 `content` / `summary`。没有明文的外源 reasoning item 整条丢掉。OpenAI 自己的 blob 不动。不发明明文，不改 rung。
- **为何只认 `gAAAAA`**：那是 OpenAI Fernet 密文的稳定前缀；DeepSeek 回的是 UUID 形。Lite 旧规则是「有密文就清空明文」——对这条 DeepSeek 项会把唯一可读的思考清掉、把外源密文留下，正好把 400 钉死，所以剥密文必须在那条规则之前。

## 2026-09-18 · 取消 Responses 首帧 15s 超时（Provider execution，docs/04/05，原则 5/8）

- **现象**：v0.29.23 上线后，真实 Codex 请求在 `response.created` 之后、第一帧真实输出之前被切掉。Admin 显示「错误 15s 通道不可用」，`response_create_outcome_unknown` / `after_response_created_before_output`。15s 对思考或工具准备过短。
- **修复**：执行层不再默认 `firstOutputTimeoutMs: 15_000`。生产路径不设这个上限；测试缝仍可显式传入（单测用 40ms）。`guardPreOutputFailure` 本身的 deadline 能力保留，省略或 ≤0 即关闭，与原先契约一致。
- **保留**：in-band 前导错误仍会 fallback；Responses 的 `response.created` 后不明结果仍禁止重放。不改 rung。

## 2026-09-17 · DeepSeek 缺明文 reasoning 时关掉思考，不伪造思考内容（Provider / 协议互译，docs/05，原则 3/8）

- **现象**：Codex 从 OpenAI 落到 `deepseek-responses/deepseek-flash` 后 400：`The reasoning_text in the thinking mode must be passed back to the API.` Lane rung 不动。
- **实测（真打 api.deepseek.com，用抓下来的上行体）**：历史里只有 OpenAI 的 `encrypted_content`，网关解不开。设 `reasoning.effort: "none"` 后成功返回工具调用、无 DSML；`thinking: {type:"disabled"}` 无效。
- **修复**：`deepseek-responses` 增加 opt-in 契约 `disableThinkingOnOpaqueReasoningHistory`。仅当同时满足「有工具历史 + 有 reasoning item + 至少一条没有明文 `reasoning_text`」时，把顶层 `reasoning.effort` 写成 `"none"`，其余字段原样保留。不发明明文，不改没有工具历史的请求，已有明文的也不动。
- **兜底**：执行层识别 `reasoning_text` + `thinking mode` 的 400，与既有 `reasoning_content` 一样记 `reasoning_history_incompatible`、不熔断、继续下一条候选。契约修掉了主路径；这条是漏网时的安全网。

## 2026-09-17 · 首字节超时：卡住的 Responses 前导算熔断，禁止重放不明结果（Provider execution，docs/04/05，原则 5/8）

- **现象**：过载上游 HTTP 200 开流，只吐 `response.created` + keepalive，几分钟才在流内报 `server_is_overloaded`。生产一条候选烧掉 103s / 104s 请求；熔断要等尝试结束才记账，5 次跳闸前用户已经等了好几分钟。池内过载退避本就有界（1s、3s），连通性测试用 no-op breaker 是刻意的。
- **修复**：`guardPreOutputFailure` 增加 `firstOutputTimeoutMs`。只卡**第一帧真实输出**；提交后拆除，慢生成的尾巴不切。到期抛 `errorClass: "timeout"`，Responses 带 `response_create_outcome_unknown`（请求可能已在上游执行，禁止重放到下一条候选），同时 `onTimeout` abort 上游。执行层曾默认 15s；2026-09-18 已取消该默认，见上方条目。
- **熔断**：post-send 不明结果原先 `recordAbort`。首字节超时是健康故障，即使不能重放也要 `recordFailure`，这样卡住的 Codex 别名会在几次后跳闸。
- **不改 rung**。测试缝 `firstOutputTimeoutMs` 只给单测把 15s 收到 40ms。

## 历史条目摘要（最新要点）

- **2026-09-17 · Lite 回放加密 reasoning 时清空明文 content**：Lite 对带密文的 reasoning 把 content 清为 `[]`。完整原文见 git history。
- **2026-09-17 · 候选链只有一个候选时说明原因**：stateful Responses 续接故意单候选；UI 在候选数 === 1 时把 `policy_reason` 提成说明行。完整原文见 git history。
- **2026-09-17 · DSML 泄漏修复补完：工具声明在 additional_tools 里**：v0.29.21 只扫顶层 `tools`（Codex code-mode 实际在 `input[].additional_tools`）。必须 hoist 到顶层 `tools`；只改写内部不够。去重放到改写阶段。完整原文见 git history。
- **2026-09-17 · DSML 泄漏的真根因与修复：翻译不被支持的 custom 工具**：DeepSeek 只接受 `apply_patch` custom；Codex `exec` 未声明却在历史里回放就会 DSML 泄漏。`translateUnsupportedCustomTools` 改写成 function。完整原文见 git history。
- **2026-09-17 · ~~撤回 DeepSeek 的 lane 兜底~~**：曾因 DSML 泄漏（全角 `｜` 文本标记）撤回 6 条 GPT rung；同日工具翻译条目恢复。完整原文见 git history。

- **2026-09-17 · 过载预算耗尽不再中断候选链**：`overloadRetry.exhausted` 曾 `break` 整个候选链。等待上界仍由跨候选 `attempt` 与池内 `budget.exhausted` 守住。

- **2026-09-17 · 接入 DeepSeek 原生 Responses 透传**：新增 `deepseek-responses` 字节透传；不新增 profile 枚举，用 `acceptsResponsesNativeItems`。两个真 400：缺明文 reasoning、回显 search call。lane 当天加过又撤，后由工具翻译条目恢复。

- **2026-09-17 · 记录上游回显的 safety_identifier**：记回显值而非发送值；流式取最后一个非空。Admin 放在「响应」面板。无迁移。

- **2026-09-17 · 记录真正发送上游的 Codex installation id**：按 attempt 记 mutation ledger，成功值提升到 `DecisionRecord.codex_installation_id`；`source` 三态 rebound/client/absent。未新增传播通道。
- **2026-09-17 · 修复 provider 字段兼容 400**：legacy `store:false` 删已证实被拒的 `status`；Sonnet 5 发送前再剥 `temperature`。不扩大通用 400 fallback。
- **2026-09-17 · 无消息上游失败暴露原始事件**：`response.failed` 缺 message 时连通性面板只剩固定文案。兜底消息追加 `code=` 与截断事件 JSON；完整事件仍在 `providerRaw`。测试用 `Symbol.asyncIterator` 避开 biome `useYield`。
- **2026-09-16 · 下线 gpt-5.5：断路由但保留价目**：与 Codex Spark 先例（条目删干净）有意偏离——box 上 `served_model='gpt-5.5'` 有 349,050 条 / $28,828.83，`historical-cost-reprice.ts` 查不到价目就 skip，删价目等于永久放弃重算能力。故只移除 lane / alias / provider 条目 / curated list，`pricing.yaml` + `capabilities.yaml` 保留并加退休注释。坑：`validateModelAliasTargets` 启动 fail-closed，alias 必须与 lane 同步删（删后由 `"gpt-5*": premium` 接住，优雅降级非 400）；**manual 模式的 `enabledModels` allowlist 绕过了退休过滤**，已在 `selectAccountModels` chokepoint 补上（测试抓到的，非预判）。`codex-models.json` 由 sync 生成不手改，过滤在 `parseModels`。顺带修正 docs/04 的 lane 计数。
- **2026-09-16 · Codex installation id 按账号重绑**：上游 `installation_id` 是 `$CODEX_HOME/installation_id` 里的纯随机 UUID v4（标识安装而非账号），同机多账号此前共用一个指纹出网。改为每账号确定性派生（`sha256(encKey ‖ "codex-installation:<provider>:<account>")` 前 16 字节整成 UUID v4 形状，永不轮换、免回写 DB）。**三处**必须一起重绑：header `x-codex-installation-id`、`client_metadata` 同名 key、`x-codex-turn-metadata` JSON 内的 `installation_id`——只改 header 则 body 仍泄漏真值。客户端未携带时完全不改写；turn-metadata 非法 JSON 原样透传；`prompt_cache_key` 取自 `session_id`，缓存亲和性不受影响。

- **2026-09-10 · 失败请求保留最终尝试的订阅账号**：`serving_account` 成功时仍是实际服务账号；全链路失败时改记最后一次真正发起上游请求的订阅账号，便于定位账号级故障。候选在选账号前就被熔断/能力门禁跳过则保持 `null`，不伪造分配结果；订阅账号失败后又试了其他 provider 时旧账号不会被误标。未新增 schema、迁移或正文记录。

- **2026-09-06 · 对齐 Codex Lite 身份与流式控制事件**：Lite 完整请求与增量续接保留带前缀的输入项 ID（旧 `store:false` 清理会删掉它们，两条生产失败分别丢了 157/239 个）；`response.metadata` / `codex.rate_limits` / `keepalive` 等控制事件不再提前提交执行尝试，使其后的过载仍能走有界恢复。真实输出、工具调用、加密 reasoning、结果不明断连的禁止重放边界不变。

- **2026-09-06 · Responses 空准备事件保留安全恢复窗口**（#840，本次过载修复的源头）：空 item / 空 part / 空 delta 继续缓冲，只有真实内容才提交流，使随后的过载错误仍能进入 OAuth sibling retry 与模型 fallback；EOF/断连结果不明仍禁止重放。OAuth pool 在首个真实输出前对结构化 `server_is_overloaded` 做同账号短退避（1s、3s），与 HTTP 503/529 共用**请求级**两次额外重试预算。当时把"预算耗尽后禁止账号/模型层重新开始"实现成了 `execute.ts` 里的 `break`，2026-09-17 已纠正为只停等待、不停链推进。`provider.overload_retry` 日志只记 trace/原因/次数/等待毫秒/耗尽标志。

- **2026-09-06 · Remote 配置同步后的目录与 e2e 一致性**：通用 lane 改以 `gpt-5.6-*` 子 lane 为主候选并移除官方 DeepSeek 直连候选，e2e 断言随之对齐；修正 `gpt-image-2` 的 capability key（原为旧的 `zenmux/gpt-image-2`，导致图片端点误报 404）。未改运行时代码。
- **2026-09-06 · 记录 Responses 流内上游错误事件**：error detail 增记 `upstream_event`（`error` / `response.failed`）；HTTP status 保持可空（上游可能先开 200 流再报错）。纯增量、保留原始 provider payload，使 Codex 过载失败可与 Helm 自身准入错误区分。
- **2026-09-06 · 将 Remote 运行时配置同步回仓库**：Remote `/opt/helm-api/config` 无 Git checkout，本次读取 11 个正式 YAML（排除 `.bak*`）原样写回；保留 Remote 的 GPT-6 语义（`gpt-6-astra` lane 主候选 `openai-codex/gpt-6-astra`，四个兼容别名指向该 lane）。
- **2026-09-06 · Codex 原生模型列表保留手动自定义 ID**：`GET /v1/models` 对尚未出现在上游目录的手动 ID，借该账号最低 priority 模型的兼容元数据生成条目（改写 slug/display_name）；只为列表展示与协议兼容兜底，不宣称真实能力，自动模式仍只输出上游发现项。
- **2026-09-06 · 订阅账号手动模型允许自定义 ID**：Manual 模式以运维保存的 `enabledModels` 为权威，Codex 自定义 ID 即使未出现在账号目录也保留（只表示“允许尝试”，不伪造 entitlement）；Automatic 仍只跟随上游发现。注意其后 2026-09-16 已为该路径补上退休模型过滤。
- **2026-09-05 · GPT-6 Astra 官方 API 目录与价格**：官方 API capability/pricing 与 reasoning 参数兼容已加入 override，订阅 lane 保留；定价和限制按对应提交回溯。

## 更早历史总览

2026-09-06：Codex 模型发现使用上游 client_version 和可选 base_instructions；订阅模型自动/手动列表统一依据官方目录与数据库权威，完整记录见 Git history。

2026-09-05 Fable 5.1 目录/价格、2026-09-02 HTTP 结果不明禁止重放（保留明确拒绝的有界重试）、2026-09-01 超大历史发送前保护已并入历史；完整内容见基线 `8a7df80c6684b10bfa7ff7f4f07f237a92f95d58`。2026-08-30 及更早工作涵盖订阅图片/视频/TTS 的 entitlement、单写与价格边界，Responses HTTP/WebSocket 生命周期、发送前恢复证明、账号与 transport 亲和、超大历史与压缩，OAuth 模型发现、额度窗口、Retry-After、冷却、轮转和缓存，协议互译与 SSE/tool-call 保真、能力/价格目录、路由/分类/fallback/熔断，Memory observe/inject/反思/压缩/保留与并发治理，payload/session 分段持久化、失败记录、SQLite/Postgres 数据完整性与资源保护，Admin/Portal/i18n/可访问性、key 权限/预算/计量，以及构建、CI、Docker、发布和生产验收。具体默认值、兼容限制与历史实测均以对应提交为准；本次压缩前的完整条目可从基线 412c7cde02288d9b33d54a87f93b43925177b294 的本文件及 Git 历史回溯。
