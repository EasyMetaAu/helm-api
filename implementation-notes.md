# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-07-12 · SuperGrok/X Premium OAuth 实验性订阅 Provider（OAuth subscription / Responses / Admin providers，docs/04/09/10/11，原则 2/3/6/7/8）

- **官方边界**：xAI 官方开发者 API 仍使用充值后的 `XAI_API_KEY` 与 `api.x.ai/v1`；SuperGrok 是独立的消费者订阅。官方 Grok CLI 支持 browser/device-code OAuth，公开 OIDC discovery 位于 `auth.x.ai`，但没有第三方 client registration，也没有承诺 `cli-chat-proxy.grok.com/v1` 是稳定的第三方合约。
- **安全决策**：按用户决定不设置额外 feature flag，Provider 默认在 Admin 暴露，连接后立即参与模型目录与路由；UI 和文档仍明确标记 Experimental、仅限账户持有人个人自托管评估。不得把订阅凭证共享、转售或作为多租户公共后端；生产支持路径仍是 xAI API key，或向 xAI 申请 Helm 专用 client 与书面授权。
- **协议实现**：clean-room 参考 MIT OpenClaw/OpenCode：OIDC discovery 结果只接受 HTTPS `x.ai`/`*.x.ai`，所有 discovery/device/token/refresh 请求禁用自动重定向，避免 `307/308` 把 device code 或 refresh token 带到非信任域。RFC 8628 device code 首次 poll 前等待上游 `interval`，`slow_down` 每次增加 5 秒，Admin/UI 透传 interval/expiry 且过期不再请求；refresh token rotation 保留未轮换旧 token，敏感响应正文不进入错误或日志。token 继续使用 Helm AES-GCM OAuthTokenStore、singleflight refresh、账号代理和 credential-failure 机制。
- **执行与目录**：订阅 token 只发送到 `https://cli-chat-proxy.grok.com/v1`，使用 generic OpenAI Responses executor，不能继承 ChatGPT/Codex identity headers。对照本机官方 Grok CLI `0.2.93` 的运行配置与真实成功请求，推理必须发送 `X-XAI-Token-Auth: xai-grok-cli`、`x-authenticateresponse: authenticate-response`、`x-grok-client-version: 0.2.93` 和按最终 wire model 生成的 `x-grok-model-override`；缺 client version 时上游稳定返回 426。该代理多数内部模型仅接受 SSE，因此 Helm 上游固定 `stream:true/store:false`：客户端非流式 Chat/Responses 在内部聚合 SSE，对外合同不变；Chat 的合法 `response.incomplete`（例如 `max_output_tokens`）按流式/非流式一致映射为 `finish_reason:length`，native Responses 非流式仍只接受 `response.completed`。流式路径要求明确 terminal event，断流 fail-closed。模型从账号 `/models` 动态发现，禁用 redirect，并以 30 秒 timeout、外部 abort 和 1 MiB Content-Length/流式双重上限约束；发现失败返回空，不用 `api.x.ai` 公共目录伪造订阅 entitlement。没有公开 SuperGrok quota API，因此不造 Heavy 周额度或 Codex quota source。
- **验证边界**：单元/组合测试覆盖 discovery allowlist、redirect 拒绝、bounded model discovery、device interval/expiry/slow_down、refresh rotation、加密持久化、默认 Provider 目录、动态模型、Bearer Responses 请求与无 Codex headers。真实 Docker 验证覆盖模型发现、Admin Connectivity Test、Responses 流式/非流式、tool call、`grok-4.5`、Composer、容器重启后的 token refresh 持久化，以及 Chat 流式/非流式 `response.incomplete → length`；浏览器走查确认 Providers 卡片与 Test 弹窗成功状态。Claude CLI Opus 循环审查发现并推动修复 Chat 两条 incomplete 路径，第三轮结论为 clean。

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

## 2026-07-11 · Claude Sonnet 5 订阅流量 API 等价成本与能力目录（Provider catalog / cost telemetry，docs/04/07/11，原则 2/5/7）

- **成本定义**：`anthropic/claude-sonnet-5` 是 Claude Pro/Max OAuth 订阅别名，订阅本身不按请求扣费；Helm 的 `cost_usd` 使用官方 Claude API 等价估算，只用于 telemetry，不参与路由或订阅结算。
- **当前价格**：按 Anthropic 官方 2026-07-11 价格表使用介绍期价格：input `$2/M`、output `$10/M`、5 分钟 cache write `$2.50/M`、cache read `$0.20/M`。介绍期于 2026-08-31 结束；静态 catalog 不支持生效日期，2026-09-01 必须更新为标准 `$3/$15/$3.75/$0.30`。
- **能力边界**：与价格同一变更补齐 1M context、128K synchronous output、tools、vision、streaming、structured outputs、document input，以及 `low/medium/high/xhigh/max` adaptive-thinking effort。manual `budget_tokens` thinking 明确不支持，避免价格单独引入 `EMPTY_CAPABILITIES` 后被 `context_too_small` 错误过滤。
- **历史边界**：部署后新请求可正常估算成本；已有 `cost_usd = null` 的历史 telemetry 不自动回填。
- **官方依据**：Anthropic Models overview、Pricing、What's new in Claude Sonnet 5、Effort 与 Structured outputs 文档，均于 2026-07-11 读取。

## 2026-07-11 · 退休 GPT-5.3-Codex-Spark 及其订阅配额投影（OAuth subscription / model catalog / Admin providers，docs/04/11，原则 3/5/6/7）

