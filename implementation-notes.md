# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。完整原文可经 git history 回溯。

---

## 2026-11-12 · Seedance 入库素材授权（docs/06、Ark media）

- `asset://` 仅扩展 Seedance 输入。管理员通过现有 Basic/session 管理入口，将素材 ID、类型绑定指定 key/租户及实际静态 Ark 客户端凭证与 endpoint；ConfigStore 单表 CAS，无新迁移。每次创建读取授权，缺失 403、存储异常 503，均不调用上游。
- 公开文档未提供可用的推理 key 只读素材查询；因此采用明确标注的管理员同账号/项目及入库确认，不伪装成上游认证结果。凭证更换使旧授权失效，已授权且发送中的任务不因撤销召回。
- 新增 `/v1/videos/validate` 供持有者按同一请求无收费核对本地权限；不会生成或预留任务，也不能证明上游最终接受。显式 watermark=false、零创建重试和原有 HTTPS 行为保留。
- `pnpm release:prepare 0.30.85` 核对 Grok 1.0.77、Claude Code 2.1.322、Codex 0.167.2 及模型目录无变化。定向测试覆盖租户/key/类型/凭证隔离、CAS、撤销、损坏存储、服务重启及校验内存释放。CI 沿用 docs/g4-speech-media-ci-sql-review.md 已批准且未改变的隔离查询范围。

## 2026-11-12 · Ark 媒体失败诊断（docs/07、Ark media）

- 视频／3D 创建错误复用现有 `provider_attempts[].error_detail` 持久化，并写入带 Helm 请求 ID 的结构化事件。只保留状态、格式受限的上游错误码、已支持参数路径和请求 ID；不保存上游消息、响应头全集或素材地址，不新增数据库字段。既有请求正文保存策略不变。
- 保持客户端 `upstream_rejected` / `outcome_unknown`、零创建重试和原有任务归属语义。未知结果不能因新诊断字段变成确定失败；旧版丢失的错误不补造。
- 官方真人素材要求认证、授权和素材入库；当前 HTTPS 子集不支持 `asset://`。本次仅恢复错误诊断，不宣称人像口播已接通；没有新增付费生成。
- `pnpm release:prepare 0.30.84` 已核对 Grok 1.0.77、Claude Code 2.1.322、Codex 0.167.2 及模型目录无变化。CI 沿用 `docs/g4-speech-media-ci-sql-review.md` 中已完成三角色审查的未改动隔离合成查询；本次无 SQL 或迁移改动。

## 2026-11-12 · 受限 Key 显式选择已授权 lane（docs/04、06）

- 明确列在 Key `allowed_lanes` 中的已知 lane 可直接选择，无需 `allow_custom_model`，避免该固定入口触发付费分类 eval；继续使用 lane 内模型禁用过滤及预算降级。
- 保留其他 model、auto、空 model 以及无 lane 白名单的普通 Key 既有分类语义，不新增模型白名单或数据库字段。现有两把 lane 受限 Key 过去 30 天无遥测记录，不把该缺失当作不受影响的证明。
- Luma 本批后端固定 lane、max_output_tokens=512、最多 3 次文本与 10 句/2000 码点语音；正文长度与串行由其后端执行。生产 concurrency_queue_enabled 仍关闭，Key concurrency_limit 不宣称生效，不修改其他项目的全局 eval 或并发设置。
- `pnpm release:prepare 0.30.83` 已核实 Grok 1.0.77、Claude Code 2.1.322、Codex 0.167.2 及模型目录保持不变。CI 沿用 docs/g4-speech-media-ci-sql-review.md 已审查且未改动的隔离合成数据库查询范围；本次无 schema 或 SQL 改动。

## 2026-11-12 · G4 语音、时间戳与费用（docs/05、06、15）

