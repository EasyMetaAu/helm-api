# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-09-17 · 记录真正发送上游的 Codex installation id（Provider / Routing / Admin，docs/05/07/11，原则 7）

- **动机**：#856 把 installation id 重绑为每账号独立值后，真正上到上游的那个值没有任何留存，只有 `body_shims_applied` 里一个"改写过"的布尔标记。账号被风控时无法回答"这次用的是哪个 id"，也无法验证重绑生效。
- **粒度**：按 attempt 记在各自的 mutation ledger（fallback 链跨账号，id 各不相同，这是唯一不丢信息的粒度），另把服务成功那次的值提升到顶层 `DecisionRecord.codex_installation_id` 供详情页「请求」面板直接展示；全链路失败时退回最后一次记录到 id 的 attempt。
- **`source` 三态**：`rebound`（我们改写过，此时才额外留客户端原值）/ `client`（客户端自带且已等于账号绑定值）/ `absent`（请求没带 id）。此前这三种情况在遥测里无法区分。
- **未新增传播通道**：`prepareRequest` 已有 `Object.assign(input.mutations, prepared.carrier.mutations)` 把 provider 内部 ledger 写回调用方 carrier，`execute.ts` 抓的正是同一引用。原计划的回调机制经验证属多余，已撤销。`execute.test.ts` 新增用例专门守这条链路。
- 三个字段均为不透明标识符，不含正文或密钥；全部 optional，旧记录 round-trip 不变，**无需迁移**。
- **顺带修正**：v0.29.15（#861）误把发布条目拼进了文件头部的格式说明行，导致模板被覆盖，本次恢复。

## 2026-09-17 · 修复 provider 字段兼容 400（docs/04/05，原则 3/8）

- Codex legacy `store:false` input 删除已由生产证实被拒绝的 `status`；`phase` 没有拒绝证据，保留其历史语义。Lite input 身份、加密 reasoning、tool call 关联均不改动。
- Claude Sonnet 5 在转换与 native 发送边界移除已弃用的 `temperature`；strict thinking 可能重新注入 `temperature=1`，因此序列化前再次应用同一模型规则。其他模型维持原行为。
- 不扩大通用 400 fallback，也不重放已提交输出；已知字段在首次发送前修正，后续临时 provider 故障继续走既有 fallback。仅 Sonnet 5 有生产拒绝证据，本次不推测扩大到其他 Claude 模型。

## 2026-09-17 · 无消息上游失败暴露原始事件（Provider / Admin，docs/05/07/11，原则 3/8）

- **真实触发**：生产两个 ChatGPT Pro 账号（`gongjin843677@` / `smithmark3673@`）全模型失败，连通性面板只显示 `codex responses stream error` 一句，**无法判断是封号、风控还是配额**。同时刻另两个账号正常，排除了通道与网络因素。
- **根因**：`responseEventError` 的兜底分支——上游 `response.failed` 事件里 `message` 与 `error.message` 都缺失时，直接返回那句固定文案，**原始事件既不进日志也不传前端**，诊断信息在此处彻底丢失。
- 现在兜底消息保留原句作稳定前缀，追加 `code=<code>` 与事件 JSON（`summarizeUpstreamEvent`，截断 400 字符防刷屏）；完整事件仍在 `UpstreamError.providerRaw`。有 message 的上游错误路径**完全不变**。
- 连通性测试 SSE 的 error 事件新增 `upstreamStatus` + `providerRaw` 两个**可选**字段，仅 `UpstreamError` 携带；其他错误事件形状不变，前端旧行为兼容。管理面板加可展开的「上游详情」块（7 语言均已补译，CI 的 locale 对齐门禁会卡）。
- **坑**：测试里用 `async function*` 写"只抛不产出"的 iterator 会被 biome `useYield` 拒绝；改为直接实现 `Symbol.asyncIterator` + `next: () => Promise.reject(...)`，语义上也更贴近"首次拉取即失败"的真实场景。
- 截断上限 400 字符是拍板值，无配置项——理由同原则 2：会撒谎的旋钮比没有旋钮更糟，完整内容本就在 `providerRaw` 里。

