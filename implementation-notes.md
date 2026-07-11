# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-07-11 · 上下文链耗尽恢复 Claude CLI 自动压缩信号（Provider execution / protocol errors，docs/04/05/07，原则 3/5/7/8）

- **生产证据**：请求 `204c4380-b573-4556-a8c5-7be2772c2241` 的 Anthropic Messages body 为 11,152,406 bytes；所有可用候选均为 `context_too_small`，但执行层最终返回 `all_providers_failed / 502 api_error`。Claude CLI `2.1.201` 因收不到 `invalid_request_error` 和可识别的 token 上限消息，没有触发 reactive compaction。
- **根因**：候选级上下文溢出改为继续 fallback 后，链耗尽聚合仍以 `attemptedAny` 判断 provider 故障；上游溢出曾经实际 invoke，因此被误归类为 `all_providers_failed`。精确 `count_tokens` 预检则被误归类为普通 `capability_unsatisfiable / 422`，且丢失实际 token 与上限。
- **修复语义**：单个候选溢出继续作为 `context_too_small` skip，不计 breaker failure，也不阻止更大上下文模型成功；执行层保留首个上游 detail/provider_raw，并优先选择符合 Claude CLI matcher 的精确消息。只有整条链最终仅由上下文/能力 skip 构成时，才返回 `invalid_request / 400`；若还出现 5xx、429、circuit open 或 provider unavailable，仍保留原有失败分类。
- **精确消息**：具备 Anthropic native `count_tokens` 时，catalog 的廉价输入估算不再提前 context-skip，而是保留其他能力门控并让精确计数裁决；已有 `inputTokens` 与 `exactContextLimit` 时，终态输出 `prompt is too long: <actual> tokens > <limit> maximum`。不具备精确计数的候选用现有估算生成同形消息。Anthropic 非流式响应为 HTTP 400 `invalid_request_error`；流式响应保持 HTTP SSE 语义并发送同类型 terminal error frame。
- **验证**：执行层覆盖预检链耗尽、上游链耗尽、原始 detail 保留、精确消息优先、混合真实 provider failure，以及溢出后成功 fallback；Messages 路由覆盖非流式 400 与流式 terminal error frame。

## 2026-07-11 · Subscription Provider 自动模型展示使用账号级发现与共享缓存（OAuth subscription / Admin providers，docs/04/11，原则 1/3/6）

- **根因**：Providers 表格读取 `listStatus().account.models`，但非 Codex 自动模式过去直接调用 `effectiveAccountModels()`，把 `CURATED_OAUTH_MODELS` 静态 fallback 当成该账号实时可用模型；因此多个 Claude 账号会重复显示同一组写死模型，和 Manage 弹窗、账号 token 的实际发现结果不一致。
- **展示边界**：手动模式继续原样显示持久化的 `enabledModels`；自动模式改为使用该账号的刷新后 token、账号代理和 provider discovery。Anthropic/Copilot 取各自 live models，Codex 保留 account identity、entitlement、visibility 与 alias 扩展规则。
- **请求边界**：非 Codex 手动模式的 allowlist 已是运行时权威值，pool synthesis 不再先调用 `/models` 再覆盖结果；只有自动模式使用 live discovery。Codex 手动模式仍读取账号 catalog 后与 allowlist 取交集，不能绕过订阅 entitlement。
- **失败语义**：管理投影使用严格发现，网络/凭证/上游失败时返回空列表，不把 curated fallback 冒充账号返回。路由合成继续保留既有 curated fail-open 默认值，本次不扩大为全局路由策略变更；已持久化 credential failure 的账号也不会为页面展示再次刷新。
- **复用**：`listStatus` 与 Manage 的 `listModels` 共用账号发现 helper，避免两套 token refresh、proxy 和 Codex catalog 逻辑漂移。core discovery 增加可选 `fallbackToCurated:false`，默认值保持现有运行时兼容。
- **缓存边界**：非 Codex live discovery 使用 Gateway 进程级账号缓存，按 `providerId + account` 隔离；正缓存 5 分钟、失败冷却 1 分钟、最多 128 个账号，并发刷新 singleflight。空结果/异常保留 last-known-good，重新绑定、断开账号或修改代理时精确失效。Admin 与 runtime synthesis 共用同一实例，避免页面读取和 pool rebuild 各请求一次；curated fallback 只在 runtime cache 之外应用，不能污染 Admin 的“账号实际返回”投影。Codex 继续使用其独立的持久 ModelInfo catalog cache。
- **验证**：TDD 覆盖自动模式实时模型、发现失败不展示静态默认、手动模式保存值与跳过 discovery、Codex entitlement/alias、core fallback 开关，以及缓存 TTL、singleflight、last-known-good、精确失效和 Admin/runtime 共享复用；workspace typecheck/lint/build 全通过，完整 Vitest 为 352 files / 5631 tests 全绿。

