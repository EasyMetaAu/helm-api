# API key 客户端限制：设计与交付计划

## 已确认的行为

每把 key 独立设置 `client_policy`。`null` 表示关闭；开启时至少选择一个客户端。创建时不传表示关闭；PATCH 不传保留原值，传 `null` 清除。旧 key 迁移后保持不受限，轮转保留策略。Portal 只读显示，只有管理员可修改。

在成功鉴权后、读取正文和调用上游之前执行检查。不通过时返回协议对应的 403，错误类别为 `client_not_allowed`；不触发 provider 重试、熔断或 fallback。通过后原路由链不变：不绑定模型、厂商、订阅账号，不更改分类兜底或执行兜底，不覆盖任何出站身份头。

## 按客户端显示模型

开启客户端限制后，`GET /v1/models` 与 `GET /v1/models/:id` 按本次请求的实际客户端显示具体模型：Codex App/CLI 显示 GPT/Codex（含 OpenAI o 系列）；Claude CLI/Desktop 显示 Claude；Grok CLI 显示 Grok。允许多个客户端的同一把 key 在各客户端看到各自的列表，而不是这些客户端模型的并集。关闭限制后恢复原列表。

匹配配置中的真实 `provider_model`，而不是供应商名或任意 alias；OAuth 使用当前的 wire model 映射。未知模型家族不展示。原有 `allow_custom_model`、`allowed_lanes` 和 `blocked_models` 仍先行生效。普通列表保留 `auto`、通用档位（economy/balanced/premium）和任务 lane（coding/json/vision/tool_use）；模型家族命名的 lane 同样过滤：Codex 仅显示 GPT/Codex/o 系列 lane，Claude 仅显示 Claude lane，Grok 仅显示 Grok lane。Gemini、DeepSeek lane 不在这五种客户端中展示。其他自定义名称视为通用 lane；家族由 lane 名称判断，不沿 primary/fallback 推断，避免把通用 premium 误判为 Claude。仅展示规则变化，不向路由或 provider 执行层增加家族限制，跨模型 fallback 保持不变。手工指定模型的调用仍服从既有路由权限，不把列表隐藏当成新的模型授权规则。

Codex 的 `client_version` 专用列表继续返回其原生格式并过滤具体模型；受限的非 Codex 客户端不能用这个参数获取 Codex 列表。若过滤改变了返回内容，ETag 与 Responses 跟踪同步使用过滤后的值。内部缓存只保存未经过客户端过滤的基础列表，每个请求独立过滤；受限响应设置 `private, no-store`，避免外部缓存串用。

## 识别依据与限制

使用有长度上限的确定性 User-Agent 产品标记匹配。缺失、畸形、未知或多客户端冲突标记在开启限制时拒绝。不固定版本号，不接受用户自定义正则。

| 客户端 ID | 产品标记 | 证据范围 |
| --- | --- | --- |
| `codex_app` | `Codex Desktop/<version>` | Remote 入口实际 GPT Responses 请求 |
| `codex_cli` | `codex-tui`、`codex_exec`、`codex_cli_rs` | 当前 TUI/exec 实测，旧 rs 标记兼容 |
| `claude_cli` | `claude-cli/<version> (external, cli 或 sdk-cli)` | print 实测，交互标记兼容 |
| `claude_desktop` | `Claude/<version>` | Desktop 连接测试；不代表 Code/Cowork 已验证 |
| `grok_cli` | `grok-shell/<version>` | CLI 实测，不代表 Grok Bot.app |

User-Agent 可伪造。这是防止误接客户端的入口限制，不是应用身份认证，也不能保证上游账号不被封禁。`originator` 等附加头不单独作为放行凭证。Claude Desktop 内嵌 agent 模式若使用其他标记，会被拒绝，需新增真实样本后再扩展，不能根据猜测放行。

损坏或当前版本不认识的持久化策略读取为 `{"allowed_clients":[]}`（仅用于读取的拒绝所有客户端标记），返回 403，不阻断网关启动或其他 key。管理页面可重新选择客户端或关闭限制；写入接口仍拒绝空名单。只有数据库 SQL NULL 表示关闭，JSON null 也按无效策略拒绝。

拒绝日志保留 trace_id、key ID、识别结果与原因，不记录原始 User-Agent。UA 是任意客户端输入，可能夹带敏感信息；排查客户端格式变更时应另行进行限定范围的脱敏采样。

## 边界与生效时间

覆盖 Chat 及别名、Messages 与 token count、Responses 与生命周期/compact/input tokens、Gemini 及别名、Interactions、Decisions、图片、视频、TTS、Realtime 会话建立和模型发现。管理面、Portal、usage、memory/MCP 与健康检查保持其原鉴权；其中 MCP 的 memory_recall 在配置 embedding 模型时可能产生上游调用，这类 Memory 辅助调用明确不属于此策略范围。

Responses WebSocket 在握手的模型发现检查，以及每次 `response.create` 对应的 HTTP 入口执行检查。Realtime 在会话建立和 sideband 握手时检查；已经接受的实时会话和进行中的流不因修改开关而中断。此功能不提供强制终止既有会话。

本进程管理 API 修改后清除 key 鉴权缓存。其他进程在缓存 TTL 后读取新策略（默认 30 秒，受 `HELM_AUTH_CACHE_TTL_MS` 配置影响）。需要立即阻断既有连接时，应使用现有运维流程终止相关会话。

## 开发与验收顺序

1. **P0 数据和入口**：Zod 策略、纯函数识别、SQLite/Postgres 增量迁移、所有推理入口 403、凭证脱敏。
2. **P1 操作闭环**：后台创建/编辑开关和复选框；空选择拒绝；Portal 只读回读；轮转/部分编辑不丢策略。
3. **P1 兼容证明**：流式/非流式跨协议 fallback；WebSocket 握手与后续请求；旧 key 默认不限、非法持久化策略拒绝；UI 保存→API 拦截→关闭恢复。
4. **交付**：功能 PR 经全部必需 CI 合并；版本 PR 与发布工作流生成 release/不可变镜像；Remote 备份后按 digest 更新，核验版本、健康、临时 key 的允许/拒绝及清理。

## 验证说明

定向测试使用虚拟凭证和模拟上游，不向真实模型发送测试正文。实际客户端采集已在方案阶段完成，私人捕获文件不提交到仓库。生产验收用临时受限 key 的模型发现请求，不启用任何现有 key 的限制。