## 2026-09-16 · 下线 gpt-5.5：断路由但保留价目（Config / OAuth discovery，docs/04，原则 2/6）

- **与 Codex Spark 先例（`33c1f799` + `9e3bfb67`）的有意偏离**：Spark 的 config 条目被删干净，gpt-5.5 不能照做。box 上 `served_model='gpt-5.5'` 有 349,050 条、$28,828.83（2026-06-12 起）。`historical-cost-reprice.ts` 按 alias 查 catalog，查不到就 `skip(alias,"pricing_entry_missing")`——删掉价目等于永久放弃这批记录的重算能力。故采用**只断路由**：移除 lane / alias / provider 条目 / curated list，`pricing.yaml` + `capabilities.yaml` 保留并加退休注释说明为何不是孤儿。Spark 从未有过价目条目（`git log -S` 确认），所以它没有这个取舍。
- **alias 删除必须与 lane 同步**：`validateModelAliasTargets` 在启动时 fail-closed，只删 lane 会拒绝启动。删掉 `"gpt-5.5"` 映射后，pin 该 id 的客户端由 `"gpt-5*": premium` 接住——优雅降级而非 400。
- **坑：manual 模式的 allowlist 绕过了退休过滤。** `RETIRED_OPENAI_CODEX_MODELS` 覆盖 live discovery 与 bundled/cached 目录，但 `selectAccountModels` 对 manual 模式**原样返回** `enabledModels`，退休前存下的账号设置会让该模型复活为可路由 alias。已在该 chokepoint 补过滤（仅 openai-codex；manual 保留自定义 id 的语义不变）。这是新写的测试实际抓到的，不是预判。
- `codex-models.json` 仍含 gpt-5.5 slug——它由 `pnpm sync:codex-models` 从上游生成，手改会被覆盖，保证来自 `parseModels` 的过滤（沿用先例）。
- gpt-5.5 无独立 quota limit family（Spark 有 `codex_spark` / `-codex-spark` 后缀），故 `isRetiredOpenAICodexLimit` 与 admin `.svelte` 均无需改动。
- 顺带修正 docs/04 的 lane 计数（13→12 vendor-family；总数标称 22 实为 26，gpt-6-astra / grok / media lane 加入后未更新）。

## 2026-09-16 · Codex installation id 按账号重绑（Provider / Responses，docs/04/07，原则 7）

- 查证 Codex 上游实现（`codex-rs/core/src/installation_id.rs`）：`installation_id` 是持久化在 `$CODEX_HOME/installation_id` 的**纯随机 UUID v4**，无任何派生规则——不掺账号、不掺硬件、与 `session_id`/`thread_id` 无关。它标识**安装**而非账号，所以同一台机器上的多个 ChatGPT 账号此前共用一个指纹经 Helm 出网。
- 改为每账号一个：复用既有 `stableSessionId` 的确定性派生思路，新增 label `codex-installation`，`sha256(encKey ‖ "codex-installation:<provider>:<account>")` 前 16 字节整成 UUID v4 形状。永不轮换、跨重启稳定、被 at-rest 密钥加盐、无需回写 DB。
- 客户端在**三处**携带该 id，必须一起重绑，否则 header 改了而 body 仍泄漏真实值：HTTP header `x-codex-installation-id`、`client_metadata` 同名 key、以及 `x-codex-turn-metadata` JSON 内的 `installation_id` 字段（header 与 `client_metadata` 两份都要）。
- 边界：客户端**未携带**该 id 时完全不改写（保留 raw body，不凭空生成）；turn-metadata 非合法 JSON 时原样透传。上游 `prompt_cache_key` 取自 `session_id` 而非 installation id，故本改动不影响 prompt 缓存亲和性。
- 上游官方只把该 id 放在 body（`compatibility_headers()` 不发它，真 header 仅用于 remote-control WebSocket 配对），但生产抓包显示实际流量 header 里确实带了，因此三处都覆盖。