## 2026-07-11 · Portal 请求详情对齐 Admin 查看器但保持供应链边界（Self-Service Portal / Requests，docs/12，原则 1/6/7/8）

- **对齐范围**：Portal 请求详情复用本地已有的 Conversation / JsonViewer / ImagePreview，并移植 Admin 的 StreamViewer。请求/响应正文按 Admin 模式改为 metadata-first、用户打开时才分段加载；SSE 响应提供 Assembled / Chunks / Raw 三种视图，普通 JSON 继续提供 Tree / Formatted / Raw 与全屏。
- **图片总览**：只扫描 bearer key 已获授权的 request/response 正文，按 Request、Response 分组显示缩略图；点击沿用 ImagePreview 的放大、缩放、1:1、适配与新标签页能力。图片遍历保持深度 24、总数 24、URL 去重上限，避免大正文生成无界 DOM/解码工作。
- **性能与失败语义**：新增 `part=meta`，只返回 `{request,response}` availability flags；ownership 必须在 metadata/store read 前验证。单段加载失败只影响对应 viewer，不让详情摘要白屏；trace 切换时丢弃旧异步结果，避免跨详情串数据。
- **安全边界**：没有照搬 Admin 的原始 `upstream_request`。该正文包含协议翻译结果、wire model 与注入后的 Memory 上下文，继续由 R7 在 store read 前拒绝。Portal metadata 也不得返回或暗示 upstream 是否存在；若未来要展示“模型实际看到的内容”，必须新增服务端白名单规范化投影，不能放开原始 part。
- **验证**：TDD 增加 Portal payload meta ownership/whitelist/fallback 测试、图片 sniff/遍历/去重/上限测试、media-group 纯函数和页面组合 contract；再运行 Portal/Gateway tests、svelte-check、typecheck、lint/build 与真实浏览器交互检查。

## 2026-07-11 · API-key 门户自助 Memory 默认设置（Self-Service Portal / Memory，docs/06/08/12，原则 2/7）

- **授权边界**：新增 `PATCH /portal/api/memory-settings`，只接受严格的 `memory_mode`、`memory_project_id` 与 `memory_thread_source`；目标 key 始终取 bearer identity 的 `keyId`，不能提交 `key_id/account_id`，也不能借此修改 lane、预算或限流。管理面 root key 继续强制只读、保持 memory inert。`memory_thread_source` 在服务端 schema 保持 optional，仅用于兼容仍打开着的 v0.26.16/17 旧 SPA；新 UI 始终显式发送。
- **交互**：Memory 页标题区提供 `Settings` 入口，弹窗内编辑 Memory 开关、`observe`（仅记录）/`inject`（记录并注入）模式、最多 100 字符的项目名，以及线程来源 `auto` / `header`；Account 页只保留只读摘要，避免两个可编辑入口。保存项目后立即重载 facts/reflections，不能继续显示旧池数据。显式 `x-memory-*` 请求头仍覆盖这些服务端默认值。
- **scope 语义**：`memory_project_id` 是共享池选择器，不是纯展示标签；空值仍回落到 key 自身的私有 scope。更改项目只切换默认池，不迁移旧 Memory；同一 account 下采用相同显式项目名的 keys 会共享该池，UI 明示这一点。
- **API 投影**：`/portal/api/me` 同时返回有效 `project_id`、原始配置 `project_name` 与 `thread_source`，避免把 null→key-id 的私有默认 scope 错画成显式共享项目，并让弹窗准确回填线程策略。未新增 DB 字段或迁移，复用已有 KeyStore partial update。
- **验证**：先增加 portal route 红测，覆盖 authenticated-key 强制、严格字段拒绝、disable/clear 和 root 拒绝；设置弹窗再以纯函数红测覆盖 off→inject 编辑回退、observe/project 回填和请求 trim/null 映射；运行 gateway/portal tests、typecheck、portal check/build 和 i18n 校验。

## 2026-07-10–11 · Codex CLI GPT-5.6 subscription parity（OAuth subscription / Responses / model catalog，docs/04/05/11，原则 3/5/6/7/8）

