# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-09-06 · 记录 Responses 流内上游错误事件（docs/07，原则 8）

- Decision error detail now records `upstream_event` (`error` or `response.failed`) for in-band SSE failures. HTTP status remains nullable because the upstream may return the error after opening an HTTP 200 stream.
- This is additive and preserves the raw provider payload; it makes Codex overload failures distinguishable from Helm-generated admission errors in Admin telemetry.


## 2026-09-06 · Responses 空准备事件保留安全恢复窗口（Provider execution / Responses，docs/04/05，原则 3/5/8）

- 空 message/reasoning item、空文本/思考摘要 part 和空 delta 继续缓冲；只有真实内容才提交流，使随后明确的过载错误可以进入既有 OAuth sibling retry 与模型 fallback。正常响应仍逐字节回放原始事件。
- 工具开始、加密思考内容、未知或畸形事件保持原先的提交边界；EOF/断连等结果不明仍禁止重放，严格账号亲和和客户端取消规则不变。
- OAuth pool 在首个实际输出前，仅对结构化 `server_is_overloaded` / `service_unavailable_error` 流内错误进行同账号短退避；默认等待 1 秒、3 秒，HTTP 503/529 与 Responses 账号池共用请求级两次额外重试预算，耗尽后禁止账号/模型层重新开始。沿用整个请求的取消信号与总超时，不重新计时；等待结束重新检查账号可调度性。
- `provider.overload_retry` 结构化日志只记 trace、原因、次数、等待毫秒与耗尽标志，不记正文或凭证。它记录安排的重试（等待期间仍可取消），不等于 HTTP 实际发送计数；原 `provider_attempts` 仍代表模型尝试。
- 严格亲和的流内错误不新增重放；显式 HTTP 503/529 的既有安全重试保留。持续过载或总超时仍会失败，不能保证靠等待消除所有上游故障。生产样本正文未保存，不能把本地复现直接当作每条生产错误的确定根因。

## 2026-09-06 · Codex 模型发现跟随上游 client_version 与可选 base_instructions（OAuth provider / Codex discovery，docs/04/05，原则 3/6）

- **根因一**：`chatgpt.com/backend-api/codex/models` 按 `client_version` 门控下发；`gpt-6-astra` 的 `minimal_client_version` 为 `0.153.0`，而 Helm 默认发送 `0.145.0`，账号已有权限仍收不到该模型。默认值不再手写：`pnpm sync:codex-models` 通过 GitHub API（`/repos/openai/codex/releases/latest`，天然排除 draft/prerelease）取最新 `rust-vX.Y.Z` tag，并从同一 tag 的 raw `models.json` 拉目录，不依赖本地 codex checkout（可选 `GITHUB_TOKEN` 提升限流），生成 `packages/core/src/provider/oauth/codex-client-version.generated.ts`（当前 `0.153.4`），与 bundled 目录一同刷新；`HELM_OPENAI_CODEX_CLIENT_VERSION` 覆盖规则不变，测试只锁定 semver 形状与 `>= 0.153` 下限。
- **根因二**：上游 `codex-rs/protocol::openai_models` 已把顶层 `base_instructions` 降为 legacy 可选字段并迁移到 `model_messages.instructions_template`，新条目不再携带；Helm 的 zod schema 仍要求必填，导致整份 `/models` 响应解析失败并回退到旧的内置目录。schema 现改为 `nullable().optional()`，并用 `pnpm sync:codex-models` 重新同步内置 `codex-models.json`（含 `gpt-6-astra`）。
- 没有新增 schema、migration、配置或依赖变化；发现失败仍沿用既有 LKG / bundled 回退，不放宽任何 fail-closed 边界。

## 2026-09-06 · 订阅模型自动/手动列表统一按官方目录与数据库权威（OAuth provider / routing / Admin，docs/04/11，原则 2/3/6）

- Automatic mode now exposes only the provider's live or durable last-known-good official discovery; curated guesses and forced Codex image aliases are no longer injected when discovery is empty.
- Manual mode remains the exact saved `enabledModels` list across Admin, Lanes, OpenAI-compatible `/v1/models`, native Codex listings, and runtime pools. xAI custom manual IDs use an identity wire mapping when absent from the structured catalog; the provider remains the final capability authority.
- No schema, migration, configuration, or dependency changes.

## 2026-09-06 · Codex 原生模型列表保留手动自定义 ID（OAuth provider / Codex discovery，docs/04/05，原则 3/6）

- 原生 `GET /v1/models?client_version=...` 已把手动账号模型作为权威输入；当 ID 尚未出现在上游目录时，使用该账号目录中最低 priority 模型的兼容元数据生成条目，并将 `slug`/`display_name` 改为手动 ID。自动模式仍只输出上游发现项。
- 这是列表展示与协议兼容的最小兜底，不宣称自定义 ID 的真实能力或 entitlement；实际请求仍由上游决定是否支持。没有新增 schema、migration、配置或依赖。

## 2026-09-06 · 订阅账号手动模型允许自定义 ID（OAuth provider / Admin / routing，docs/04/11，原则 2/3/6）

- Manual 模式以运维方保存的 `enabledModels` 为权威，Codex 模型即使尚未出现在账号目录中，也会在 Admin 回读、Lanes 目录和运行时账号池中保留；Automatic 模式仍只跟随上游发现。
- 自定义 ID 只表示“允许尝试”，不伪造账号 entitlement 或模型能力；账号实际不支持时由上游正常拒绝。没有新增 schema、migration、配置或依赖。