## 2026-09-10 · 失败请求保留最终尝试的订阅账号（Telemetry / Admin，docs/07，原则 5/7）

- `serving_account` 在成功时仍表示实际服务账号；全部执行失败时改为记录最后一次真正发起上游请求的订阅账号，便于定位账号级故障。若候选在选账号前被熔断/能力门禁跳过，仍保持 `null`，不伪造分配结果。
- 若订阅账号失败后又尝试了其他 provider，旧账号不会被误标为最终尝试；未新增 schema、迁移或正文记录。

## 2026-09-06 · 对齐 Codex Lite 身份与流式控制事件（Provider / Responses，docs/04/05/07，原则 3/5/8）

- 对照 Codex `008bbd5884122dc95aaece19ecfe0fc6a59dcf36`：Lite 完整请求和增量续接保留带前缀的输入项 ID；Helm 旧 `store:false` 清理会删除它们。现用已有 Lite 识别逻辑排除旧清理，保留原生历史；普通 Responses 的兼容清理不变。
- `response.metadata`、`codex.response.metadata`、`codex.rate_limits`、`responsesapi.websocket_timing` 和 `keepalive` 属于控制信息。它们不再提前提交执行尝试；正常响应逐字节保留，输出前明确过载沿既有有界策略恢复。真实输出、工具调用、加密 reasoning、未知事件及结果不明断连的禁止重放边界不变。v0.29.10 部署后重放第二条原请求时，生产流明确出现 `keepalive` 后跟过载，补齐了先前缺失的线上事件证据。
- 两条生产失败请求确实分别丢失 157/239 个 ID；控制事件导致错误直接下传已由本地网关与账号池回归用例复现，但生产未保留这些失败的完整 SSE，因此不能把两项差异直接认定为全部线上故障的唯一原因。补丁尚未部署，真实会话恢复仍须单独验证。

## 2026-09-06 · Remote 配置同步后的目录与 e2e 一致性（Config sync，docs/04/05，原则 2/3/6）

- Remote 的通用 lane 以 `gpt-5.6-*` 子 lane 为主候选，并移除了官方 DeepSeek 直连候选；e2e 断言同步为实际的 lane 名与 OpenRouter fallback，未改运行时代码。
- `providers.yaml` 暴露 bare alias `gpt-image-2`，但 capability override 仍使用旧的 `zenmux/gpt-image-2` key，导致图片端点误报 404；将 capability key 对齐为 `gpt-image-2`。GPT-6 Astra lane 与四个兼容别名保持原样。
- Remote 默认开启 eval；e2e 的关闭场景改为显式 header，慢 eval 按实际边界断言 `eval_timeout`。测试专用 MCP OAuth 签名 key 只存在于 hermetic launcher，不影响生产配置。

## 2026-09-06 · 记录 Responses 流内上游错误事件（docs/07，原则 8）

- Decision error detail now records `upstream_event` (`error` or `response.failed`) for in-band SSE failures. HTTP status remains nullable because the upstream may return the error after opening an HTTP 200 stream.
- This is additive and preserves the raw provider payload; it makes Codex overload failures distinguishable from Helm-generated admission errors in Admin telemetry.

## 2026-09-06 · 将 Remote 运行时配置同步回仓库（Config sync，docs/04/11，原则 2/3/6）

- Remote `/opt/helm-api/config` 没有 Git checkout；本次从服务器读取 11 个正式 YAML，排除 `.bak*` 备份，并原样写入仓库配置。
- 保留 Remote 的 GPT-6 语义：`gpt-6-astra` lane 主候选为 `openai-codex/gpt-6-astra`，四个 GPT-6 兼容别名均指向 `gpt-6-astra` lane。Remote 还包含已运行的 classifier、Memory、策略和图片配置，因此同步范围不是只改 GPT-6 三行。