- **对齐基线**：实现逐项对照 OpenAI Codex `54c44b9ed4` 源码，而不是只增加三个模型字符串。Helm 现在使用原生 `GET /v1/models?client_version=...` 的 `{models}` envelope、Codex `ModelInfo` 字段、`minimal_client_version` 过滤和 key 权限过滤，并支持 `gpt-5.6-sol` / `terra` / `luna` 与裸 `gpt-5.6 -> gpt-5.6-sol` wire 规范化。
- **模型目录与缓存**：订阅模型目录按 account identity + Codex client version 持久缓存，支持 fresh/network/stale last-known-good 与上游 ETag 观测。`/v1/models` 返回的是当前 API key 过滤后的稳定 ETag；Responses/compact 不再透传 account-wide 上游 `x-models-etag`，而是覆盖为同一 key 最近取得的目录 ETag，避免 Codex CLI 每轮误判目录变化。
- **Responses parity**：原生 Responses 请求保留 Codex CLI body/header，补齐 compact、input tokens、response lifecycle、reasoning/tool/turn-state metadata、三种 SSE 终态（completed/failed/incomplete）和无终态 EOF fail-closed。compact 与普通 Responses 共用模型 alias、lane、allowed_lanes、blocked_models 和订阅 entitlement 边界。
- **compact 结算与热重建**：compact 只走 Codex 原生 lifecycle，缺少订阅 executor 时返回 `capability_unsatisfiable`，绝不降级成普通 Responses。executor 每次请求读取当前 OAuth pool，所以运行中首次连接、重建或替换账号不需要重启。成功响应按真实顶层 `usage` 结算 token/cost/budget；失败仍保留实际 serving account 和已捕获的 upstream request。Responses usage 同时识别 `cache_write_tokens` / `cache_creation_tokens` / `cache_creation_input_tokens`，避免 cache-write 成本低估。
- **Responses WebSocket parity**：`/v1/responses` 支持真实 `101` upgrade、per-message deflate、`response.create`、`generate:false` 预热、同连接串行复用和 `previous_response_id`。握手先复用 `/v1/models?client_version=...` 做 Helm key 鉴权，并返回 key-scoped `x-models-etag`；`x-reasoning-included` 按 Codex 的“header 存在即 true”语义处理，false-like 值必须省略。明确 `426` 会立即固定切 HTTP；无 HTTP status 的握手故障先按 Codex retry budget 重试，耗尽后固定切 HTTP；`websocket_connection_limit_reached` 会关闭旧连接并重发同一请求，预算耗尽后切 HTTP。`response.failed` / `response.incomplete` / `error`、wrapped HTTP error、非法帧和无终态断连都会销毁连接，只有 `response.completed` 的连接可复用。
- **reasoning 计数握手**：账号/版本作用域的模型快照持久保存上游 `/codex/models` 是否带 `x-reasoning-included`。只有本次 key 可路由的所有快照都明确为真时，`/v1/models` 和 WebSocket upgrade 才返回该 header；旧缓存、bundled fallback 或混合未知账号均省略，避免 Codex CLI 重复或错误计算历史 reasoning token。
- **Codex custom tool 续轮**：Responses Lite 增量帧不得重新注入空 `additional_tools`；协议 transformer 现在显式识别 `custom_tool_call` / `custom_tool_call_output`，映射到 IR tool call/tool message，并在 `provider_raw.responses_input_items` 保留原始 item 序列。这样 output-only continuation 不再变成空 messages，也不会在重放时降级成 `function_call_output`。
- **裸 GPT-5.6 alias**：Codex 模型目录中的 `gpt-5.6` 是 Sol alias，`model-aliases.yaml` 因此直接映射到 `gpt-5.6-sol` lane。不能先进入通用 `gpt-5.6` lane，否则 requested-model promotion 会把未配置的 official `openai/gpt-5.6` 提升到订阅 Sol 前面，产生虚假的 `provider_unavailable` attempt。
- **`ultra` 边界**：`ultra` 是 Codex CLI 本地模式，不是跨 provider 的 wire/config 能力。Helm 只在 Codex subscription 请求边界把它归一化为 wire `max`；共享 IR、Lane/Policy schema、Admin 配置、Anthropic 与 Gemini 均不暴露或发送 `ultra`，避免把 Codex 的 proactive multi-agent 开关扩散成全局协议字段。
- **订阅与配额**：ChatGPT identity claims、plan、credits、reset-credit details、`rate_limit_reached_type`、默认与 additional model limits 都从 WHAM usage/headers 解析并贯通 Gateway/Admin。`x-codex-active-limit` 决定 429 只停车当前模型 entitlement 还是整个账号，quota snapshot 保留上游真实 `usedPercent`，不再把 429 人为改写成 100%。
- **reset-credit 安全边界**：手动和自动 consume 共用 weekly threshold、shared ChatGPT account guard、每小时 cooldown 与 weekly-window 幂等门禁；workspace credits/spend-control 限制不会消耗 rate-limit reset credit。手动操作可选择具体 `credit_id` 并复用 `redeem_request_id`，Admin 明示 plan/balance/reached type 和具体 credit。
- **reset-credit 身份后备**：shared guard 优先使用 `chatgpt_account_id`；缺失时使用稳定的 ChatGPT user ID，再后备到规范化 email，只有完全没有上游身份时才退回 Helm label。这样同一订阅绑定多个 label 不会重复消耗 credit，同时不同用户不会被合并。
- **Claude Fable 外部审查**：PR 按 8 个逻辑 diff 交给 Claude CLI `fable` 高强度只读审查，并逐条由 Helm 侧复核。确认并修复 4 个真实问题：upgrade async preflight 前缺少 raw socket error guard、出站 WebSocket close/error 终态不可重放、共享 catalog snapshot 被原地排序、Admin metadata-only quota 同时显示空占位。其余关于 372K Codex context、ETag CRLF、body reader lock、HTTP fallback session 泄漏、`gpt-5.6-*` 未来模型等结论因与上游源码/运行时或当前作用域证据不符而未改动。
- **live 验证结果**：本地 Docker 数据卷中的真实 Codex 订阅账号可调度，Codex CLI `0.144.1` 通过完整 custom provider（command auth + Responses WebSocket）验证 `gpt-5.6-sol` / `terra` / `luna` / 裸 `gpt-5.6` 的 shell 工具调用、结果续轮、最终文本和 `turn.completed`。模型目录返回 9 项且包含四个 GPT-5.6 名称；裸 alias 的 3 个 Responses 轮次 telemetry 均为单次 `openai-codex/gpt-5.6-sol` attempt，无 skip/fallback/provider 漂移。本次未消费 reset credit。

