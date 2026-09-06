# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-09-06 · 对齐 Codex Lite 身份与流式控制事件（Provider / Responses，docs/04/05/07，原则 3/5/8）

- 对照 Codex `008bbd5884122dc95aaece19ecfe0fc6a59dcf36`：Lite 完整请求和增量续接保留带前缀的输入项 ID；Helm 旧 `store:false` 清理会删除它们。现用已有 Lite 识别逻辑排除旧清理，保留原生历史；普通 Responses 的兼容清理不变。
- `response.metadata`、`codex.response.metadata`、`codex.rate_limits` 和 `responsesapi.websocket_timing` 属于控制信息。它们不再提前提交执行尝试；正常响应逐字节保留，输出前明确过载沿既有有界策略恢复。真实输出、工具调用、加密 reasoning、未知事件及结果不明断连的禁止重放边界不变。
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

## 历史条目摘要（最新要点）

- **2026-09-05 · GPT-6 Astra 官方 API 目录与价格**：官方 API capability/pricing 与 reasoning 参数兼容已加入 override，订阅 lane 保留；定价和限制按对应提交回溯。

## 更早历史总览

2026-09-05 Fable 5.1 目录/价格、2026-09-02 HTTP 结果不明禁止重放（保留明确拒绝的有界重试）、2026-09-01 超大历史发送前保护已并入历史；完整内容见基线 `8a7df80c6684b10bfa7ff7f4f07f237a92f95d58`。2026-08-30 及更早工作涵盖订阅图片/视频/TTS 的 entitlement、单写与价格边界，Responses HTTP/WebSocket 生命周期、发送前恢复证明、账号与 transport 亲和、超大历史与压缩，OAuth 模型发现、额度窗口、Retry-After、冷却、轮转和缓存，协议互译与 SSE/tool-call 保真、能力/价格目录、路由/分类/fallback/熔断，Memory observe/inject/反思/压缩/保留与并发治理，payload/session 分段持久化、失败记录、SQLite/Postgres 数据完整性与资源保护，Admin/Portal/i18n/可访问性、key 权限/预算/计量，以及构建、CI、Docker、发布和生产验收。具体默认值、兼容限制与历史实测均以对应提交为准；本次压缩前的完整条目可从基线 412c7cde02288d9b33d54a87f93b43925177b294 的本文件及 Git 历史回溯。
