# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-10-14 · 原币媒体价卡配置（docs/07、10）

- **配置落地**：`config/pricing.yaml` 为全部 25 个 Ark、百炼、MiniMax 模型配置 57 个正式计费分档；使用 `pricing.media`，保留原币种、地域、wire model、计费方向/单位、档位条件、免费数量、条件声线费、官方来源与核验日期。严格校验嵌套字段；旧配置兼容，手动价卡整体覆盖生成价卡。
- **目录生效**：运行时 catalog 与 `/v1/models` 的具体模型项返回完整价卡。普通 lane 不暴露内部价格；原有 `*Usd` 字段不会接收人民币价格。万相七折作为限时促销单列，官网未公布结束日期，不能视作永久价格。
- **边界**：本次完成模型价格配置与目录下发；不扩展实际用量计算、异步任务结算、金额预算预留或汇率换算。媒体费用遥测仍可为 null，spend-capped key 仍按原规则拒绝；重复 GET 不产生扣款。真实账单以供应商为准。详见 `docs/media-pricing.md`。

## 2026-10-14 · 阿里与 MiniMax 媒体任务（docs/04、05、06、07、10）

- 使用明确的 bailian-media / minimax-media 配置，不将 mediaOnly 当作 Ark 协议。图片复用 OpenAI SDK；原生异步任务及语音保留供应商协议。
- 创建任务前持久化 operation ID；创建不自动重试。超时或映射写入失败保留 outcome_unknown / 已知上游任务 ID，避免重复收费。任务绑定 key、账户、模型、endpoint 与凭证指纹，凭证变更保守拒绝续查。
- 任务记录保留与查询期限独立：阿里查询 24 小时，MiniMax 7 天；不推测产物 URL 有效期。不明价格保留 null，并拒绝受费用上限约束的调用。
- 短 ASR 使用现有 Chat 入口的专用 hook，保留 URL/Data URL/asr_options，跳过通用 IR 与聊天 fallback；流接管并发与请求内存直到完成。语音为独立 HTTP/WS 入口，不改变 xAI /v1/tts。
- 独立验收补齐：操作记录保存完整恢复绑定，已知上游 ID 可通过 operation 查询恢复公开任务；成功产物不因后续辅助结算/遥测失败而丢失。
- **真实验收修复**：北京 Qwen3 文件识别实际返回 HTTP OSS 签名链接，仅将精确官方结果域名升级 HTTPS；继续使用公网 DNS/IP、固定连接、逐跳重定向与大小/超时边界。固定 IP 下载显式关闭 Node 地址族自动选择，并按已验证 IP 设置 family，修复默认 lookup(all:true) 与标量回调不兼容。
- 用户授权后已通过本地 Helm 调用真实上游；型号、次数与未验收范围见 docs/media-provider-task-tracker.md。未部署生产。

## 2026-10-14 · Ark 多媒体集成（docs/04、05、06、07、10）

- **SDK 与范围**：使用官方 OpenAI Node SDK 7.33.0 的兼容 Images 与自定义 post/get，maxRetries=0；没有证据需要重写官方 Ark SDK，条件任务 T03 不适用。独立 type: ark 客户端只支持媒体，媒体模型从聊天执行和聊天连通性测试中拒绝。
- **权限与单写**：真实 lane 检查 allowed_lanes，直接 Ark alias／wire ID 要求 allow_custom_model；wire ID 仅在唯一配置映射时解析。集成测试发现旧图片接口未检查 lane 白名单，补齐后保留历史非 Ark 裸模型行为。付费创建一旦发出不重试、不跨 provider 回退；上游 ID 与 Helm UUID 分离，保存 key/account/provider/model/kind 绑定并在轮询核验。
- **成本与恢复**：尚无可靠 USD 媒体结算上界，金额预算 key 预先拒绝，未知成本仍为 null。任务保存 7 天，结果 URL 24 小时；SQLite/Postgres 的条数清理排除未过期媒体任务与预写保留记录，仍按 TTL 清理，因此媒体记录可能使总行数超过普通 Responses 的 10,000 条软上限；3D 返回 ZIP 内 GLB/PBR，未新增资产托管。媒体 catalog 的 maxContextTokens=0 表示不适用聊天 token context，不是宣称上游零输入额度。
- **实测修正**：Seed3D 的 running 响应还包含 service_tier、execution_expires_after、draft、priority；新增严格字段校验与真实形状回归，修复 Helm 误报 502，未放开未知字段。
- **限制**：组合参考显式要求 omni_reference_task_type=reference，避免默认自动选入未支持的编辑/延长任务。本轮四次批准实测：3D 基础产物通过，Flash/Pro/Seedance 额度受限；3D 请求 low、上游回传 medium，档位语义尚未验收，不盲目改字段或重试付费创建。实际账单、生产未验收。任务明细与证据见 docs/ark-media-development-plan.md。

