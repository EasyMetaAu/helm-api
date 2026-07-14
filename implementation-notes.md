# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-07-14 · 丢弃 Codex 空 secondary 配额占位窗口（OAuth quota / Admin providers / reset credits，docs/04/11，原则 3/5/7）

- **生产根因**：Codex 部分账号的响应头会同时返回真实 `primary + windowMinutes:10080` 周窗口，以及 `secondary + usedPercent:0 + 无 duration + reset-after:0`。后者只是空占位，但 header parser 将其作为配额写入；latest-wins snapshot 随后覆盖完整 PULL 数据，Admin 又把未知时长的 positional key 翻译成“次窗口”，造成看似存在第二个额度且 7 天用量消失。
- **三层防御**：header parser 在入库前丢弃“0% + 无时长 + 截止采集时已重置”的窗口；Admin cache-only API 与 Providers 页面用 snapshot 自己的 `capturedAt` 过滤旧版本已写入的同类脏数据，部署后无需等待新请求或人工清库即可恢复展示。未来重置、非零用量或带真实 duration 的窗口继续保留，避免误删刚开始的新周期与 legacy 数据。
- **周额度权威**：周窗口改为集合级选择：账号级 `windowMinutes >= 10080` 的明确时长窗口优先；只有整组没有明确周窗口时，才兼容使用非零的未知时长 `secondary`。model-scoped 窗口仍排除。Admin、自动重置和 reset-credit 幂等 guard 共用该选择，空 positional 数据不能再覆盖真实周用量或 reset marker。
- **验证**：TDD 定向覆盖 live header 形态、durable cache 旧快照、Providers 标签、明确周窗口优先、legacy fallback 与 reset-credit guard；6 files / 219 tests 全绿。

## 2026-07-14 · Subscription Providers 改为缓存优先与全局串行刷新（OAuth Admin / provider observability，docs/04/11，原则 1/3/6/7）

- **性能根因**：Providers 首屏过去并行请求 status、usage、quota；status 会刷新过期 token 并逐账号发现模型，quota 会逐账号拉取上游额度、写 snapshot、同步 cooldown 并清理 orphan。慢代理、上游限流或账号数增加会把页面打开直接绑定到外部网络，刷新按钮和自动刷新也会重复制造同一批工作。
- **缓存读边界**：新增单次 `GET /admin/api/oauth/overview`，只读取本地 token/settings、进程内模型/额度 snapshot、durable quota 与当日 usage；不得刷新 token、发现模型、请求 quota、删除 orphan 或修改 cooldown。原 `/oauth`、`/usage`、`/quota` 同样改为 cache-only，保持兼容但不再隐式产生上游流量；无需数据库迁移。
- **刷新队列**：显式 `POST /admin/api/oauth/refresh` 立即返回 `202`，由 Gateway 进程级 coordinator 保证全局最多一个 active job；并发点击合并到同一 job，成功或失败后冷却 60 秒。job 内按账号串行刷新 token、模型目录与 quota，显式刷新可绕过正/负 TTL 缓存；Anthropic/Codex 模型发现增加 10 秒硬超时，避免死代理长期占住唯一 worker。
- **失败与旧数据**：任一账号的 quota 超时、空/非法窗口或持久化失败会把 job 标为 `failed` 并记录安全错误摘要，但不会删除 last-known-good snapshot；其余账号仍继续串行刷新。页面展示 queued/running/succeeded/failed、最近成功时间与 cooldown，手动点击只入队一次并 cache-only 轮询，定时自动刷新永远只读缓存。
- **验证**：TDD 覆盖 cache-only 首屏、20 次并发点击合并、账号刷新最大并发 1、失败保留旧 quota、force cache bypass、模型发现 timeout、前端单请求加载、手动/自动刷新分流与多语言状态文案；workspace 357 files / 5775 tests、typecheck、Biome、build 与 Admin check 全通过。

## 2026-07-14 · Avoid Waste 在 provider 池内限制 reset-credit 偏置（OAuth provider selection，docs/04/11，原则 3/5/6）