- 线上验收补正（0.30.82）：百炼未传 sample_rate 时按官方默认使用 22050 Hz；MiniMax 仍为 32000 Hz，显式合法值保留。百炼不支持的采样率在连接前拒绝，HTTP 与 WS 一致。v0.30.81 已通过 MiniMax／百炼 Qwen-Audio HTTP、WS 原生时戳及百炼 ASR；百炼美元费用仍缺 FX，CosyVoice 3.5 缺匹配音色，不据此宣布全部验收完成。
- 增加显式 JSON 音频／原生时间戳结果，旧二进制调用兼容；MiniMax、百炼与豆包事件统一毫秒，缺值不补造。MiniMax 原生时长返回 durationMs。
- OpenAI gpt-transcribe／Deepgram 文件转写使用独立 provider；豆包 TTS 2.0 使用官方 SSE，WS 在 finish 后发送缓冲文本；豆包录音 ASR 请求 UUID 提交前持久化，未知提交只查询同一 ID。
- SQLite v58／Postgres v57 增加 media_spend_records，原子预留及幂等结算沿用现有预算表。价格需明确币种转换和计费上界；无依据时 spend-capped key 拒绝。同步 ASR 预算首批仅支持可本地验证时长的单声道 PCM16 WAV；未知结果保留预留，费用为价卡计算值，不冒充供应商发票。
- 供应商真实收费调用与 GPU 后备仍需验收，部署版本从目标服务 `/version` 核对。WhisperX 旧同步 adapter 已完成本地协议验证，调用后自动后备及新 compute.v1 的接入阻塞与字段交接见 docs/g4-speech-media.md。
- 发布准备：`pnpm release:prepare 0.30.81` 同步 Codex 0.167.2；Grok 1.0.77、Claude Code 2.1.322 与 Codex 模型目录内容不变。Codex 补丁仅将 Vertex AI 增量工具更新改为默认开启，不增加网关协议能力。完整 CI 既有跨表查询的三角色批准范围和独立测试库条件见 docs/g4-speech-media-ci-sql-review.md。

## 2026-11-11 · 上游 Providers 只读用量（docs/07、10、11）

- **界面对齐**：上游订阅沿用原 Providers 单表结构，提供商与账号同行，今日用量先于窄额度条，复用 connected／needs reconnect／parked 状态与响应式断点；全部 API Key 账号也合为一表。精确重置时间、点数、月度额度及重置明细保留在可关闭的详情面板，过期快照仍在行内提示。流量缺失显示未记录，实测零值保留。

- **接口与权限**：独立环境变量配置导出 token 的 SHA-256；下游后端持有原 token，浏览器沿用本机管理员权限。只开放汇总与订阅周期 GET，显式筛选展示字段，覆盖订阅账号与 API key 账号池；普通推理 key 无权读取全账号用量。
- **复用与失败语义**：抽出原有缓存读取逻辑，两端共享单表 Store 查询，不增加数据库或迁移。原 Admin 保持降级行为；机器导出遇读取错误返回 503，下游失败保留当前页面的旧快照并显示错误。
- **口径与限制**：订阅按查看者当天、API key 账号池沿用最近 24 小时；费用保留未知值。只读轮询不触发供应商拉取、OAuth 刷新或额度重置，采集仍依赖上游原有流量/刷新流程，超过五分钟明确标旧；刷新页面后不保留跨页面离线缓存。历史沿用保留期限及 approximate/partial 标识。

## 2026-11-11 · 每把 API Key 固定七天循环配额（docs/06、11、Portal）

- **周期与兼容**：新增可清空的 `budget_weekly_anchor`，非空按指定时刻每 168 小时重置；界面默认本地周一零点。起点向前、向后推算，未来起点不延迟启用；夏令时地区跨 DST 后本地钟点可能变化。原有滚动恢复配额保持原义，切回时恢复原余额；历史滚动用量不导入周计数。
- **计量与边界**：周配额任一维度用尽强制 429；请求次数在放行前原子扣除，失败尝试也计次，Token／USD 按实际用量事后结算，已放行的并发请求可能超出额度。计入入站认证时所属周期，不把跨周期完成的请求扣到新一周。未知价格沿用未计量语义；无 Token 计量的语音、实时及异步媒体入口拒绝带周 Token 上限的 Key，不按零用量放行。
- **持久化与查看**：两种数据库新增单表周计数，保留各周期记录；不依赖遥测保留期，无跨表关联。提高上限保留已用量，修改起点改变周期对齐。重启、改名称及轮换密钥保持计数。Admin 详情与门户按持久化计数显示本期已用／剩余和下次重置，独立于图表日期。
- **验证**：定向覆盖周期边界、并发次数预占、双数据库、重启／轮换保留、跨周期结算、协议身份透传与无法计量的媒体拒绝。真实网关 5 项 E2E 通过（新周配额 3 项、原滚动配额 2 项）；中文 Admin 1280px／390px 表单、编辑保存及持久化读回通过。shared/core/gateway 类型检查、Admin／Portal Svelte 检查、相关构建与定向 lint 通过。