## 2026-10-13 · API key 客户端入口限制（docs/06、07、11）

- **家族 lane 修正**：模型家族命名的 lane 也按当前客户端过滤；auto、通用档位、任务与自定义通用名称保留。只依公共 lane 名判断家族，不沿执行链推断；未知命名仍按通用 lane，操作者自定义别名应遵循家族前缀。详情与列表一致，不改路由链和 fallback。
- **模型发现补充**：按用户确认的客户端→模型家族规则过滤具体模型，保留 auto/lane 和内部 fallback；以真实 wire model 识别别名。此为展示规则，不新增手工模型调用权限。过滤在基础列表缓存之后执行，Codex 原生列表内容与 ETag 同步；受限的非 Codex 请求不获取 Codex 专用目录。
- **Opus 审查修正**：无效或新版未知策略读取为只读空名单，单 key 拒绝而非全站启动失败，管理员可修复；严格写入校验不变。Postgres 区分 SQL NULL 与 JSON null。拒绝日志不收集任意 UA 原文；MCP embedding 明确在策略范围外。
- **独立策略**：`client_policy` 默认为 null；开启须选择非空客户端集合。仅在鉴权后校验入口 User-Agent，不绑定模型、provider 或账号，不改分类与执行 fallback。策略严格校验，损坏存储不自动降级为不限。
- **生效范围**：模型发现、所有已实现推理/计数/生命周期接口及 WebSocket 握手；Responses 每轮重查。已接纳流与 Realtime session 不强制中断；跨进程更新受鉴权缓存 TTL（默认 30 秒）约束。
- **证据边界**：UA 可伪造，不承诺防封号。Claude Desktop 仅连接测试取样，Code/Cowork 未完整验证；Grok 标记仅覆盖 CLI。部署不替既有 key 开启。详见 `docs/api-key-client-policy.md`。

## 2026-10-12 · Grok 官方价格与媒体计费单位（docs/07、10）

- **官方依据**：xAI 模型卡与 pricing 页面；Grok 4.5 缓存输入改为 $0.30/M，4.5/4.7 从 200K prompt tokens 起使用整单高档，Build Fast 仍在超过 200K 时切档。priority 按官方 2 倍计价。
- **媒体配置**：新增 `imageOutputPerImageUsd`、`videoOutputPerSecondUsd` 可选非负字段，分别配置 Image $0.02/张、Quality $0.05/张、1.5 Preview $0.08/秒、Video $0.05/秒；官方 1.5 页面明确包含 preview 别名。价格是 API 等价参考，不是订阅实际账单。
- **范围与限制**：本次只补全价格目录，不实现媒体用量结算或历史重计价。媒体 token 价继续为 null；spend-capped key 的既有拒绝策略不变，避免仅有参考单价却无法准确结算。Remote 仅合并这八个 Grok 条目，保留其他线上覆盖。

## 2026-10-12 · Grok 固定首尾帧与声线组合（docs/05、07；视频接口方案）

- **决定**：新增稳定1.5的首帧/尾帧＋参考图/预置声线严格组合；至少一个固定端点，可省略prompt。新组合限1–15秒、480p/720p；不扩大既有30秒与preview语义，不开放自定义音频、file_id、中间关键帧或ZDR。
- **边界**：只修改shared schema，OpenAPI随之生成；原provider原样转发、单写和归属保护保持不变。首次真实调用之前，离线测试不等于上游账号支持或视频质量通过。
- **发布前置**（docs/10）：v0.30.41 按要求重新同步官方客户端；Claude 2.1.296 经独立静态协议审核，新增未公开字段继续拦截，不扩大转发白名单。审核与具体兼容性限制见 `docs/claude-protocol-safety.md`。


## 2026-10-10 · Claude 账号真实套餐展示（docs/06、11）