- **生产根因**：`openai-codex` 的四个 Plus/Pro 账号已正确合并进同一 provider pool，套餐名没有参与分池或筛选；但 reset credit 的虚拟周容量乘数为 `10`，单个 credit 的加分远高于自然周窗口。生产中 31% 已用、3 credits 的 Pro 账号因此持续压过 2% 已用、0 credits 的 Plus 账号，形成看似按套餐分组的长期偏置。
- **评分边界**：同一 provider 内继续按账号优先级、模型 entitlement、可调度/限流状态形成候选集；Avoid Waste 的主分数仍来自即将重置的真实 5h/周额度。reset credits 保留为弱的可恢复容量信号，每个 credit 只贡献完整自然周窗口加权分数的 5%，可打破接近分数，但不能压过明显更多的真实即将过期额度。Plus/Pro/Team/Business 等套餐标签仍只用于身份与配额展示，不进入选择逻辑。
- **验证**：TDD 使用生产比例覆盖同一池内 `2% + 0 credits` 对 `31% + 3 credits`，并保留真实额度相同情况下 credits 参与选择的回归；定向 pool 测试、typecheck、lint 与 build 作为交付门禁。

## 2026-07-13 · Responses 工具结果的 multipart 文本使用 input_text（Protocol translation / provider execution，docs/05/07，原则 3/5/8）

- **生产根因**：请求 `7963c4fa-c0ea-436f-aa4d-af0beb41615e` 从 Anthropic fallback 到 Codex Responses 时，数组形式的 `tool_result` 被编码为 `function_call_output.output[].output_text`；该 item 属于 Responses 请求输入，上游只接受 `input_text`，因此返回确定性 400 `invalid_request`。
- **修复边界**：provider 专用 Chat→Responses 与共享 IR→Responses 两条路径统一把 multipart 工具结果文本编码为 `input_text`；字符串工具结果仍保持字符串，`input_image` 与 `input_file` 保持原 wire shape。助手消息正文继续使用 `output_text`，不扩大成全局 content-part 改写，也不改变 `invalid_request` fallback 语义。
- **验证**：TDD 红灯同时覆盖 provider、共享 transformer 与真实 Anthropic `tool_result`→Codex Responses 链路；定向 Vitest 绿灯为 2 files / 274 tests。

## 2026-07-13 · Codex 周配额按真实窗口时长识别（OAuth quota / Admin providers / reset credits，docs/04/11，原则 3/5/7）

- **生产证据与根因**：生产 `oauth_quota` 中四个 Codex 账号都出现 `primary + windowMinutes:10080`，截图中的唯一窗口虽显示 `5h`，重置倒计时却是 `6d 22h`。上游不同套餐不再保证 `primary=5h / secondary=7d`，Admin 的位置硬编码因此把真实周配额错标为 5h；同一假设还会让手动/自动 reset-credit 误报周快照不可用。
- **统一判定**：账号级 Codex 周窗口以 provider 报告的 `windowMinutes >= 10080` 为权威；只有旧 header 快照缺少 duration 且窗口有真实用量时才兼容回退到 `secondary`。带非默认 `limitId` 的 model-scoped 窗口绝不当作账号周配额。Admin 标签同样时长优先（300m→5h、10080m→Weekly）；有意义的缺时长窗口显示中性的 Primary/Secondary，空的已过期占位窗口则直接过滤。
- **账号边界**：规则完全 plan-agnostic，覆盖 Codex Plus/Pro/Team/Business/Enterprise/Edu 等实际窗口形态，不按套餐名维护分支。Claude 继续使用其 5h/7d keys；Copilot、SuperGrok 与普通 API-key provider 没有可验证的同类 Codex reset-credit 周窗口，不套用本规则或伪造数据。
- **验证**：共享 predicate、Admin 单周窗口、reset-credit UI、自动重置与持久 guard 均增加 `primary + 10080m` 回归；同时覆盖 `secondary + 300m` 不误判、缺 duration 的 legacy fallback，以及 model-scoped 周窗口隔离。

## 2026-07-12 · Grok premium fallback 与 Composer 评估边界（Routing / provider evaluation，docs/04/07，原则 2/3/5/6/7）