## 2026-09-06 · Responses 空准备事件保留安全恢复窗口（Provider execution / Responses，docs/04/05，原则 3/5/8）

- 空 message/reasoning item、空文本/思考摘要 part 和空 delta 继续缓冲；只有真实内容才提交流，使随后明确的过载错误可以进入既有 OAuth sibling retry 与模型 fallback。正常响应仍逐字节回放原始事件。
- 工具开始、加密思考内容、未知或畸形事件保持原先的提交边界；EOF/断连等结果不明仍禁止重放，严格账号亲和和客户端取消规则不变。
- OAuth pool 在首个实际输出前，仅对结构化 `server_is_overloaded` / `service_unavailable_error` 流内错误进行同账号短退避；默认等待 1 秒、3 秒，HTTP 503/529 与 Responses 账号池共用请求级两次额外重试预算，耗尽后禁止账号/模型层重新开始。沿用整个请求的取消信号与总超时，不重新计时；等待结束重新检查账号可调度性。
- `provider.overload_retry` 结构化日志只记 trace、原因、次数、等待毫秒与耗尽标志，不记正文或凭证。它记录安排的重试（等待期间仍可取消），不等于 HTTP 实际发送计数；原 `provider_attempts` 仍代表模型尝试。
- 严格亲和的流内错误不新增重放；显式 HTTP 503/529 的既有安全重试保留。持续过载或总超时仍会失败，不能保证靠等待消除所有上游故障。生产样本正文未保存，不能把本地复现直接当作每条生产错误的确定根因。

## 历史条目摘要（最新要点）

- **2026-09-06 · Codex 原生模型列表保留手动自定义 ID**：`GET /v1/models` 对尚未出现在上游目录的手动 ID，借该账号最低 priority 模型的兼容元数据生成条目（改写 slug/display_name）；只为列表展示与协议兼容兜底，不宣称真实能力，自动模式仍只输出上游发现项。
- **2026-09-06 · 订阅账号手动模型允许自定义 ID**：Manual 模式以运维保存的 `enabledModels` 为权威，Codex 自定义 ID 即使未出现在账号目录也保留（只表示“允许尝试”，不伪造 entitlement）；Automatic 仍只跟随上游发现。注意其后 2026-09-16 已为该路径补上退休模型过滤。
- **2026-09-05 · GPT-6 Astra 官方 API 目录与价格**：官方 API capability/pricing 与 reasoning 参数兼容已加入 override，订阅 lane 保留；定价和限制按对应提交回溯。

## 更早历史总览

2026-09-06：Codex 模型发现使用上游 client_version 和可选 base_instructions；订阅模型自动/手动列表统一依据官方目录与数据库权威，完整记录见 Git history。

2026-09-05 Fable 5.1 目录/价格、2026-09-02 HTTP 结果不明禁止重放（保留明确拒绝的有界重试）、2026-09-01 超大历史发送前保护已并入历史；完整内容见基线 `8a7df80c6684b10bfa7ff7f4f07f237a92f95d58`。2026-08-30 及更早工作涵盖订阅图片/视频/TTS 的 entitlement、单写与价格边界，Responses HTTP/WebSocket 生命周期、发送前恢复证明、账号与 transport 亲和、超大历史与压缩，OAuth 模型发现、额度窗口、Retry-After、冷却、轮转和缓存，协议互译与 SSE/tool-call 保真、能力/价格目录、路由/分类/fallback/熔断，Memory observe/inject/反思/压缩/保留与并发治理，payload/session 分段持久化、失败记录、SQLite/Postgres 数据完整性与资源保护，Admin/Portal/i18n/可访问性、key 权限/预算/计量，以及构建、CI、Docker、发布和生产验收。具体默认值、兼容限制与历史实测均以对应提交为准；本次压缩前的完整条目可从基线 412c7cde02288d9b33d54a87f93b43925177b294 的本文件及 Git 历史回溯。
