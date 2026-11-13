# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。完整原文可经 git history 回溯。

---


## 2026-11-14 · 请求内存记账与 Docker 堆自适应（docs/02、10）

- HTTP/WebSocket 请求解析完成后，实际占用由实时堆与系统余量统计接管，释放共享待分配预留，避免同一请求同时扣减实际占用和预留。独立生命周期计数继续保留到流结束或断连，维护暂停仍等待活动请求排空；响应处理使用自己的预算。
- Docker 默认使用 Node 原生 `--max-old-space-size-percentage=50`，启动时按容器内存约束（无约束时按物理内存）计算 old-space 上限，给 Buffer、SQLite 和系统留出空间。运行中不动态重设堆上限，仍执行实时准入保护；`.env` 的 `NODE_OPTIONS` 可覆盖默认值，固定上限与百分比不能同时配置以免百分比优先。
- 100 MiB 请求通过预算模型验证，不实际分配大型正文或重放用户请求；并发待解析请求和实际堆不足仍可返回容量 503，因此不承诺所有并发下无条件接收 100 MB。定向 70 项测试通过，覆盖 HTTP/WebSocket 生命周期、断连、维护排空及堆比例启动；shared/gateway 类型检查通过。发布准备执行 `pnpm release:prepare 0.30.86`：Grok 1.0.77、Claude Code 2.1.323、Codex 0.169.0；Claude 静态制品审查与新增头隔离核对已记录于协议文档，额外 218 项协议／快照测试通过。生产验收在镜像发布后分别核对 ai-run 与 8.4。

## 2026-11-13 · 百炼短 WAV ASR 原子费用预留（docs/06、G4 H03）

- 只扩展 qwen3-asr-flash 非流式完整 mono PCM16 WAV data URL，复用转写时长核验、媒体账本和查询入口；发送前持久预留，按原生 usage.seconds 结算。缺失或无效用量及网络后未知保留预留，不自动重发；确认未发送/拒绝才归零。响应加 accounting/operation header，保留 Chat 正文和 native usage。
- 计费依据仍是部署前提：官方当前秒价不证明本账户取整单位，音频 token 的不足一秒规则不用于推断账单。缺显式 roundingSeconds，或 CNY 卡缺 FX，继续 fail-closed；没有改生产价卡或放宽 cap。带预算的 URL/流式与异步 filetrans 不在本片。
- 业务发送前须持久化 pending attempt；operation 查询不返回 transcript，响应完全丢失不能用新 attempt 盲目重发。新增边界测试源码先行；按主控高负载要求未执行红/绿、类型检查或编译，待低负载验证。本片无供应商调用、新 key、SQL、部署或配置写入。

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

## 更早历史总览

2026-11-10 Helm 级联保留客户端 User-Agent：HTTP/WebSocket、跨协议和媒体发送恢复入站 UA，保留身份隔离；完整记录见 Git history。

更早工作涵盖 API Key 暂停与吊销、固定配额和预算，客户端身份与版本快照，Codex／Claude／Grok／DeepSeek 协议兼容、模型目录与订阅额度，HTTP/WebSocket/SSE 生命周期、发送后结果不明禁止重放、fallback 与熔断，Memory 观察／注入／压缩／保留，payload/session 持久化、SQLite/Postgres 一致性与资源保护，图片／视频／语音权限及计费，Admin/Portal/i18n，以及构建、CI、Docker、发布与验收。历史默认值和实测以对应提交为准；完整条目可从基线 632e2971db3363b1a2575cba1ed31cbac213634c 的本文件及 Git history 回溯。