## 2026-07-10 · Direct DeepSeek Responses reasoning history pre-skip（Provider execution / protocol translation，docs/04/05/07，原则 3/5/8）

- **背景（Lukin）**：生产请求 `17de8e09-cd94-4aa4-ab67-d2bacf3e4318` 最终由 `openrouter/deepseek-v4-flash` 成功服务，但 direct `deepseek/deepseek-v4-flash` fallback 先返回 400：`The reasoning_content in the thinking mode must be passed back to the API.` 近 3 天统计显示这类 direct DeepSeek reasoning-history 400 共 89 次，均最终 fallback 成功；部署 `v0.26.13` 后新增 3 次，说明 GPT-5.6 Chat tools 修复后剩余红色 400 主要是这个兼容问题。
- **修复决策**：Responses reasoning items 在 IR 中进入 `thinking` / `provider_raw.reasoning`，跨到 OpenAI Chat target 时会被剥离，无法还原成 direct DeepSeek thinking 模式要求的历史 `reasoning_content`。因此对 `providerName === "deepseek"` 且 `targetProviderProtocol === "openai_chat"` 的候选，在检测到 Responses reasoning history 时发送前直接 skip，使用既有 `reasoning_history_incompatible` skip reason。
- **边界**：不跳过 OpenRouter 托管的 DeepSeek；线上同一请求证明 OpenRouter target 能接受 Helm 剥离 reasoning history 后的 OpenAI Chat body。该规则只避免 direct DeepSeek 的确定性 400，不改变最终 fallback 选择。
- **验证**：新增 execute 正/负回归测试：direct DeepSeek 被预跳过且不会调用 provider；OpenRouter-hosted DeepSeek 仍会正常尝试。

## 2026-07-10 · GPT-5.6 Chat tools force reasoning_effort none（Provider execution / protocol translation，docs/04/05/07，原则 3/5/8）

- **背景（Lukin）**：生产请求 `fd9fb61e-7ed0-4950-aecc-a7966b1caf33` 从 Anthropic Messages 协议进入 `economy` lane，`openai-codex/gpt-5.6-luna` 404 后 fallback 到 official `openai/gpt-5.6-luna`。该 fallback 使用 `/v1/chat/completions`，请求同时带 function tools 与 lane-forced `reasoning_effort: medium`，OpenAI 返回 400：该组合只支持 `/v1/responses` 或 `reasoning_effort: none`。
- **修复决策**：不把 GPT-5.6 的 reasoning 能力整体关闭；只在 `targetProviderProtocol === openai_chat`、resolved model 属于 `gpt-5.6*`、且请求带 tools/functions 时把 Chat wire 显式设为 `reasoning_effort: "none"`，并剥离 nested `reasoning.effort`。单纯删除字段不够，因为 GPT-5.6 Chat+tools 仍会按上游默认 reasoning 触发同一个 400。
- **观测**：触发时写入 `request_mutations.body_shims_applied: ["reasoning_effort_none_for_chat_tools"]`，区别于“模型完全不支持 reasoning”的 `reasoning_effort_stripped_for_model`，方便 Admin 请求详情定位。
- **验证**：新增 execute 回归测试复现 Anthropic→OpenAI Chat fallback + GPT-5.6 Luna + tools + reasoning 的组合，并覆盖客户端完全不传 reasoning 的情况；断言 tools 保留、wire body 显式发送 `reasoning_effort: "none"`。

