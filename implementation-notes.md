# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。完整原文可经 git history 回溯。

---


## 2026-11-20 · 单音轨转写费用上界

百炼逐音轨收费。按单音轨费用配置异步上界时，价卡用 `maxChannels` 声明该范围，网关按已验证的最终请求计数并在预留前拒绝超限；省略音轨选择采用供应商单轨默认值。未配置轨数限制的完整作业上界保留既有语义。该字段提供可执行的收费范围，实际价卡仍须具有适用账户的公开价格依据。

## 2026-11-20 · 文件转写下载凭据与预算回执（docs/06、native-media）

文件转写创建请求的签名 URL 可读取私有媒体。成功、失败和超时均只保存遥测，不保存请求、上游请求或响应正文。此边界优先于全局正文设置和失败时强制采集，保留请求字节数及现有操作回执。按现役 0.30.93 适配，仍待发布。

异步文件转写对受美元预算限制的 key 只接受已核实的账户级单笔上界。终态查询把通过共享 schema 的供应商时长写回原操作回执。费用仍未知时保留预留，缺用量的回复不清除已记录的时长。公开标价、客户端声明和转写末句时间均不用于结算。

## 2026-11-20 · 媒体模型按官方用量计价（docs/06、07）

短录音按百炼上报的音频秒数计算目录费用，美元换算使用部署价卡的 `billing.usdPerCurrencyUnit`。受限 key 预留费用时仍需独立配置时长取整规则。历史修复需要把上游用量、计费分档和原请求一一对应，保留无法核实的空值。

## 2026-11-19 · 订阅账号按权重随机分配（docs/04）

手动优先级按与当前最佳候选的数值差换算权重，差值为 0、1、3 时，权重比为 4∶2∶1。避免浪费直接用现有到期分数。缺少有效额度数据的账号取已知正分的平均值，全无正分时给未知账号权重 1。已知零分保持为零，只有所有候选权重都为零时才等概率选择。两种模式都在新分配时抽签，同一会话继续复用可用账号。

## 2026-11-19 · 同步短录音的协议选择（docs/04、05、06）

复用 `transcription-short`。Chat 音频沿用百炼，multipart 在同一条链中选择能接文件的客户端。OpenAI 使用官方 API 账号池，每次提交选一个有模型许可的账号。默认价卡缺少已核实的计费进位，费用未知时原样记账；带美元硬上限的调用在无法报价时拒绝发送。

## 2026-11-18 · GPT-6.2 Astra／Sol（docs/04、07）

新增版本入口，优先使用账号发现的 Codex 模型；不可用时回退到原家族 lane。付费 OpenAI Responses 仍须显式选择，不进入默认链。官方 API 上下文均为 105 万，最大输入 92.2 万、输出 12.8 万；Codex 本地窗口按官方 0.169.1 目录取 Astra 27.2 万、Sol 50 万。Helm 配置支持 low 至 max，不把 ultra 映射为其他档位。