- **移除 official OpenAI 付费 lane 候选**：所有 `openai/gpt-*` 从 shipped lanes 删除，只保留 provider、能力与价格定义供显式 custom-model 使用；GPT vendor lanes 在 Codex subscription 不可用时进入通用订阅/静态 fallback，不再自动触发 official OpenAI 账单。`gpt-image` 改由 ZenMux relay 的 `gpt-image-2` 领衔，official Images API 同样不再被 lane 自动选择。
- **Vision 订阅限定**：`vision` 改为 Codex Terra → Grok 4.5 → Claude Sonnet 5 → Claude Opus 4.8，全部为订阅 provider；`zenmux-vertex/gemini-3.5-flash` 从该 lane 移除，但 dedicated `gemini-flash` vendor lane 与底层 provider/catalog 保留供显式 Gemini 请求。链使用 concrete aliases，不再隐式展开 `premium`。
- **路由调整**：`premium` 在 Claude Opus 前加入 `xai/grok-4.5`，使已连接且健康的 SuperGrok 账号吸收原本进入 Opus 的 fallback 流量；未连接、park 或 provider failure 继续 fail-open。Haiku 改为 Anthropic OAuth → economy，不再自动使用 ZenMux Haiku；GPT-5.5 改为 Codex GPT-5.5 → premium，不再自动使用 `zenmux/gpt-5.5`；GPT-5.4 继续由真实 Codex GPT-5.4 领衔。`zenmux-anthropic/claude-opus-4.8` 同样只从 lanes 移除，所有被移除的 provider/catalog 定义仍保留供显式调用。
- **Composer 边界**：真实 A/B 暴露 200 + stop + 空正文与质量不足后，不进入 economy，也不再保留独立 canary lane；底层 OAuth 模型发现与 transport 兼容仍保留，避免把一次路由决策扩大成 provider 协议删除。
- **真实 A/B**：本地 Docker 使用同一账号、总并发 2，Composer 与 Grok 4.5 各执行 30 个相同任务，覆盖 exact/factual/coding/long-context/speed/tool。Composer HTTP/模型命中 30/30、SSE `[DONE]` 30/30、工具参数 4/4、长上下文 6/6、长输出 TPS 中位数约 197，但事实仅 2/5、编码仅 1/4，6 次出现 200 + stop + 空正文，总质量 24/30（80%），可见 TTFT p95 约 1.59s；未达到 economy 晋升门槛。Grok 4.5 模型命中 29/30、质量 28/30、工具 4/4、长上下文 6/6、长输出 TPS 中位数约 138，但出现一次 504，成功率 96.7%、可见 TTFT p95 约 22.9s；速度达标但可靠性未达到 99%，因此只保留 premium fallback，不进入 balanced 或 primary。
- **Docker 证据**：授权恢复后账号 `healthy:true` 且同时发现 `grok-4.5` / `grok-composer-2.5-fast`，真实 quota PULL 返回 `7d` 周窗口；三条预检分别真实命中 Composer、direct Grok 和 premium→Grok。授权前 premium 的 Grok 候选以 `provider_unavailable` 跳过并继续由 ZenMux Opus 成功，证明未连接边界 fail-open。测试 key 已全部禁用；容器限制 2 CPU / 2 GiB，结束时 healthy、restartCount 0。
- **Lanes 模型选择器修复**：xAI 自动模式虽然能通过账号发现参与真实路由，但网络无关的 `/admin/api/models` 投影缺少 xAI picker fallback，导致选择器无 `xai/*` 建议。现将已验证的 `grok-4.5` 与 `grok-composer-2.5-fast` 加入仅供已绑定账号使用的 Admin 投影 fallback；它刻意不进入 core `CURATED_OAUTH_MODELS`，所以真实路由在 xAI `/models` entitlement 发现失败时仍 fail-closed。手动模式可按账号缩窄 allowlist，未连接账号不会凭空出现。

## 2026-07-12 · SuperGrok 周配额使用现有 OAuth 读取私有 gRPC-Web credits（OAuth subscription / Admin providers，docs/04/09/11，原则 3/6/7）

