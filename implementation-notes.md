# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

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

## 2026-11-08 · Codex 出站客户端 Header 一致性（docs/04、05、07）

- **决定**：订阅 provider 的 `User-Agent`、`version`、`originator` 由网关运行时生成；原生客户端不再覆盖，HTTP、SSE、compact、WebSocket 握手与认证重试使用同一规则。无配置时采用签入的稳定版本，消除 `0.0.0` 占位值。
- **版本边界**：复用账号目录运行时已验证的版本，不把入站声明的更高版本当成协议升级，也不新增按账号保存最大客户端版本的状态。与 Claude 的版本上限持久化方式不同，避免版本标记先于模型目录和协议能力升级。
- **限制**：入站客户端准入仍看到真实原始 Header；业务会话、缓存键、turn state 与 `previous_response_id` 的归属规则不变，跨账号相同业务标识仍可能被关联。Header 一致不能证明真实单人使用，也不构成防封保证。
- **出站记录**：通过请求级回调在最终 HTTP 发送／WS 握手边界提取允许字段；复用连接记录实际握手快照，不冒充本轮重发 Header。现有 `provider_attempts[].outbound_requests` 保留最近 16 次观察及连续序号，覆盖转换、原生、重试和直接 compact；不新增表，沿用遥测权限和保留期。账号引用复用已有安装标识，原始凭证、邮箱、账号 UUID、会话／turn state 值不保存；会话仅保存来源和存在性，与现有业务会话记录关联。
- **验证与发布准备**：身份、审计、路由投影、compact 和 Responses 路由共 854 项定向测试通过；shared/core 构建及 gateway 类型检查通过。v0.30.72 已执行 release:prepare，稳定快照为 Claude Code 2.1.319、Codex 0.167.0、Grok 1.0.77。

## 2026-11-08 · 官方 API 清理 Agent SDK 身份变体（docs/04、05）

- 线上同账户 Sonnet 5.5 对照确认：仅加入独立的 `You are a Claude agent, built on Anthropic's Claude Agent SDK.` system 文本即可触发官方 HTTP 400 余额错误；移除后正常。错误不等于已经查实账户余额，上游内部判定原因未知。
- 官方静态 API Key 出站补充精确识别这句 SDK 身份，复用既有副本清理；JSON、流式和 token 计数一致处理。业务文本中引用该句仍保留，OAuth 与第三方 relay 行为不变，未更改账户暂停策略。
- 先复现 4 项失败再实现一行判定，相关身份、协议与账号池 201 项测试通过。发布准备执行 `pnpm release:prepare 0.30.71`，Claude Code 2.1.319、Codex 0.167.0、Grok 1.0.77 快照不变。

## 2026-11-07 · 官方 Claude API 身份边界与 ZenMux 成本（docs/04、05、07、11）

- 官方 Anthropic API Key 路径只删除独立的 Claude Code 身份和 billing system 标记，以及专用 CLI Header／OAuth beta；业务 system、metadata、签名历史和工具内容保持原样。OAuth 订阅身份校验和第三方 relay 透传不变。清理使用请求副本，并记录 mutation ledger。
- ZenMux 的点号模型 ID 保持原样，定价按完整 provider alias 查找，不跨供应商套价。新增三个 5.5 价格条目、配套能力元数据及已确认的 global=1；其他未知地区继续返回未计量。
- Anthropic 金额字段在用量边界统一接收非负有限数字或十进制金额字符串，流式按最后有效累计金额取值，不相加；优先使用上游金额，再按目录估算。原始响应保持不变。
- API 账户额外保存经凭据清理的上游错误说明，旧记录可缺省；测试恢复或更换 key 后清空旧说明。未改余额故障的暂停策略，也未执行历史成本重算。
- 验证：353 项定向单测／集成检查、1 项 API 账户管理浏览器流程通过；shared/core 构建、core/gateway/admin 类型检查及 admin 构建通过。改动文件 Biome 无错误，保留既有警告。独立只读审查无 P0/P1 发现。
- 发布准备：执行 `pnpm release:prepare 0.30.70`；Codex 稳定快照升至 0.167.0，同 tag 模型目录内容未变，Claude Code 同步至经增量静态审查的 2.1.319，Grok 1.0.77 保持不变。协议头白名单不变，审查证据见 `docs/claude-protocol-safety.md`。另 24 项版本／模型兼容定向测试通过。

## 2026-11-06 · Claude 账号设备、会话与版本一致性（docs/04、05、06、07）

- **身份决定**：先取得凭证并校验原始非空账号声明，再用已认证 UUID 关联持久档案；缺失 UUID 或档案损坏拒绝发送。通过既有 `config_kv` 单表 CAS 固定设备和最高版本，无新增表；同表记录旧设备首次归属，防止内部账号名称复用时不同 UUID 共用设备。首次沿用旧网关账号设备值，随后不受账号重命名、重启或加密密钥轮换影响；旧原生客户端设备透传会统一到该档案。
- **会话决定**：以账号、经鉴权的租户/API key 所有者和业务会话派生上游会话；A→B→A 回到原 A 会话，不把账号全部会话合并。无会话标识时使用请求级身份，计数和重试保持一致。原生正文重新序列化，body/Header 同步且业务内容不原地覆盖。已知会话别名、Agent/父 Agent、Prompt 与请求 Header 按各自生命周期映射，保留父子引用和重试关系，幂等键保持不变。
- **版本与入口**：取内置稳定版本、持久版本及有效入站版本最大值，原子保存且不降级；同步 Claude UA/billing。按部署方要求将两处入口规范化为 `cli`，维持 OAuth 订阅鉴权；这不改变真实非交互执行，也不代表实际软件或协议已经升级。SDK、Node、OS、协议版本及保护字段不参与版本合并。
- **边界与限制**：显式异账号声明仍拒绝，不改签名、opaque 历史、工具配对、agent 父子关系或原有失败重试规则；不能保证任意上游状态跨账号续接。设备档案必须随配置数据库备份。身份和标记一致不证明真实单人/单设备，不构成防封保证；完整约定见 `docs/claude-protocol-safety.md`。
- **本地验证**：8 个定向测试文件共 507 项通过，覆盖网关固定账号／账号池、原生与转换请求、流式、计数、401 重试和身份拒绝。core 构建、core/gateway 类型检查及改动文件 Biome 检查通过；尚未提交、执行远程 CI 或部署。
- **额度切换复核**：新增 JSON/SSE 两项真实 provider 客户端加模拟 HTTP 的账号池测试，确认 balanced 策略下 A→A→A(429)→B→B，B 使用自己的凭证、UUID、设备、会话、版本及关联 Header，业务消息保持一致。现有池仍可能因速度／容量／其他故障重新选号，且显式账号 UUID 继续严格绑定；本次出站身份修复没有实现“只在额度耗尽时换号”的全局调度约束。

## 更早历史总览

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