## 2026-07-10 · GPT-5.6 family support in Helm defaults（Routing / provider catalog / cost telemetry，docs/03/04/07，原则 3/4/5/6）

- **官方来源**：OpenAI latest-model docs 确认 `gpt-5.6` alias routes to `gpt-5.6-sol`，并给出 `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` 三档；OpenAI Models/Pricing docs 确认 1,050,000 context、128,000 max output、Responses/Chat/Batch 支持，以及标准价 input/cache-read/cache-write/output。
- **路由决策**：quality lanes 升级为 GPT-5.6 family：`premium/coding/tool_use` 走 verified subscription Sol，`balanced` 走 verified subscription Terra，`economy` 走 verified subscription Luna 并以 official OpenAI Luna（有 `OPENAI_API_KEY` 时）兜底，再降级到 subscription `gpt-5.4-mini` 与既有低成本链；同时新增 `gpt-5.6*` vendor-family lanes，让显式模型请求先走同家族再降级到既有质量 lane。
- **供应链边界**：`gpt-5.6` 是 official API alias（routes to Sol），但 ChatGPT/Codex subscription backend 当前拒绝裸 `gpt-5.6`。Helm 默认 curated subscription list 包含 `openai-codex/gpt-5.6-sol` / `openai-codex/gpt-5.6-terra` / `openai-codex/gpt-5.6-luna`，显式 `gpt-5.6-luna` 与 `economy` 默认优先使用 Luna 的 OAuth 路径；operator 仍可手工增删并用 account test 验证。
- **context 边界**：`openai/*` official API aliases 使用官方 1.05M context；`openai-codex/*` subscription aliases 继续保守使用 272K context cap，因为线上 Codex 订阅后端已有 `context_length_exceeded` 证据。这里优先避免 oversized 请求先打到必失败的订阅后端。
- **价格决策**：telemetry pricing 使用官方标准 tier，不使用 priority tier；cache write 按 1.25x input 记录，cache read 使用折扣价。成本数据只用于观测，不参与路由选择。
- **OpenAI wire 参数**：Responses `max_output_tokens` 经 IR 到 official OpenAI GPT-5.6 Chat wire 时必须渲染为 `max_completion_tokens`，不能沿用旧 `max_tokens`；否则 `openai/gpt-5.6-luna` 等官方 GPT-5.6 模型会返回 `unsupported_parameter`。
- **兼容性**：Codex OAuth 仍是 curated-only（无 live list endpoint），默认 curated list 以 GPT-5.6 Sol/Terra/Luna 开头并保留 GPT-5.5/GPT-5.4/GPT-5.4-mini，管理员保存的 enabledModels 仍然是权威覆盖。`model-aliases.yaml` 同时接受 Codex App/CLI 内部 `openai.gpt-5.6-*` 名字；Responses 入口接受 Codex CLI 发出的 `reasoning:null` 并按未设置处理。

## 2026-07-09 · 个人门户（Self-Service Portal）完整实现 + 补齐 + 多语言（docs/12，原则 1/6/7）→ v0.26.0