- **发布准备**：`pnpm release:prepare 0.30.77` 同步 Codex 0.167.1，Grok 1.0.77、Claude Code 2.1.322 与 Codex 模型目录不变。Codex 补丁仅涉及默认关闭且限定 Bedrock 的增量工具声明；网关协议策略保持不变。已有历史迁移的关联 SQL 经性能、数据一致性、安全隔离三角色批准，仅用于独占合成 CI 回归；本次线上 SQLite v56 → v57 只新增列与计数表。

## 2026-11-11 · 请求页标识上游 API Key 并解释组织限制（docs/07、11）

- **展示决定**：`serving_account` 也记录 API Key 池的路由身份，原页面却统一写“订阅账号”。Admin 列表／详情按原池与账号代次解析现有记录，显示 Key 名称及末四位，并在最后失败的执行行显示账号。数据库记录保持原身份；轮换后历史请求仅显示账号名，避免把新 Key 的末四位用于旧请求。名称不可用时保留请求可读，不向页面返回凭据。
- **错误解释**：只匹配 OpenAI 的 `codex_byok_restricted_by_api_credit_promo` 代码，在摘要说明 OpenAI 将本次请求识别为 Codex BYOK 后按组织 API Credits 福利限制拒绝；不推断所有请求均失败或具体触发头，并提供官方计费设置链接；保留原始错误详情。此项改动不修改账号权益或池的错误重试语义。
- **验证**：174 项定向测试通过；shared/core 构建、gateway 类型检查、admin Svelte 检查及生产构建通过。桌面与 390px 窄屏浏览器预览使用该请求的只读记录，确认名称、末四位、失败执行行和中文解释均可见，无横向溢出。

## 2026-11-10 · OpenAI Luna 温度参数兼容（docs/04、05、07）

- **根因与决定**：生产请求 `ed51ea9c-8a47-47ad-87f0-54b12f1e3669` 在 Codex 熔断后回退到 `openai/gpt-6-luna`，上游以 `unsupported_value` 拒绝 `temperature: 0`。在现有 `requestCompatibility.openaiChat` 中增加显式采样参数排除项，仅为该别名配置 `temperature`；发送前去除并记录 `temperature_removed_for_model`，保留原始请求和其他别名的参数。
- **边界**：规则覆盖 Chat 及跨协议转换后的流式／非流式发送；不修改请求错误的终止语义，不因模型名推断兼容规则，不改 Codex 熔断状态。原请求正文未保留，验收使用相同参数的合成短请求，不重放用户内容。
- **验证与发布准备**：新增用例先复现 `temperature: 0` 未移除，再通过修复；定向 265 项通过，shared/core 构建、gateway 类型检查与定向 Biome 检查通过。`pnpm release:prepare 0.30.75` 成功，Grok 1.0.77、Claude Code 2.1.322、Codex 0.167.0 及同 tag 模型目录保持不变。

## 2026-11-10 · Helm 级联保留客户端 User-Agent（docs/04、05、06、10）