- **协议与认证证据**：grok.com 当前通过 `grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` 读取消费者订阅 credits；官方 Grok CLI 同时暴露独立的 `/v1/billing` 私有接口。真实账号 A/B 验证确认 Helm 现有 `auth.x.ai` access bearer 可直接调用 credits RPC（无认证为 gRPC `UNAUTHENTICATED`，同一 Helm bearer 成功），因此不保存浏览器 Cookie、不引入 Management Key，也不申请额外 scope。token refresh 和请求继续复用账号代理。
- **额度语义**：只把 `credit_usage_percent` 与 `current_period.type = WEEKLY`、有效 start/end 归一化成账号级 `7d` window；缺省 proto3 percentage 按 0，超过 100 的上游值原样保留。`/v1/billing` 的 `monthlyLimit/used` 属于另一套月度 billing 语义，绝不冒充周配额；public `api.x.ai` credits 也不参与 SuperGrok quota。
- **安全与失败语义**：请求固定为 unary gRPC-Web、禁用 redirect、8 秒 timeout、1 MiB Content-Length 与流式双重上限；响应必须严格满足单个 data frame、单个最终 trailer、唯一 `grpc-status: 0` 与 EOF，并校验 protobuf wire type。周周期除 enum 外还必须具有 6–8 天的实际跨度且当前有效；malformed、stale、oversized、非周周期或上游失败均进入 5 分钟正/负缓存并 fail-open，保留旧 snapshot 或显示 `—`，不得影响推理请求。同名账号重连或 logout 成功后递增账号 cache epoch 并删除 durable snapshot；旧身份的并发 PULL 返回时不得写回缓存或存储，避免新身份继承旧 quota/cooldown。Logout 即使在 token 删除后发生设置/配额清理失败，也必须按 durable token truth 重建 live pool，不能让内存 token 继续路由。
- **路由与存储**：成功 PULL 写入 `source: xai`，同步 durable quota store 与 live pool；100% 账号级周窗口沿用既有 cooldown 规则停到 reset，低于 100% 只作为 `low_risk` / `use_expiring` 的软评分信号。SQLite/Postgres 在 quota PULL 前先收到 xAI 429 时，synthetic cooldown row 也必须标记 `xai`，不能伪装成 `codex-headers`。无需数据库迁移，`source` 底层仍为 text。
- **验证**：parser/shared/Gateway route/seam/SQLite/Postgres 定向测试共 197 个通过（含严格 trailer、周期跨度、并发身份切换、durable quota 生命周期与 logout partial-failure 回归）；真实已连接 xAI 账号通过现有 Helm bearer 返回并解析出 `7d / 0% / 10080m` 与准确 reset timestamp。workspace build、typecheck、Biome 全通过。完整 355-file Vitest 并发运行中 14 个无关 PGlite case 因 15 秒资源竞争超时；对应 4 个失败文件随后单 worker 重跑 161 个测试全部通过。

## 2026-07-12 · SuperGrok/X Premium OAuth 实验性订阅 Provider（OAuth subscription / Responses / Admin providers，docs/04/09/10/11，原则 2/3/6/7/8）