- **v0.26.0 发布范围**：整个 self-service portal（apps/portal 新 SvelteKit SPA）+ 6 个 bearer-scoped 端点 + 白名单脱敏 + Docker 集成 + admin/portal 7 语言 i18n。
- **补齐工作（第一版太简陋，对照 spec+admin 重做，Codex 执行我验收）**：Requests 列表补全筛选（RangeFilter today/yesterday/7d/30d/all + 自定义日期 + status + model 搜索 + RefreshControl + URL 同步，后端 `/portal/api/requests` 扩展 start/end/status/model 参数、apiKeyId 写死）；Overview 加环比 delta + 顶部 RangeFilter+RefreshControl（同 admin Dashboard）；Memory 从 128 行残废重做成完整 CRUD（复用 admin AddFactDialog/EditFactDialog/EditReflectionDialog 但改走 mcpTool，加搜索/状态筛选/分页/"什么是记忆"说明+隐私文案）；Connect 的 MCP tab 补全 ChatGPT OAuth 6 步/JSON config/Codex mcp-remote 桥（逐字移植 admin ConnectMcpDialog）。
- **安全后端二次修复（by_model 泄漏）**：telemetry `served_model` 列存的是 `final.provider_model`（wire id）不是公开别名。portal usage `by_model` 直接透出会泄漏 provider wire model（原则 6/R7）。修复：`registerPortalApi` 加 `resolveModelLabel` dep（从 config.providers 构建 wire→alias 反查），unmappable→"other"。加 2 个防泄漏单测。
- **UI 打磨（Lukin 反馈）**：① 导航当前页从淡底改**实心 indigo 胶囊+白字**（aria-current）；② Connect 客户端 tab 从失效的 `.tab-active`（无对应 CSS）改**分段控件**（白底胶囊+aria-selected）；③ Connect 代码块加分步注释（`# 1) Set env` / `# 2) Run`）消除孤立 `claude` 困惑；④ Memory 页 disabled 判断从 `memory.mode==='off'` 改成只看 MCP 是否可用（mode=off 仍能浏览/管理记忆）；⑤ 账户菜单下拉加 `clickOutside` action（`$lib/clickOutside.ts`，pointerdown capture）点空白关闭（Modal scrim + RefreshControl 本来就有 outside-click）。
- **多语言（原用户明确要求）**：admin+portal 各加 es(Español)/pt(Português)，现 7 语言（en/zh-hans/zh-hant/ja/ko/es/pt）。languages.ts(LocaleCode+SUPPORTED+normalizeLocale)/loaders.ts/package.json i18n:update 都扩展。跑 i18n:extract 拉全 $t key，14 个 locale 文件全部 0 空值。技术术语/URL/CLI/代码/占位符{value}保持原文，中文意译。**注意**：`i18n:translate` 工具依赖 LAN relay(192.168.199.7)本机不可达，翻译由 Codex 手工做；代码块字符串是裸 template string 不走 $t()，天然不译。
- **验收方式（关键）**：全程本地 Docker 部署验收（重建镜像→跑安全红线测试→Playwright 真浏览器三档屏幕走查）。seed 脚本造 143 条 8 天多模型 telemetry 让 Overview 图表/环比/donut 有数据。memory.mcp 需 config 开启（默认关，portal Memory 页才活）。**Dockerfile 必须加 apps/portal/package.json（install 阶段）+ portal build 拷贝**，否则 /portal 404。portal-static.ts 启动时从 built index.html 读 CSP script hash（SvelteKit adapter-static 注入内联 bootstrap script，强 CSP 会拦→白屏，用 hash 放行）。

- **背景**：实现 docs/12 完整三迭代门户——key 持有者只能看/管自己那把 key 的接入/用量/请求/记忆。全新 `apps/portal` SvelteKit SPA + 6 个 bearer-scoped `/portal/api/*` 端点 + 白名单脱敏层，全程 TDD（安全红线测试先行）。
- **后端决策**：
  - `toPortalDecisionView`（`packages/shared/src/decision/portal-view.ts`，框架无关）**白名单**投影 DecisionRecord——只透 served_model(=final.model_alias)/lane/status/latency/cost/usage，剔除 provider_attempts、serving_account、classifier、lane.candidate_chain、final.provider_model（供应链/内部推理 = 核心 IP，原则 6）。单测扫描序列化输出确认 8 个 poison 字符串（provider 别名/wire model/eval model/账号 id）绝不出现。
  - `assertOwnsTrace`（`apps/gateway/src/routes/portal/ownership.ts`）：traceId 详情/payload **先** `getApiKeyId==identity.keyId` 再取数据（R1）；miss 与"属于别人"同一 not_found 分支 → 404 而非 403（R2 防枚举）；keyId 缺失 **throw**（fail-closed，绝不 scopeless 查询，R5）。
  - 6 端点（`routes/portal/index.ts`）全部照抄 `usage.ts` 范式：写死 `identity.keyId`/`accountId`，忽略调用方任何 key_id/account_id 入参。usage/stats 复用 `aggregate` 并**透出被 /v1 丢弃的 series+byModel+budget**。payload 端点白名单 `part∈{request,response}`，**拒 upstream_request**（400，原则 6）。
- **memory 决策（关键省成本）**：**不做 memory REST**——前端直接打现有 `POST /mcp` JSON-RPC（docs/12 §4.2 endpoint 6，零新后端）。`accountId`/`projectId` 由 MCP ctx 从 bearer 派生，前端绝不传（R3/R4，已核实 tools.ts 服务端强制）。
- **前端决策**：
  - 明文 key + `sessionStorage` + 每请求 `Authorization: Bearer`（docs/12 §4.1）；否决 session token/localStorage/cookie。
  - **复用 admin 资产**：app.css（设计系统）、i18n（改 STORAGE_KEY 为 helm_portal_locale）、format.ts、pagination.ts、LayerChart 图表配置、请求详情 viewer（Conversation/TokenUsage/CostBreakdown/JsonViewer）。**不复用 RequestsTable**（耦合 admin decision shape 的"过程视角"——attempt codes/decided_by），改写门户简表只显示白名单"结果视角"字段（比适配 RequestsTable 更省代码且语义正确）。
  - `apps/portal/src/lib/api/requests.ts` 是**类型 shim**：只重声明 viewer 需要的 `TokenUsageView`/`RequestDetail['cost_breakdown']`，避免拖入整个 admin requests 解析器。