- **退休边界**：`gpt-5.3-codex-spark` 不再作为可用订阅模型。Codex live discovery、bundled fallback、持久 catalog cache 与手工 enabled-model 展开都会过滤该 slug，避免旧设置或 last-known-good 快照重新暴露已退休模型。
- **配额边界**：WHAM body、Codex response headers、Gateway 持久 quota snapshot、live metadata 和 Admin 最终展示都会过滤 `codex_spark` / `*-Codex-Spark` model-scoped limits。旧快照不会再显示 Spark，也不会让退休窗口参与账号停车、恢复或 reset-credit 判断；若持久 snapshot 过滤后为空，reset-credit 会回退到本次实时 quota，而不是误报 quota unavailable。账号级窗口和 Luna/Sol/Terra 等有效模型窗口保持原语义。
- **分类与 UI**：保留 cheap-model classifier 中的 `spark` 语义 marker；它用于识别低成本模型族，不等同于已退休的精确 Codex Spark 模型 ID。撤销仅为 Codex Spark 长标签添加的 9px quota 字号，恢复普通窗口标签字号。订阅 credits 继续只显示两位小数，零余额继续隐藏。
- **兼容决策**：运行时仍保留最小的 Spark 识别常量，并在专门的防回归 fixture 中保留退休字符串；这是为了丢弃历史缓存和旧上游数据，不代表模型仍可配置或使用。
- **验证**：覆盖 live/bundled/cached catalog、手工 alias 展开、header/WHAM quota、Gateway 读写投影与 Admin 历史快照；相关定向测试、workspace test/typecheck/lint/build 作为交付门禁。

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

## 历史条目摘要（最近 5 条）

- **2026-07-10 · GPT-5.6 family support in Helm defaults（Routing / provider catalog / cost telemetry，docs/03/04/07，原则 3/4/5/6）**：默认 lanes、能力/价格目录与 wire 参数升级到 Sol/Terra/Luna，同时保持 official API 与 Codex subscription 的 entitlement/context 边界。
- **2026-07-06 · 请求总超时驱动下游 abort 与失败 telemetry（Gateway runtime / telemetry，docs/02/07，原则 3/5/7）**：总超时统一 abort 下游并把客户端可见终态固定为 timeout，晚到 provider 成功只保留为 attempt 事实，不得覆盖最终失败或 payload。
- **2026-07-06 · API key 绝对模型黑名单（Key governance / routing / Admin keys，docs/04/06/11，原则 5/6/7）**：每把 key 的 exact/glob `blocked_models` 同时约束 direct、lane expansion、fallback、model list 与各协议入口，空链 fail-closed，SQLite/Postgres 与 Admin 表单保持一致。
- **2026-07-06 · 折叠会话行显示工具调用参数预览（Admin requests / conversation view，docs/11，原则 1）**：工具参数预览改为 whitelist-free，按 args 形状泛化提取 readable scalar，覆盖自定义/大小写不同工具并保留展开详情。
- **2026-07-06 · 配额 PULL 的 100% 账号级窗口必须同步停车（OAuth provider pool / Admin providers，docs/04/11，原则 3/5/7）**：quota PULL 看到账号级 100% 窗口时立即写入 cooldown 并同步 live pool，scoped model 窗口不扩大成全账号停车。
- **2026-07-05 · OAuth 凭证失效持久化为 needs reconnect（OAuth provider pool / Admin providers，docs/04/11，原则 3/5/7）**：refresh/持久 upstream 400/401/403 标记 credential failure、写入账号设置并摘出调度，reconnect 成功后按手动/自动停车边界恢复。
## 更早历史总览

2026-07-07–09 压缩条目包括 self-service portal 完整实现与多语言、视觉压缩后的 cache-control 收敛和 Anthropic 兼容路径 CCH 稳定化。

2026-07-06 压缩条目还包括 Anthropic native passthrough 稳定 Claude Code billing `cch`、Admin 模型搜索预计算列、payload 分段懒加载、纯工具 turn 去空 header/默认展开，以及 Claude Code 风格 inline tool peek。2026-07-04 更早条目还包括 cheap-model 当前轮低风险降级、视觉上下文压缩 observe/off 接入、Memory stats 队列索引优化、OAuth 会话亲和调度、idle-flush 碎片段优先压缩最大连续段、memory worker 受控并发追赶、记忆页只读运行状态面板、Claude scoped weekly quota 只影响对应模型、跨协议 reasoning-history 候选级跳过、memory idle-flush 防饥饿、策略级 reasoning_effort 覆盖 lane 默认值、cron monitor 低成本规则等。2026-06-30 及以前的工作主要围绕 Helm API 的协议面、路由执行、admin 可观测性与自托管部署逐步成型：补齐 Gemini/OpenAI/Anthropic/Responses 双向转换、SSE 流式正确性、tool-call/JSON schema/思考参数保真、per-model reasoning effort、模型别名与能力/成本目录、provider fallback 与熔断语义、OAuth subscription providers、多账户池与 quota 处理、memory observe/inject/forgetting/admin/MCP、请求 payload 捕获与 request detail UI、API key 治理、admin 表格/过滤/分页/i18n、Docker/CI/release/deploy 验证，以及早期 Phase 0 的 Hono + SvelteKit static admin + Store 端口 + SQLite/Supabase 架构决策。更早细节不再逐条保留在本文件；需要精确背景时回查 git history。