两款模型超过 272,000 个输入 token 时整单升档。Ultrafast 当前为标准价的 3 倍，须于 2027-03-01 太平洋时间切换到 6 倍。Flex 未公布价格；Batch 价不套用于 Flex。缓存写入仍按 30 分钟估算，无法区分 12 小时用量。来源见 [OpenAI 价卡](https://developers.openai.com/api/docs/pricing)。

## 2026-11-18 · 零用量空截断恢复（docs/04）

- 生产请求在首个有效输出前收到 max_output_tokens、output=[]、输入/输出/总用量全零的 incomplete。该终态此前被当作有效输出，直接阻止备用候选接手；现在交给现有失败与切换路径。
- 仅匹配这组明确证据；已经产生文字、推理或工具输出的流不重放，未知用量及正常内容截断继续保留原行为。

## 2026-11-16 · Fun-ASR／Paraformer 录音文件识别（docs/05、06、native-media）

- 按官方 REST 与热词文档拆分 `fun-asr`、`paraformer-v2` 请求 schema，复用现有 DashScope 异步任务、operations 恢复和公网结果下载；新增专用 lane。供应商选择不再吞掉无效请求，未通过 schema 的请求在发送前返回 400。
- 当前两份官方 REST 文档均限制每任务一个 URL，保留 `file_urls` 单元素数组；多文件由客户端逐个建任务。Fun-ASR 即时热词为最多 2000 项的文本到整数权重（1–5）映射，非 ASCII 文本最多 15 字符；官方未定义省略权重的形式。Paraformer 仅开放文档支持的 `vocabulary_id`，不套用 Fun-ASR 即时热词或未公开的标点开关。
- 下载的转写结果用 Zod 校验并保留所有原生字段，词级毫秒时间、标点、说话人字段不丢弃。上游 `usage.duration` 原样保留并映射到 `type: duration / seconds`；不从词时间推测用量。北京秒价重新核对为 ¥0.00022／¥0.00008。
- 沿用现有异步任务记账边界：计请求次数并返回用量，不新增轮询扣费或美元结算；spend-capped Key 仍在发送前拒绝。无真实供应商调用；账户权限、识别质量及实际账单未验收。完整 API 与来源见 [recorded-file-asr.md](docs/recorded-file-asr.md)。

- 发布 0.30.89：完成 Claude Code 2.1.326 静态协议审查，保留现有头白名单并增加新增字段隔离回归；`release:prepare` 同步 Grok 1.0.88、Claude Code 2.1.326，Codex 0.169.0 及目录不变。部署保留服务器自定义配置；本轮不发送真实录音，转写质量与实际计费由后续音频验收确认。

## 2026-11-14 · 最新 GPT／Claude 价卡（docs/07）

- **来源与范围**：按 [OpenAI 官方价格](https://developers.openai.com/api/docs/pricing)、[模型目录](https://developers.openai.com/api/docs/models)及 [Claude 官方价格](https://platform.claude.com/docs/en/about-claude/pricing)核对当前通用文本模型。GPT 最新为 Astra 6、Sol 6.1、Terra 6.1、Luna 6；Claude 为 Fable 5.2、Opus／Sonnet／Haiku 5.5，另有受限的 Mythos 5.2。
- **价卡决定**：补齐 Fable／Mythos 5.2 与 Haiku 5.5 的 `anthropic`／`anthropic-api` 定价，含缓存、Fast 与美国区域系数。Haiku 总输入严格超过 100,000 才整单升档；Sonnet 5.5 缓存读取修正为 $0.10/M。OpenAI／Codex 补 Astra Fast、Astra／Sol Ultrafast 及 Astra／Luna 区域系数。
- **范围边界**：新增 Claude 价卡同时配套官方能力元数据，避免价格条目生成零能力默认值并错误拦截已有自定义路由；provider 注册及默认 lane 保持原配置。Fable／Mythos 禁止强制工具选择，Haiku 支持；按官方要求移除不支持的采样及手动思考参数。Mythos 仍须上游授予访问权限。订阅仍按 API 等价价格估算，不代表订阅账单。第三方聚合商沿用各自价卡。
- **已知限制**：沿用现有 OpenAI 30 分钟缓存写入计价；12 小时缓存写入尚无独立用量字段映射，不宣称可准确区分。历史费用不自动重算；部署时需将价卡增量合并到挂载配置，并从实际容器重新加载验证。

## 2026-11-14 · 豆包语音模型配置与原生时长（docs/06、G4 H02/H03）

- 新增独立 `doubao-speech` provider及TTS2.0/标准录音ASR2.0各一条单候选lane，使用语音新版控制台独立API Key，不复用Ark。缺key时客户端不可用，启动不做收费探测；旧AppId/token、极速及实时ASR不在本片。
- 按官方后付费价记录TTS CNY3/万字符、标准ASR CNY0.8/小时；没有补默认FX或推断时长取整。TTS缺FX及异步ASR缺时长预留时仍拒绝spend cap。标准query保留原生audio_info.duration/usage，不以字幕结尾造时长；TTS HTTP408保持unknown，不自动重试。
- API key、资源开通与授权音色仍是独立运行配置；代码、模型目录和无凭据健康部署不等于供应商实测。既有Luma key、预算和其他provider不改；本轮无收费调用，真实验收须有限批次授权。
- 发布前置：完成 Claude Code 2.1.323 官方制品有限静态审查并保持10头白名单，新增6字段剥离回归；独立只读审查无P0/P1。`pnpm release:prepare 0.30.87` 同步 Grok1.0.77、Claude2.1.323、Codex0.169.0及同tag目录，协议证据见 docs/claude-protocol-safety.md。
- 本地验收：豆包/配置/预算/路由6文件78项与协议/身份/发布门禁4文件191项通过；core/gateway类型检查、变更范围Biome及完整build通过。此记录不代替PR/main CI、目标部署和真实供应商验收。


## 2026-11-14 · 请求内存记账与 Docker 堆自适应（docs/02、10）

- HTTP/WebSocket 请求解析完成后，实际占用由实时堆与系统余量统计接管，释放共享待分配预留，避免同一请求同时扣减实际占用和预留。独立生命周期计数继续保留到流结束或断连，维护暂停仍等待活动请求排空；响应处理使用自己的预算。
- Docker 默认使用 Node 原生 `--max-old-space-size-percentage=50`，启动时按容器内存约束（无约束时按物理内存）计算 old-space 上限，给 Buffer、SQLite 和系统留出空间。运行中不动态重设堆上限，仍执行实时准入保护；`.env` 的 `NODE_OPTIONS` 可覆盖默认值，固定上限与百分比不能同时配置以免百分比优先。
- 100 MiB 请求通过预算模型验证，不实际分配大型正文或重放用户请求；并发待解析请求和实际堆不足仍可返回容量 503，因此不承诺所有并发下无条件接收 100 MB。定向 70 项测试通过，覆盖 HTTP/WebSocket 生命周期、断连、维护排空及堆比例启动；shared/gateway 类型检查通过。发布准备执行 `pnpm release:prepare 0.30.86`：Grok 1.0.77、Claude Code 2.1.323、Codex 0.169.0；Claude 静态制品审查与新增头隔离核对已记录于协议文档，额外 218 项协议／快照测试通过。生产验收在镜像发布后分别核对 ai-run 与 8.4。

## 2026-11-13 · 百炼短 WAV ASR 原子费用预留（docs/06、G4 H03）

- 只扩展 qwen3-asr-flash 非流式完整 mono PCM16 WAV data URL，复用转写时长核验、媒体账本和查询入口；发送前持久预留，按原生 usage.seconds 结算。缺失或无效用量及网络后未知保留预留，不自动重发；确认未发送/拒绝才归零。响应加 accounting/operation header，保留 Chat 正文和 native usage。
- 计费依据仍是部署前提：官方当前秒价不证明本账户取整单位，音频 token 的不足一秒规则不用于推断账单。缺显式 roundingSeconds，或 CNY 卡缺 FX，继续 fail-closed；没有改生产价卡或放宽 cap。带预算的 URL/流式与异步 filetrans 不在本片。
- 业务发送前须持久化 pending attempt；operation 查询不返回 transcript，响应完全丢失不能用新 attempt 盲目重发。新增边界测试源码先行；按主控高负载要求未执行红/绿、类型检查或编译，待低负载验证。本片无供应商调用、新 key、SQL、部署或配置写入。

## 更早历史总览

2026-11-12 的 Seedance 素材授权将素材类型、key 和上游身份绑定，每次创建任务时校验。

2026-11-12 · Ark 媒体错误保留上游诊断，真人素材仍受授权和素材入库条件限制。

受限 key 显式选择 lane 时按其已授予的 lane 权限校验。

2026-11-12 · G4 语音、时间戳与费用：增加独立媒体预算与原生时戳；分供应商的实测结果、汇率与音色限制见历史记录。

2026-11-11：上游 Providers 只读用量查询与模型／账号路由归属，详见 Git 历史。

2026-11-11（docs/06、11、Portal）：API Key 固定七天循环配额；按入站周期原子计请求，Token／USD 事后结算，未知计量拒绝受限请求，双数据库与真实网关验证通过。

2026-11-11（docs/07、11）：请求页展示实际上游 API Key 名称与末四位，解释 Codex BYOK 组织限制；身份代次校验与原错误详情保留，174 项测试及桌面／窄屏预览通过。

2026-11-10 · OpenAI Luna 温度参数兼容（docs/04、05、07）；完整记录见 Git history。

更早工作涵盖 API Key 暂停与吊销、固定配额和预算，客户端身份与版本快照，Codex／Claude／Grok／DeepSeek 协议兼容、模型目录与订阅额度，HTTP/WebSocket/SSE 生命周期、发送后结果不明禁止重放、fallback 与熔断，Memory 观察／注入／压缩／保留，payload/session 持久化、SQLite/Postgres 一致性与资源保护，图片／视频／语音权限及计费，Admin/Portal/i18n，以及构建、CI、Docker、发布与验收。历史默认值和实测以对应提交为准；完整条目可从基线 632e2971db3363b1a2575cba1ed31cbac213634c 的本文件及 Git history 回溯。