- **踩坑（浏览器验证抓到的真 bug）**：SvelteKit adapter-static 往 index.html 注入一个内联 bootstrap `<script>`，被强 CSP `script-src 'self'` 拦截 → SPA 白屏不启动。修复：svelte.config 开 `kit.csp.mode:'hash'`（SvelteKit 算出该脚本 SHA256 并写进 HTML 的 `<meta>` CSP），`portal-static.ts` 启动时从 built index.html **读取该 hash 并折进响应头 CSP 的 script-src**——header 与 meta 携带同一 hash，浏览器求交集后放行。hash 每次 build 变，但运行时现读现折，永不脱同步。
- **验证路径**：21 个后端单测（portal-view/ownership/routes/portal-static）+ typecheck + svelte-check 0 error + biome 干净；一次性 tsx 脚本 boot 真实 gateway 验证 21 条运行时红线（跨 key 详情/payload 404、upstream 拒绝、series/budget 透出、CSP 头），再用 Playwright 真浏览器走 login→Overview→Connect（base_url 无 /v1、Test connection→Connected）→Account 全流程通过。
- **TODO/边界**：门户对 XSS 防护上限 = CSP 强度，sessionStorage 非 XSS 免疫（诚实边界写进登录页文案）；根治需门户专用只读 scope key（后续 key-scoping 特性，不在本次）。RefreshControl（自动刷新）门户未加，需要再补。

## 2026-07-07 · 视觉压缩后收敛 cache_control 并保留客户端 billing identity（Provider execution / cost control，docs/04/05，原则 3/5/7/8）

- **背景（Lukin）**：生产 Luke key 的 `claude-fable-5` / GSC 请求在 v0.25.18 后成本下降，但 cache-read share 没明显上升。线上 payload 复查显示 CCH 已从几乎每轮变化降到少数稳定桶；继续拆缓存的原因之一是压缩图片 anchor 后面仍残留动态文本上的 `cache_control`（例如 teammate 状态、短用户指令），导致 Anthropic 尝试更长但每轮变化的缓存前缀并产生额外 cache-write。
- **cache_control 决策**：当 pxpipe 返回 `applied:true` 且 `ownsCacheControl:true` 时，Helm 只保留压缩图片上的 cache anchor，并剥离该 anchor 之后 message content blocks 的 `cache_control`。不改变图片、文本、工具或消息顺序；未压缩、observe/off、无图片 anchor 的请求完全不变。这样缓存断点回到稳定图片前缀，后续动态尾巴按普通 fresh input 计费，不再写成新的 prompt-cache 前缀。
- **Telemetry 决策**：`visual_context_compression.marker_count` 记录最终发出的 marker 数；新增 `cache_control_markers_stripped` 只记录剥离数量，不记录正文或图片数据，便于上线后验证是否减少了无意义 cache-write。
- **billing identity 决策**：入口已提取的 `metadata.client_billing_header` 现在会在 Anthropic compatibility translation body 中透传给 provider 翻译器。真实 Anthropic provider 只用它重建 billing block 和 User-Agent，不把 `client_billing_header` 当 Anthropic `metadata` 字段发给上游；provider_raw `metadata.user_id` 仍保留。
- **风险边界**：该修复不尝试改写工具列表，也不删除图片 anchor 之前的调用方 cache marker，避免破坏官方/客户端有意设置的稳定早期断点。它解决的是“压缩接管缓存断点后，后置动态断点继续污染缓存前缀”的窄问题。
- **验证路径**：新增 visual compression 单测覆盖后置动态 marker 剥离与 telemetry；新增 execute 单测覆盖 `client_billing_header` 合并到 Anthropic translation metadata。执行层 126 个测试、压缩层测试与 workspace typecheck 通过。

## 2026-07-07 · Anthropic 兼容改写路径稳定 CCH 并接入视觉压缩（Provider execution / cost control，docs/04/05，原则 3/5/7/8）