- **根因与决定**：官方 Grok CLI 的 `grok-shell/1.0.77 (macos; aarch64)` 能被准入规则识别；Chat 转 Responses 时原始 Header 丢失，Node 默认 UA 导致下游 Helm 返回 `client_not_allowed`。在网关入口按请求保存原始 UA，在 `type: helm` 的最终 HTTP 发送和 Responses WebSocket 握手边界恢复；覆盖协议转换、原生、流式、媒体、重试，缺失 UA 不冒充已知客户端。
- **协议与身份边界**：`helm` 按 `target_provider_protocol` 选择 Chat、Responses、Anthropic 或 Gemini 适配器。指向 Helm 的旧 Anthropic/Gemini 配置应将 `type` 改成 `helm` 并保留目标协议和 base URL。Realtime sideband 用当前 upgrade 请求的 UA；上游凭证、入站客户端权限和直连订阅的厂商身份规则保持原契约。UA 是客户端声明，不是认证凭据。
- **验证**：完整 Chat HTTP 链路验证流式/非流式、上游密钥替换和 body 字段不能冒充 Header；并发请求、四类协议、图片、Responses WS 与实际 Realtime socket 验证身份隔离。定向 670 项通过，shared/core 构建和 gateway 类型检查通过；独立只读审查未发现剩余 P0/P1。
- **发布准备**：`pnpm release:prepare 0.30.74` 和发布快照检查通过；Grok 1.0.77、Codex 0.167.0 保持不变，Claude Code 同步至已完成静态协议增量审查的 2.1.322，原字段白名单不变。

## 2026-11-09 · API Key 临时禁用与启用（docs/06、11）

- **状态决定**：保留既有 `disabled=true` 的不可恢复吊销语义，新增独立 `suspended` 标志。管理员通过原 PATCH 接口禁用或启用；不改变密钥、配额、身份与历史，已吊销及内部系统 Key 不允许切换。
- **持久化与鉴权**：SQLite v56、Postgres v55 为旧记录补默认 false，保留既有吊销。HTTP、原生协议、实时连接与 MCP 的新鉴权均拒绝临时禁用 Key；管理重放选用仍有效的身份。复用 updateKey 清理本进程缓存。
- **边界**：不终止已接收的请求或已建立的连接；共享 Postgres 的其他网关实例按已有鉴权缓存 TTL 感知状态，默认最多 30 秒。页面区分启用、已禁用、已吊销，吊销确认明确不可恢复。
- **发布准备**：v0.30.73 已执行 `pnpm release:prepare 0.30.73`；官方稳定快照仍为 Claude Code 2.1.319、Codex 0.167.0、Grok 1.0.77，无新增客户端协议变更。

## 更早历史总览

2026-11-08 Codex 出站 Header 一致性：默认版本由发布快照管理，保留客户端兼容规则；完整记录见 Git history。

2026-11-08：官方 Claude API 清理 Agent SDK system 身份并保留 OAuth／第三方行为；完整记录见 git history。

2026-11-07：官方 Claude API 清理客户端身份、ZenMux 精确别名计价与金额字段验证；完整记录见 git history。

2026-11-06：Claude 账号设备、会话及版本一致性与边界验证；完整记录见 git history。

2026-11-01：接入验证、客户端连通性与请求结果摘要，完整记录见 git history。

2026-10-31：接入验证、账号解释、速度策略与可选出站隐私，完整记录见 git history。

2026-10-29：OpenAI／Claude API 密钥池、月度恢复及逐 Key 测试，完整行为与验证见 git history。

2026-10-28：Sonnet 5.5 强制工具选择按能力过滤，完整行为与验证见 Git history。

2026-10-27：GPT lane 去版本化并按优先档位排序，真实模型、价格、能力与 fallback 顺序不变；完整记录见 git history。

2026-10-27：恢复 Sol 为默认路由，保留显式 Terra lane；Remote 与 8.4 分别恢复对应链，账号权限与流式约束不变，完整记录见 git history。

2026-10-27：新增 GPT-6.1 Terra 能力、价格与显式模型支持，初始默认路由随后恢复 Sol；订阅价格仅作 API 等价估算，完整依据与限制见 git history。

2026-10-26：Codex 完整历史可在发送前恢复不可用 turn-state，保留账号、会话和工具配对边界；详见 git history。

2026-10-26：Codex 容量拒绝只在首输出前同账号有界重试，冷却返回 Retry-After，断流保留结构化证据；不明结果禁止重放，完整记录见 git history。

