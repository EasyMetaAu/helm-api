# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-10-20 · 图片串联客户端身份与明确拒绝（docs/05、06、07）

- **请求身份**：仅 `type: helm` 的 OpenAI 图片转发保留入站 User-Agent；按调用传递，不写入共享账号状态，不替换认证头，也不向第三方图像 provider 传递客户端身份。
- **错误边界**：上游明确返回 `403 client_not_allowed` 或 `404 model_not_found` 时保留状态和有限错误码，不泄露原始正文、不重试、不切换 provider、不计为熔断故障。真正结果不明的写入仍返回 `outcome_unknown`，保持单次发送。
- **配置限制**：Codex auto 模式严格跟随官方目录，不自动补图片工具模型。要使用 `gpt-image`，可在一个可调度账号的 manual 清单中明确加入 `gpt-image-2` 并保留原文本模型；该账号后续新增文本模型需手动维护。上游仍裁决实际支持，不从套餐推断图片权限。
- **图片驱动模型**：移除已被上游拒绝的固定 `gpt-5.4-mini`，使用 `HELM_CODEX_IMAGE_CONTROLLER_MODEL`（默认 `gpt-6-luna`），由 Zod 验证；与图片工具模型 `gpt-image-2` 分开，切换驱动模型无需改代码。
- **正式链路补充**：Luna 官方目录标记 `use_responses_lite=true`，通用 Lite 转换会移走顶层图片 `tools`，上游返回 400。Images API 强制标准 Responses 方言并保留其余目录元数据；文本路径继续遵循目录。新增生成/编辑回归，确保工具、tool_choice 与请求头一致。

## 2026-10-18 · 订阅提供商刷新期限与恢复（docs/06、11）

- **现场证据**：Remote v0.30.48 的刷新任务持续 `running` 超过八小时；健康检查正常，Claude/xAI 额度缓存未更新。现有日志不能确定具体阻塞的上游请求，不能把某一家提供商认定为根因。
- **期限**：OAuth 管理请求从发送到正文读取结束最多 30 秒；原有更短的请求期限仍有效。模型发现的 HTTP 读取同样限制为 30 秒，超时后保留旧目录、释放共享等待，并拒绝迟到响应写入目录缓存；认证与轮转凭证落盘不被计时器分离。整个刷新任务 120 秒后显示失败，沿用 60 秒重试冷却。
- **写入边界**：取消后不再启动后续额度写入、额度重置或正常账号池重建；不确定的 xAI 媒体授权继续按既有规则撤销。已发出的写入／重置仍等待完成，不能为释放队列而让旧任务与新任务并发。数据库或账号池变更若本身无法结束，仍保留互斥保护，页面显示超时失败而不是假报成功。
- **验证与限制**：定向测试覆盖不响应取消的网络请求、停滞正文、迟到目录结果、刷新超时后的安全重试，以及超时后禁止自动消费重置额度。历史现场具体阻塞点尚未确认；上线验收需核对实际镜像 SHA、健康状态和新的刷新任务结果，不能以本地测试代替。

## 2026-10-15 · 订阅账号环境时区（docs/05、06、11）

- **用户确认的范围**：仅转换已验证的客户端环境时区／当前日期；业务时间、工具参数、模型输出保持原样。没有可靠的响应环境字段契约，因此不做全局反向替换。
- **账号与出口**：IANA 手动覆盖独立存入加密 account settings，绑定／管理页面可设置。默认通过固定账号代理依次使用 IPWho.is、ipapi.is 免费接口；成功缓存 15 分钟、失败 1 分钟，全部失败不猜测。按用户明确要求启用公共多源定位，不发送账号凭证或正文。
- **一致性**：共享发送边界覆盖原生／转换、HTTP／SSE、Codex WS／compact。每次克隆请求并清除失效 raw_body；实时读取手动设置，保持 Codex pool 和续接状态。历史环境只更新最近的已知块。
- **限制**：地理库误差、缓存期间 IP 轮换及按目的地分流无法由通用探测消除；上游已保存的历史不在新请求中时也无法改写。独立 Grok 遥测不经过网关。完整字段边界与调查版本见 `docs/subscription-timezones.md`。

## 2026-10-14 · 模型目录超时与 Helm 串联握手（docs/05、06、07）

- **根因**：版本模型目录的内部 5 秒期限被错误识别为客户端断开（499），早于 WebSocket 预检的 6 秒期限；已有 504 鉴权兜底未执行。中间 Helm 因握手失败改走 HTTP，随后带 `previous_response_id` 的续接缺少原 WebSocket。
- **决定**：只在模型目录边界区分调用方取消和内部期限；真实取消优先，内部超时返回结构化 504，复用既有普通模型列表鉴权兜底。保留客户端权限、密钥撤销和有状态续接边界，不扩大重放范围。
- **验证与限制**：定向回归覆盖超时分类、取消竞争、真实 socket 两轮复用和兜底时密钥撤销。目录本身较慢的上游原因不在本次修复内；未添加缓存、后台刷新或延长超时。
- **发布前置**（docs/10）：v0.30.47 使用 `release:prepare` 同步官方稳定快照；Claude 2.1.299 经完整性校验和独立静态审查。新增上传字段不进入推理白名单，原生 `cc_gateway` 归因保留但不仿造；Grok 1.0.52、Codex 0.162.1 与同 tag 模型目录保持最新。详情见 `docs/claude-protocol-safety.md`。

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


## 更早历史总览

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