- **官方边界**：xAI 官方开发者 API 仍使用充值后的 `XAI_API_KEY` 与 `api.x.ai/v1`；SuperGrok 是独立的消费者订阅。官方 Grok CLI 支持 browser/device-code OAuth，公开 OIDC discovery 位于 `auth.x.ai`，但没有第三方 client registration，也没有承诺 `cli-chat-proxy.grok.com/v1` 是稳定的第三方合约。
- **安全决策**：按用户决定不设置额外 feature flag，Provider 默认在 Admin 暴露，连接后立即参与模型目录与路由；UI 和文档仍明确标记 Experimental、仅限账户持有人个人自托管评估。不得把订阅凭证共享、转售或作为多租户公共后端；生产支持路径仍是 xAI API key，或向 xAI 申请 Helm 专用 client 与书面授权。
- **协议实现**：clean-room 参考 MIT OpenClaw/OpenCode：OIDC discovery 结果只接受 HTTPS `x.ai`/`*.x.ai`，所有 discovery/device/token/refresh 请求禁用自动重定向，避免 `307/308` 把 device code 或 refresh token 带到非信任域。RFC 8628 device code 首次 poll 前等待上游 `interval`，`slow_down` 每次增加 5 秒，Admin/UI 透传 interval/expiry 且过期不再请求；refresh token rotation 保留未轮换旧 token，敏感响应正文不进入错误或日志。token 继续使用 Helm AES-GCM OAuthTokenStore、singleflight refresh、账号代理和 credential-failure 机制。
- **执行与目录**：订阅 token 只发送到受信任的 xAI/Grok 资源服务器，推理使用 `https://cli-chat-proxy.grok.com/v1` 的 generic OpenAI Responses executor，不能继承 ChatGPT/Codex identity headers。对照本机官方 Grok CLI `0.2.93` 的运行配置与真实成功请求，推理必须发送 `X-XAI-Token-Auth: xai-grok-cli`、`x-authenticateresponse: authenticate-response`、`x-grok-client-version: 0.2.93` 和按最终 wire model 生成的 `x-grok-model-override`；缺 client version 时上游稳定返回 426。默认版本随 Helm live smoke 维护；上游先提最低版本时可用严格 semver 的 `HELM_XAI_GROK_CLIENT_VERSION` 临时恢复，非法值在启动阶段 fail-closed。该代理只接受 SSE，因此 Helm 上游固定 `stream:true/store:false`：客户端非流式 Chat/Responses 在内部聚合 SSE，对外合同不变；Chat 的合法 `response.incomplete` 按流式/非流式一致映射为 `finish_reason:length`，native Responses 非流式仍只接受 `response.completed`。`store:false` 的 response id 无法用于服务端 continuation，真实第二轮返回 404 not found；Helm 因此在网络前把 `previous_response_id` 明确拒绝为 400 `invalid_request`，调用方必须发送完整会话 input，不能再退化成误导的 502。Chat 转 Responses 保留 system/developer 原生 input role（Composer 真实 precedence 需要这一形态），并保留 response format、tool strict/parallel、Responses-only control 字段与多模态 parts；xAI 自身未验证的 JSON/vision/audio/document 仍由 capability filter fail-closed。模型从账号 `/models` 动态发现，禁用 redirect，并以 30 秒 timeout、外部 abort 和 1 MiB Content-Length/流式双重上限约束；结构化目录行只接受 `responses/chat/language`，明确的 image/embedding/未知 backend fail-closed；发现失败返回空，不用 `api.x.ai` 公共目录伪造订阅 entitlement。仅为真实验证的 Grok 4.5 / Composer 声明 tools、stream 与 500k/200k context；Grok 4.5 接受显式 effort，Composer 的显式 effort capability 标为 unsupported 并在出站前剥离；output ceiling 未知并保持 `maxOutputTokens:null`。初始实现时尚未确认 SuperGrok quota 私有合同；后续发现与接入见上方 credits 条目。SuperGrok 仍无公开每 token 订阅价格，因此 usage 会记录而 `cost_usd` 保持 `null`。
- **Admin 与验证边界**：device-code API 同时返回服务端时钟，浏览器用相对 TTL 换算本地 deadline；poll 错误通过稳定 code 贯穿 Gateway/Admin，expired/denied/failed 进入明确终态，停止等待动画并提供重新开始。单元/组合测试覆盖 discovery allowlist、模型 backend 过滤、device interval/expiry/slow_down、refresh rotation、加密持久化、默认 Provider 目录、能力与空 pricing、generic Responses 互译和 xAI request contract。真实 Docker 双模型矩阵覆盖 Chat/Anthropic/Gemini 流式与非流式、native Responses 默认 instructions、developer precedence、strict tool call + tool-result 往返、Composer effort 剥离、continuation 清晰 400、JSON/vision 422 fail-closed；浏览器走查覆盖桌面与 390px 宽度、xAI 警告及 Enterprise 字段隐藏。Claude CLI Opus 在不设 budget 上限的两轮最终 review 中先提出 4 个 P3（model header 源校验、device 分支、结构化 poll error、es/pt locale guard），修复后第二轮结论为 `CLEAN`。

- **后续能力与成本更新**：上方初始实现中“vision 未验证 / `cost_usd=null`”的边界已被真实协议证据替代。Grok 4.5 原生 `input_image` 已通过四种入口验证并启用 vision；Composer 对同一 wire 返回 400，CLI 表面的看图来自 `grok-build` 先生成文字描述，因此继续关闭。按用户决定，Grok 4.5 使用公开 API 等价费率 input `$2/M`、cache read `$0.50/M`、output `$6/M` 参与 telemetry 与 API-key budget；这不是订阅账单，且当前固定 catalog 对 >200K 的 `$4/$1/$12` 档位会低估 50%。Composer 没有可验证公开费率，继续保持 `cost_usd=null`。

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

## 历史条目摘要（最新要点）

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