- **背景（Lukin）**：生产 Luke key 的 `claude-fable-5` 请求在 v0.25.17 后仍只有约三成 cache-read share。复查发现 `cch` 不是被删除：客户端原始 billing header 无 `cch`，上游 body 有 Helm 重建的 `cch`；但 OAuth strict fingerprint 会再按完整 body 签 CCH，messages/max_tokens 等非缓存前缀变化仍会让 `system[0]` 变化。另一半问题是这批请求大多因 `provider_requires_compatibility_rewrite` 走普通 `chatCompletion` 翻译路径，而 `visual_context_compression` 只挂在 native passthrough body 上，无法处理真正贵的兼容改写请求。
- **执行决策**：strict Claude CLI shape 仍保留 header 顺序、tool cloak、runtime headers，但 CCH 改为只从 cache-prefix 材料（model/system/tools，排除 messages 和采样参数）计算，避免第一块 system 自己烧掉 prompt cache。再给 `ProviderCallOptions` 增加 Anthropic-only `optimizeAnthropicBody` 钩子；Anthropic provider 先按既有逻辑生成最终 Anthropic Messages body，再在 capture/POST 前调用该钩子。这样不绕过 provider 的 OAuth、签名、重试和响应转换，也不会影响 OpenAI/Gemini providers。
- **Telemetry 决策**：execute 在 stream/non-stream 翻译路径都传入同一个 per-attempt optimizer，并把 `visual_context_compression` mutation 与既有 `request_mutations` 合并；provider 忽略/未调用时 mutation 为空，避免把没有实际压缩的请求误报成省钱。
- **风险边界**：该钩子只优化 Anthropic-native wire body；`mode=off` 仍为 no-op，压缩器异常 fail-open 发原 body。实际节省依赖 pxpipe 对该请求形态是否 `applied:true`，上线后必须用 mutation + usage 验证，而不是只看功能开关。
- **验证路径**：新增 execute 测试覆盖 `provider_requires_compatibility_rewrite` 仍调用 visual compression 并记录 mutation；新增 Anthropic provider 测试确认 translated body 在 capture/POST 前被优化。

## 历史条目摘要（最近 5 条）

- **2026-07-06 · 请求总超时驱动下游 abort 与失败 telemetry（Gateway runtime / telemetry，docs/02/07，原则 3/5/7）**：总超时统一 abort 下游并把客户端可见终态固定为 timeout，晚到 provider 成功只保留为 attempt 事实，不得覆盖最终失败或 payload。
- **2026-07-06 · API key 绝对模型黑名单（Key governance / routing / Admin keys，docs/04/06/11，原则 5/6/7）**：每把 key 的 exact/glob `blocked_models` 同时约束 direct、lane expansion、fallback、model list 与各协议入口，空链 fail-closed，SQLite/Postgres 与 Admin 表单保持一致。
- **2026-07-06 · 折叠会话行显示工具调用参数预览（Admin requests / conversation view，docs/11，原则 1）**：工具参数预览改为 whitelist-free，按 args 形状泛化提取 readable scalar，覆盖自定义/大小写不同工具并保留展开详情。
- **2026-07-06 · 配额 PULL 的 100% 账号级窗口必须同步停车（OAuth provider pool / Admin providers，docs/04/11，原则 3/5/7）**：quota PULL 看到账号级 100% 窗口时立即写入 cooldown 并同步 live pool，scoped model 窗口不扩大成全账号停车。
- **2026-07-05 · OAuth 凭证失效持久化为 needs reconnect（OAuth provider pool / Admin providers，docs/04/11，原则 3/5/7）**：refresh/持久 upstream 400/401/403 标记 credential failure、写入账号设置并摘出调度，reconnect 成功后按手动/自动停车边界恢复。
## 更早历史总览

2026-07-06 压缩条目还包括 Anthropic native passthrough 稳定 Claude Code billing `cch`、Admin 模型搜索预计算列、payload 分段懒加载、纯工具 turn 去空 header/默认展开，以及 Claude Code 风格 inline tool peek。2026-07-04 更早条目还包括 cheap-model 当前轮低风险降级、视觉上下文压缩 observe/off 接入、Memory stats 队列索引优化、OAuth 会话亲和调度、idle-flush 碎片段优先压缩最大连续段、memory worker 受控并发追赶、记忆页只读运行状态面板、Claude scoped weekly quota 只影响对应模型、跨协议 reasoning-history 候选级跳过、memory idle-flush 防饥饿、策略级 reasoning_effort 覆盖 lane 默认值、cron monitor 低成本规则等。2026-06-30 及以前的工作主要围绕 Helm API 的协议面、路由执行、admin 可观测性与自托管部署逐步成型：补齐 Gemini/OpenAI/Anthropic/Responses 双向转换、SSE 流式正确性、tool-call/JSON schema/思考参数保真、per-model reasoning effort、模型别名与能力/成本目录、provider fallback 与熔断语义、OAuth subscription providers、多账户池与 quota 处理、memory observe/inject/forgetting/admin/MCP、请求 payload 捕获与 request detail UI、API key 治理、admin 表格/过滤/分页/i18n、Docker/CI/release/deploy 验证，以及早期 Phase 0 的 Hono + SvelteKit static admin + Store 端口 + SQLite/Supabase 架构决策。更早细节不再逐条保留在本文件；需要精确背景时回查 git history。