2026-10-26：Codex 入站只匹配完整产品标记，版本不参与准入，未知或冒充标记继续拒绝；完整记录见 git history。

2026-10-21：DeepSeek custom 工具映射按响应隔离保存，旧状态拒绝并通过 1012 恢复完整历史；详见 git history。

2026-10-20：图片串联保留客户端身份、明确拒绝不重试；Images 固定标准 Responses 工具路径，完整记录见 git history。

2026-10-15：订阅时区只改已验证环境字段，保留工具／正文语义、账号代理和续接隔离；完整记录见 git history 与 docs/subscription-timezones.md。

2026-10-14 模型目录超时与 Helm 串联握手的边界保持原有约定；完整记录见 git history。

2026-10-14：原币媒体价卡覆盖 25 个模型、57 个分档，保留原币和地域语义，未扩展结算或汇率换算；完整记录见 Git 历史及 docs/media-pricing.md。

2026-10-14：阿里与 MiniMax 媒体任务保留异步 operation ID、权限与下载边界；真实验收修正 Qwen3 OSS HTTPS 和固定 IP 连接，详见 Git 历史及 docs/media-provider-task-tracker.md。

2026-10-14：Ark 多媒体按提供商契约处理图片/视频/语音输入、费用与异步任务，任务身份和数据边界不变，完整实现决定见 Git 历史。

2026-10-13：API key 客户端策略在鉴权后按入口校验，模型发现按家族过滤；损坏策略拒绝且保留账号、权限与续接隔离，UA 不作为可信身份，完整范围与决定见 Git 历史。

2026-10-12：Grok 价格目录按官方模型卡区分缓存与高上下文档位；媒体费用与历史重计价仍按既有边界处理，完整记录见 Git 历史。

2026-10-12：Grok 固定首尾帧与声线组合只扩展明确支持的参数约束，不推断上游账号支持；完整规格与客户端快照决定见 Git 历史。

2026-10-10：Claude 套餐只取官方 profile 并缓存，凭证变化失效；该展示不影响权限和调度，完整记录见 Git 历史。

2026-10-09：Claude 协议与 OAuth 账户边界的完整决定保留在 Git 历史中；现有协议、凭证和权限约束继续有效。

2026-10-07：发布时同步订阅客户端版本，保留官方版本检查、可追踪快照及发布前验证（完整记录见 Git 历史）。

2026-10-01：Helm 级联握手协商结构化 before-send 恢复，保留冷却时间与不明结果禁止重放边界；完整记录见 Git 历史。

2026-09-30：Codex 连通性测试复用账号运行配置、客户端版本和持久身份，合成端点验收通过；详见 Git 历史。

2026-09-30：Codex 账号详情只展示周额度周期，完整背景见 Git 历史。

2026-09-30：GPT-6.1 Sol 接入与 Sol 配置迁移；旧 GPT-6 Sol lane 指向新模型，具体协议与发布证据见 Git 历史。

2026-09-29：Claude Sonnet 5.5 接入；完整变更与验证见 Git 历史。

2026-09-28：原生透传取消模型准入名单，兼容规则归入 capabilities 配置，保留边界校验；完整记录见 git history。

2026-09-28：GPT lane换代、线上配置保留及别名回收；完整部署边界见git history。

2026-09-28 的 GPT-6 Sol / Luna 接入与目录兼容记录已归档于 Git 历史。

2026-09-27：原生辅助接口兼容、重放边界和计数路由权限补修；完整记录见 git history。

2026-09-26：Admin UI 走查整改、DeepSeek 零余额 key 验证兼容与请求详情路由导出修复；完整记录见 git history。

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


2026-09-27 原生协议、缓存与重放边界修复保留发送后结果不明禁止重放、provider 字段保真及权限检查；完整记录见 git history。

2026-10-18 的订阅刷新期限与恢复规则已归入历史，完整记录见 Git history。

本次归档：2026-11-04 · 管理界面与门户的窄屏布局（docs/11、Portal）。完整内容见 git history。