- **官方来源**：读取 `/api/oauth/profile` 的 `organization.organization_type`，仅将 `claude_pro`、`claude_max`、`claude_team`、`claude_enterprise` 映射为对应套餐；额度、邮箱、模型列表均不用于推断。
- **读取与缓存**：显式刷新按每个账号的代理访问官方接口，普通列表读取不发上游请求。仅保存套餐、核验时间与凭证指纹，重启后可读；悬停标签可查看最近核验时间。刷新失败显示未知，五分钟内普通刷新复用结果，强制刷新跳过缓存。
- **边界**：凭证变化使旧结果失效；查询期间退出或重新连接的响应被丢弃。此字段仅用于展示，不改变 OAuth 身份、调度或权益；首次升级后点击刷新取得套餐。

## 2026-10-09 · Claude 协议与 OAuth 账户边界（docs/04、05、06、07、10）

- **身份边界**：从 OAuth token 响应保存真实 account UUID，刷新缺省时保留，变更则拒绝。原生与转换路径的明确账户声明只能路由到匹配 UUID，禁止带账户声明的 Claude 历史跨协议；保留原始身份到发送前及 401 重试后再次核验；本地拒绝终止外层 fallback，不改写身份、不记 provider 故障。旧令牌无 UUID 时需重新连接或正常刷新取得身份；无账户声明的会话仍未获得完整历史隔离证明。
- **协议语义**：转换路径删除自行生成的 Stainless SDK 遥测头；原生保留真实 SDK、version/beta/x-app 以及审核过的 prompt/agent/保护字段，未知秘密与远程租户字段仍隔离。未伪造新客户端信号，旧 system/UA/CCH 兼容路径仍有授权与协议风险。
- **发布快照**：v0.30.38 按仓库发布契约同步 Claude Code 2.1.295、Grok 1.0.50、Codex 0.162.0 与同 tag 模型目录；协议审核记录单独保留，不以版本同步代替审核。
- **版本门禁**：新增独立 Claude 协议审核记录与官方平台包 integrity 校验。未知版本或同版本 artifact 漂移均阻止同步写入；离线构建不联网。审核通过不等于账号安全，详情和迁移边界见 `docs/claude-protocol-safety.md`。

## 2026-10-07 · 发布时同步订阅客户端版本（docs/05、06、10）

- **官方来源**：Grok 使用官方安装器的 `https://x.ai/cli/stable`，Claude Code 使用 npm `@anthropic-ai/claude-code/latest`，Codex 使用 `openai/codex` 最新稳定 release；Codex 模型目录固定取同一 tag。拒绝预览版本、错误响应及非法目录，不在失败时沿用旧值。
- **发布边界**：`release:prepare` / `preversion` 统一同步，未打 tag 的版本在每次 CI 中校验最新值，避免版本变更后的后续提交绕过检查。生成模块、来源 manifest 与目录 hash 一并签入；原来的 Claude 构建前联网更新改为离线一致性校验，发布不改动已过 CI 的输入。
- **限制**：“最新”以成功的 release CI 检查为准，发布期间上游新增版本留待下次。三个 sync 命令统一维护同一快照；仍允许运维应急覆盖，但新镜像默认值追上后须移除覆盖，防止未来发布继续使用旧版本。版本更新不等于获得新模型授权，仍需真实上游验收。

## 2026-10-01 · Helm 级联 Responses 续接恢复（docs/04、05、07）

- **根因与边界**：上游 Helm 在确认本轮尚未发给 provider 后，会关闭 WebSocket（1012）让 Codex 重发完整历史；中间 Helm 无法从关闭事件证明是否执行，将其报告为结果不明。HTTP 回退后的增量续接因此反复失败。
- **协议决定**：仅 Helm relay 握手携带 `x-helm-responses-recovery: errors`，请求结构化错误；普通 Codex 连接沿用现有 1012 恢复。复用已有 before-send 错误和内部 proof，不把任意断线或 1012 当作可重放证明；保留恢复原因与冷却时间，非 2xx 嵌套错误同样保留。
- **兼容与验收**：新旧版本混用时继续保守处理，不扩大重放范围；完整修复需要更新链路上的 Helm。真实本地 socket 回归覆盖 SSE/HTTP 错误、无冷却/长冷却和完整历史恢复；原有断线不重放与直连 Codex 恢复测试保留。最初为何回退 HTTP 的历史记录不足，本次不据此归因网络或代理。

## 更早历史总览

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