## 2026-09-05 · GPT-6 Astra 官方 API 目录与价格（Provider catalog / routing / cost telemetry，docs/04/05/07，原则 2/3/5/6）

- OpenAI 官方开发者文档现将 `gpt-6-astra` 列为 API 模型：文本+图片输入、文本输出、1,050,000 context、922,000 max input、128,000 max output，支持 reasoning（`low`–`max`，不支持 `none`）、streaming、tools、structured outputs、file/web search 与 prompt caching。
- 官方标准价格为 input `$10`、cached input `$1`、cache writes `$12.50`、output `$50`/1M tokens；超过 272K 输入时为 `$20`/`$2`/`$25`/`$75`。Helm 将这些值加入 `openai/gpt-6-astra` 的手工 capability/pricing 覆盖，并保留 GPT-5.6 兼容别名与订阅 lane 不变。
- GPT-6 Astra 不支持 `temperature`、`top_p`、`logprobs`，且不支持 `none` reasoning effort；现有 OpenAI reasoning-model 的 `max_completion_tokens` shim 扩展到该模型。Fast mode 在 EU data residency 下不可用；未新增服务层自动降级。

## 2026-09-05 · Claude Fable 5.1 官方目录与价格（Provider catalog / routing / cost telemetry，docs/04/05/07，原则 2/3/5/6）

- Anthropic 官方模型页现将 `claude-fable-5-1` 列为 Fable 最新 API ID：1M context、128K output、text+image、adaptive thinking（always on，默认 `high`）、tools/computer use/PDF 与 structured output。
- 官方基础价格为 input `$10`、output `$50`、cache read `$0.25`、5-minute cache write `$12.50`、1-hour cache write `$20`/1M tokens。Helm 的 `claude-fable` lane 先走 5.1，保留 Fable 5 作为订阅兼容回退。

## 2026-09-02 · Codex Responses HTTP 只重放明确拒绝的请求（Responses / provider execution，docs/04/05/07，原则 3/5/8）

- Codex HTTP POST 在 `fetch()` 抛出连接错误或首字节超时后无法证明上游未接收请求；这类结果现在单次终止为 `response_create_outcome_unknown`，记录 `after_send_before_response`，不再由 fetch 层、OAuth sibling 或候选链重放。外部客户端取消保持原分类。
- HTTP 200 后在终态前发生 EOF、读超时/异常、本地 response-work 拒绝、空 body 或缺少 SSE 结尾分隔符，都属于上游可能已接收但结果不明，记录 `after_response_before_terminal`（已解析 preamble 的外层 guard 记录 `after_response_created_before_output`）并停止 sibling/provider fallback；即使缺少末尾空行且随后读失败，完整可解析的 `response.failed` / `error` 仍作为明确拒绝保留，可在无真实输出时 fallback。
- 明确拒绝仍保留既有安全恢复：401 刷新后一次重发、503/529 最多三次总尝试、WebSocket 握手及可证明发送前关闭总计三次尝试。无 schema、migration、配置或依赖变化。

## 2026-09-01 · Codex 超大完整历史在发送前缩图并压缩（Responses / docs/05，原则 3/7/8）

- 生产失败请求在单个完整历史中重复携带 11–24 张内联 Base64 图片，正文达到 46–49 MiB；Codex 客户端按 token 而非 wire bytes 触发自动压缩，Helm 的后台 Memory compaction 也不修改当前请求，因此会先撞上 WebSocket/HTTP 传输上限。
- 仅对没有 `previous_response_id`、准备走 Codex WebSocket 的完整历史做 32 MiB 发送前保护：先将 PNG/JPEG/WebP 内联图片转成最长边 2048px、质量 82 的 WebP（不放大，单图输入像素上限 1600 万），仍超限再调用同账号 `/responses/compact` 并用其 `output` 替换历史；小请求和增量续接保持原样。官方 Responses 图片输入合同支持 WebP data URL。
- 缩图或 compact 失败均 fail-open 到既有 `1009 → HTTP` 兜底，不删除图片或私有 Responses item；compact 结果只有比当前正文更小时才采用。缩图在 Base64 解码前预留源文件字节，并在变换期间另行预留解码像素内存；每请求最多处理 12 张/3200 万总像素及单图 1600 万像素，并在图片之间响应客户端取消。新增 `sharp` 是唯一依赖，生产镜像必须验证 native addon 可加载。

## 历史条目摘要（最新要点）

- **2026-09-01 · Codex Responses 超大首轮 WebSocket 的 HTTP 生命周期**：仅在无续接 ID、无任何上游 frame 且收到 close 1009 时单次回落 HTTP，之后同 ingress session 保持 HTTP；未知结果与跨账号续接仍 fail-closed。完整记录见 Git 历史。

## 更早历史总览

2026-08-30 及更早工作涵盖订阅图片/视频/TTS 的 entitlement、单写与价格边界，Responses HTTP/WebSocket 生命周期、发送前恢复证明、账号与 transport 亲和、超大历史与压缩，OAuth 模型发现、额度窗口、Retry-After、冷却、轮转和缓存，协议互译与 SSE/tool-call 保真、能力/价格目录、路由/分类/fallback/熔断，Memory observe/inject/反思/压缩/保留与并发治理，payload/session 分段持久化、失败记录、SQLite/Postgres 数据完整性与资源保护，Admin/Portal/i18n/可访问性、key 权限/预算/计量，以及构建、CI、Docker、发布和生产验收。具体默认值、兼容限制与历史实测均以对应提交为准；本次压缩前的完整条目可从基线 412c7cde02288d9b33d54a87f93b43925177b294 的本文件及 Git 历史回溯。
