# 原生直通保真规范

状态：本 PR 的实施与验收规格。本文档记录 Anthropic Messages 和 OpenAI Responses
原生直通的目标契约、自动化验收方法和已确认产品决策。

## 问题

当入站原生协议被路由到同协议 provider 时，Helm API 应该是治理网关，
而不是无意中介入协议转换的适配器。对于原生直通，客户端期望上游请求
和响应尽量保持它发送时的原始协议形态。

当前网关已经有原生直通路径，但它仍会重新构造 provider headers、解析
并重新序列化 request body、修补 `model`、可能注入记忆，并且在 Responses
流式路径中生成 Helm 合成前导事件、改写 response id。其中一部分属于有意
的网关行为，另一部分应该收窄范围或显式化。

## 目标

1. 在原生直通中保留客户端可见的协议表面。
2. 尽可能安全地保留客户端请求 headers。
3. 保留 request body 字段，包括未来协议新增的未知字段。
4. 保留原生流式事件顺序和 payload，避免协议重映射。
5. 保留 Helm 治理能力：鉴权、按 key 限流、预算、路由、fallback 安全、
   telemetry、payload capture 和记忆注入。
6. 所有不可避免的修改都必须显式、可测试、可观测。
7. 仅在不静默改变客户端语义时借鉴 `claude-relay-service` 的账号安全策略；
   如果会改变语义，则必须放在显式 provider compatibility profile 后面。

## 非目标

- 不把 Helm 变成盲目的 TCP/HTTP 代理；Helm 仍然负责鉴权、授权、路由、
  预算和记录请求。
- 不把客户端的 Helm 凭证转发给上游 provider。
- 不启用跨协议原生直通。如果源协议和目标 provider 协议不同，必须走
  transformed path。
- 默认不复制 relay 实现中激进的 prompt/system 改写策略。

## 原生直通契约

只有同时满足以下条件时，才能启用原生直通：

- `native_protocol_passthrough` 已启用。
- 入站 route 已写入 native request carrier。
- 入站协议不是 `openai_chat`。
- 入站协议等于解析后的 provider wire protocol。
- fallback 链不能切换到其他 provider protocol。
- provider 不要求 compatibility rewrite。
- provider 针对 stream 或 non-stream 实现了对应 native 方法。

当启用原生直通时，Helm 应该：

- request、response、stream data 都避免协议 transformer；
- 只带着文档化的修改转发客户端 body；
- 只带着文档化的覆盖转发清理后的客户端 headers；
- 不生成合成协议事件，直接转发上游 bytes/events；
- 尽量把治理和可观测性放在协议 payload 之外。

## 允许的修改

默认原生直通只允许以下修改：

| 修改 | 原因 | 范围 |
|---|---|---|
| 替换上游鉴权 headers | 防止泄露 Helm API key，并使用 provider 凭证 | 仅 headers |
| 删除 hop-by-hop headers | HTTP proxy 规则要求 | 仅 headers |
| 重新计算 `content-length` | 允许修改 body 后需要重新序列化 | 仅 headers |
| 将 `model` 改成解析后的 provider model | 客户端 model 可能是 Helm alias 或 lane target | 仅 body |
| 添加记忆提醒 | Helm memory injection 是产品功能 | 仅 body，尾部追加 |
| 统一 timeout/abort 处理 | 网关可靠性 | 仅传输层 |

任何其他修改都必须放在显式 provider profile 后面，并记录到 telemetry。

## 修改账本

每一次 native attempt 都应该携带 mutation ledger，方便调试和管理界面检查。
建议字段：

- `model_rewritten`: `{ from, to }`
- `memory_appended`: boolean
- `headers_dropped`: string[]
- `headers_overwritten`: string[]
- `auth_replaced`: boolean
- `content_length_recomputed`: boolean
- `accept_encoding_forced_identity`: boolean
- `provider_profile_applied`: string | null
- `body_shims_applied`: string[]
- `stream_reframed`: boolean

mutation ledger 绝不能包含 secrets 或完整 body 内容。

## Header 策略

### 默认规则

除非 header 不安全、属于传输层、属于 Helm 内部 header，或必须被 provider
凭证覆盖，否则全部转发客户端 header。

### 拒绝列表

永远不要把这些客户端 headers 转发给上游：

- `authorization`
- `proxy-authorization`
- `x-api-key`
- `x-cr-api-key`
- `host`
- `content-length`
- `connection`
- `keep-alive`
- `proxy-connection`
- `transfer-encoding`
- `te`
- `trailer`
- `upgrade`
- `sec-websocket-key`
- `sec-websocket-version`
- `sec-websocket-extensions`
- `sec-websocket-protocol`
- `x-helm-*`
- `cookie`
- `set-cookie`
- secret-like client headers（例如包含 `authorization`，或形如 `*-auth`、
  `*-token`、`*-secret`、`*-credential`、`*-api-key` / `*-apikey`）

provider client 可以针对特定上游增加拒绝列表，但必须文档化并测试覆盖。

### Provider 覆盖

provider 凭证必须覆盖客户端鉴权。例如：

- Anthropic static key：从 provider config 设置上游 `x-api-key`。
- Anthropic OAuth/subscription：从账号设置上游 `authorization`。
- ChatGPT/Codex Responses：从选中的账号设置上游 `authorization` 和
  `chatgpt-account-id`。

### Anthropic Headers

默认保留客户端传入的身份和 SDK headers，包括：

- `user-agent`
- `accept`
- `accept-language`
- `anthropic-version`
- `anthropic-beta`
- `anthropic-dangerous-direct-browser-access`
- `x-app`
- `x-stainless-*`

如果 Helm 需要添加 provider 必需的 beta 值，应该与客户端 `anthropic-beta`
合并，而不是替换。重复 beta token 应去重，同时保持稳定顺序。

对于官方 Anthropic subscription profile，Helm 可以强制
`accept-encoding: identity`，避免压缩 SSE 损坏。该行为必须记录为
`accept_encoding_forced_identity`。

### Responses / Codex Headers

默认保留客户端传入的身份和 session headers，包括：

- `user-agent`
- `accept`
- `accept-language`
- `openai-beta`
- `version`
- `session_id`
- `x-session-id`
- `x-client-request-id`
- `originator`，前提是对选中的 backend 安全

对于 ChatGPT/Codex backend，Helm 可以设置必要的 backend identity headers，
例如 `chatgpt-account-id`、`originator` 和 `OpenAI-Beta`，但不应覆盖语义等价的
客户端 headers，除非 provider profile 明确要求。

## Body 策略

### 默认规则

保留所有解析后的 native body 字段，包括未来协议新增的未知字段。native path
不得运行 request protocol transformer。

### Raw Body 保留

如果不需要修改 body，优先转发原始 JSON 文本，以保留空白、key 顺序和数字写法。
如果 `model`、memory 或 provider profile 改变了 body，则重新序列化最小修改后的
对象，并记录 mutation ledger。

### Model 改写

Helm 可以将 `body.model` 替换为解析后的 provider model。当客户端发送 Helm alias、
lane 或 provider-prefixed model，而上游不接受该值时，这是必要的。

如果客户端 model 已经等于解析后的 provider model，则不要把它记录为 rewritten。

### 记忆注入

记忆注入保留，但必须是追加式：

- Anthropic：追加一个尾部 user message，包含 memory reminder。
- Responses：追加一个尾部 input item/message，包含 memory reminder。
- 绝不改写 `system`、`instructions`、历史对话、tools、cache-control prefix 或
  provider-specific state。
- 记录 `memory_appended: true`。

### 可选 Provider Profiles

provider profile 可以应用额外 shim，但默认关闭，必须显式配置。候选 profile：

#### `anthropic_official_safe`

值得考虑的 CRS 风格安全 shim：

- 限制不可能的 `max_tokens` 值；
- 移除不支持的 `cache_control.ttl`；
- 强制 Anthropic cache-control block 数量限制；
- 合并必需 beta headers；
- 流式场景强制 `accept-encoding: identity`；
- 保留真实的 Claude Code user-agent 和 app headers。

默认不要启用这些行为：

- 用 Claude Code prompt 替换客户端 `system` prompt；
- 把原始 `system` prompt 移入 messages；
- 注入合成 `metadata.user_id`；
- 改写 tool names；
- 一看到 `top_p` 就删除。

这些行为是在用协议保真换账号安全伪装。如果确实需要，应放在更强的 profile
后面，例如 `anthropic_official_compat`，并清楚标注为语义改写。

#### `codex_official_safe`

值得考虑的 CRS 风格安全 shim：

- 对 ChatGPT/Codex Responses，在缺失时设置 `store: false`；
- 保留 Codex CLI user-agent 和 session headers；
- 每个账号/session 使用稳定的 `session_id` / `x-client-request-id`；
- 捕获 rate-limit errors，用于账号 cooldown。

如果客户端显式发送 `store: true`，在 `codex_official_safe` profile 下 Helm 应覆盖为
`store: false`，避免触发 ChatGPT/Codex backend 的账号风险。该覆盖对客户端响应不额外暴露，
但必须写入 mutation ledger，例如 `body_shims_applied: ["store_forced_false"]`。

## Streaming 策略

native streaming 应该是 raw 或接近 raw 的传输路径。

### 必需行为

- 不运行 stream protocol transformers。
- 不在上游 stream 开始前合成协议事件。
- 不丢弃上游 lifecycle events。
- 不改写上游 response ids。
- 在传输 API 允许时，转发 comments、keepalives、no-data frames 和未知事件。
- tee stream 用于 usage parsing 和 payload capture，但不改变客户端收到的内容。

### Responses 专项规则

原生 Responses streams 不得发送 Helm 生成的 `response.created` 或
`response.in_progress` frames。不得改写上游 `response.completed`、
`response.incomplete` 或其他带 id frame 中的 `response.id`。

trace 关联应该写到 telemetry，例如 `trace_id`、`provider_response_id`，而不是写进
客户端可见的上游 frames。

### Anthropic 专项规则

原生 Anthropic streams 应该按收到的内容转发上游 `event:` 和 `data:` frames。
如果框架无法保留完全 byte-identical 的 chunk 边界，至少必须精确保留 event names
和 data payload strings，并在 mutation ledger 中标记 `stream_reframed: true`。

## 治理和 Fallback

Helm 治理在 passthrough 前后仍然生效：

- API-key 鉴权和 role/cap 检查；
- 按 key 的 RPM/TPM 和并发限制；
- 按 key 的使用预算和 degrade rules；
- 路由和 provider 选择；
- same-protocol fallback guard；
- provider breaker/cooldown 行为；
- telemetry 和 payload capture；
- 客户端 abort 作为非 provider failure 处理。

如果某个 native attempt 在第一个 streamed chunk 之前失败，并且 fallback 链保持同一
provider protocol，Helm 可以带着同一个 native carrier 尝试下一个 candidate。如果
fallback 可能切换协议，必须从第一个 attempt 开始禁用 native passthrough，改走
transformed path。

## 从 CRS 借鉴的账号安全策略

这些策略有价值，并且与 Helm 的网关模型兼容：

1. 对 subscription/OAuth 账号使用 sticky session routing，key 可以来自
   `session_id`、`x-session-id`、`prompt_cache_key`、`conversation_id` 或稳定
   metadata。
2. 对 429、529、401/403 和 5xx 使用不同的账号 cooldown 状态。
3. raw stream 转发的同时并行解析 usage。
4. 通过 header passthrough 保留真实客户端 fingerprint。
5. 为官方 subscription backend 增加可选 provider profiles。

这些策略不应作为默认行为复制，因为它们会改变语义：

1. Prompt/system 替换。
2. 合成 metadata identity 注入。
3. native passthrough 中改写 tool names。
4. 静默删除客户端 sampling 参数。
5. 静默覆盖客户端显式 storage 设置。

## 自动化验收方案

原生直通的正确性必须通过可执行程序验收，不能只靠人工 review 或单元测试推断。
验收框架必须是确定性的：不依赖真实 Anthropic、OpenAI 或 ChatGPT/Codex 上游，
不需要真实 provider credentials，所有上游行为由本地 fake upstream 控制。

### 验收核心模型

每个 golden case 都要同时捕获并比较三份数据：

1. 客户端发给 Helm 的请求。
2. Helm 发给 fake upstream 的请求。
3. Helm 返回给客户端的响应。

只有三者都满足保真规则，case 才能通过。

### 可执行命令

实现必须提供可本地执行的自动化命令：

```bash
pnpm test:passthrough:unit
pnpm test:passthrough:e2e
pnpm test:passthrough
pnpm test:passthrough:live:claude-cli
pnpm test:passthrough:live:codex-cli
pnpm test:passthrough:live
pnpm test:passthrough:final
```

命令含义：

- `pnpm test:passthrough:unit`：运行 helper、provider、route、pipeline 的快速单元测试。
- `pnpm test:passthrough:e2e`：启动 fake upstream + Helm 测试实例，运行 golden e2e cases。
- `pnpm test:passthrough`：运行上述两类确定性测试，作为无需真实 provider 的本地验收命令。
- `pnpm test:passthrough:live:claude-cli`：用真实 Claude CLI 调用本地 Helm，执行 live E2E。
- `pnpm test:passthrough:live:codex-cli`：用真实 Codex CLI 调用本地 Helm，执行 live E2E。
- `pnpm test:passthrough:live`：运行 Claude CLI 和 Codex CLI 两类 live E2E。
- `pnpm test:passthrough:final`：先运行 `pnpm test:passthrough`，再运行
  `pnpm test:passthrough:live`，作为合并/发布前最终验收命令。

`unit`、`e2e` 和 `test:passthrough` 必须能在没有真实 provider key 的环境中运行。
`live` 和 `final` 必须使用真实 CLI、真实 Helm 本地实例和真实 upstream credentials；
缺少 CLI 或 credentials 时，最终验收失败，不能静默跳过。

### Fake Upstream

验收框架需要一个本地 fake upstream server，至少支持：

- Anthropic `/v1/messages` non-stream 和 stream；
- Responses `/responses` 或 `/v1/responses` non-stream 和 stream；
- 捕获 method、url、headers、raw body bytes、parsed body；
- 返回 fixture 定义的 JSON 或 SSE；
- 模拟 401、429、529、5xx、stream 前失败、stream 中断；
- 暴露 captured requests 给测试断言。

捕获结构建议：

```ts
interface CapturedUpstreamRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  rawBody: Buffer;
  parsedBody?: unknown;
}
```

### Golden Fixtures

建议 fixture 目录结构：

```text
tests/fixtures/native-passthrough/
  anthropic/
    non-stream-raw-body/
      client-headers.json
      client-body.raw.json
      upstream-response.raw.json
      expected-upstream-headers.json
      expected-upstream-body.raw.json
      expected-client-response.raw.json
    stream-raw-sse/
      client-headers.json
      client-body.raw.json
      upstream-sse.raw
      expected-client-sse.raw
  responses/
    codex-store-forced-false/
      client-headers.json
      client-body.raw.json
      expected-upstream-body.raw.json
    stream-lifecycle-fidelity/
      client-headers.json
      client-body.raw.json
      upstream-sse.raw
      expected-client-sse.raw
```

fixture 必须故意覆盖容易出错的输入：

- 非标准 key 顺序；
- 未知 top-level 和 nested 字段；
- 多行字符串；
- 显式 `store: true`；
- session headers；
- SDK/fingerprint headers；
- denylisted headers；
- SSE comments、keepalives、unknown events；
- Responses lifecycle events，包括 upstream 自己的 `response.created`、`response.in_progress`、
  `response.completed` 和 upstream `response.id`。

### 自动断言规则

#### Headers

- header 比较必须大小写不敏感。
- denylisted headers 必须不存在于 upstream request。
- provider auth 必须覆盖客户端 auth。
- 非 denylisted 的客户端 identity/session headers 必须出现在 upstream request。
- `x-helm-*`、客户端 `authorization`、客户端 `x-api-key` 一旦到达 upstream，测试必须失败。

#### Body

- 如果 mutation ledger 表示 body 未修改，必须逐字节比较 upstream `rawBody` 和
  `client-body.raw.json`。
- 如果 body 被允许修改，比较 parsed JSON，并额外断言只有允许字段发生变化。
- 未知字段必须保留。
- `model` rewrite、memory append、`store_forced_false` 必须在 mutation ledger 中有记录。
- mutation ledger 中不得出现 secrets 或完整 body 内容。

#### Streaming

- Responses native stream 必须逐事件或逐字节证明：没有 Helm synthetic prelude、没有丢弃
  upstream prelude、没有改写 upstream `response.id`。
- Anthropic native stream 应优先逐字节比较客户端收到的 SSE 与 upstream SSE。
- 如果框架无法保证完全 byte-identical，则必须比较 event order、event names、data payload
  strings，并断言 mutation ledger 标记 `stream_reframed: true`。
- TCP chunk boundary 不作为断言目标，因为它不是稳定 HTTP 契约。

#### Governance

- 无效 Helm API key：fake upstream 不得收到请求。
- 被 rate limit 或 budget 拒绝的请求：fake upstream 不得收到请求。
- heterogeneous fallback chain：native passthrough 必须被禁用。
- 客户端 abort：不得记录为 provider breaker failure。

### 最小必过 E2E Cases

1. Anthropic non-stream，无 body mutation：raw body text 原样到 upstream，headers 按策略转发。
2. Anthropic non-stream，有 model rewrite：只有 `model` 改变，其他字段保留，ledger 记录。
3. Anthropic stream：SSE event/data、comments、keepalives、unknown events 按策略保留。
4. Responses non-stream，客户端 `store: true`：Codex profile 上游收到 `store: false`，
   ledger 记录 `store_forced_false`。
5. Responses stream lifecycle：客户端收到 upstream lifecycle events；无 Helm prelude；无 id rewrite。
6. Security negative：客户端 auth、`x-api-key`、`x-helm-*`、hop-by-hop headers 不到 upstream。
7. Governance negative：鉴权/限流/预算/fallback guard 能阻止不该发生的 upstream call。

### Live CLI E2E 最终验收

fake upstream 验收证明 Helm 的协议保真；live CLI 验收证明真实客户端能通过 Helm 工作。
两者缺一不可。最终合并/发布前必须执行 live CLI E2E，不能只用 curl 或模拟客户端替代。

#### Claude CLI

`pnpm test:passthrough:live:claude-cli` 必须：

- 调用本机安装的 `claude` CLI，而不是手写 Anthropic request。
- 将 Claude CLI 的 base URL / API key 指向本地 Helm 测试实例。
- 使用真实可用的 Anthropic/Claude upstream provider 配置。
- 发送一个低成本、确定性 prompt，例如要求模型回复固定短文本。
- 至少覆盖一次 streaming 响应。
- 断言 CLI 输出包含固定 sentinel，例如 `HELM_LIVE_OK`。
- 从 Helm telemetry/request detail 中提取 trace，断言该请求使用
  `anthropic_messages` native passthrough。
- 断言 mutation ledger 中只出现允许 mutation，例如 provider auth 替换、必要 header drop、
  model rewrite 或 memory append。
- 断言没有走 transformed path，没有泄露客户端 Helm credentials。

#### Codex CLI

`pnpm test:passthrough:live:codex-cli` 必须：

- 调用本机安装的 `codex` CLI，而不是手写 Responses request。
- 将 Codex CLI 的 base URL / API key 指向本地 Helm 测试实例。
- 使用真实可用的 ChatGPT/Codex 或 OpenAI Responses upstream provider 配置。
- 发送一个低成本、确定性 prompt，例如要求模型回复固定短文本。
- 至少覆盖一次 Responses streaming 响应。
- 断言 CLI 输出包含固定 sentinel，例如 `HELM_LIVE_OK`。
- 从 Helm telemetry/request detail 中提取 trace，断言该请求使用
  `openai_responses` native passthrough。
- 断言 Responses native stream 没有 Helm synthetic prelude、没有 id rewrite；若 CLI 本身
  不暴露原始 SSE，则必须通过 Helm payload capture 或 debug trace 验证。
- 对 ChatGPT/Codex backend，确定性 fake-upstream case 必须覆盖客户端显式
  `store: true` 时 `store_forced_false` 写入 mutation ledger；live CLI case 如果真实 CLI
  请求没有触发该 shim，则只断言 native passthrough 与 mutation ledger 无 secrets。

#### Live 验收产物

live 脚本必须输出机器可读报告，例如
`artifacts/passthrough-live-report.json`，至少包含：

- CLI 名称和版本；
- Helm base URL；
- trace id；
- provider alias/model；
- native passthrough 是否启用；
- mutation ledger 摘要；
- CLI 退出码；
- stdout/stderr 摘要；
- 固定 sentinel 输出断言；
- 是否通过每条断言。

报告不得包含 provider secrets、Helm API keys 或完整用户 prompt。

#### Live 验收边界

- live E2E 可以使用短 prompt 和低 token 上限控制成本。
- live E2E 允许因为真实 provider 暂时性 429/5xx 重试，但重试次数必须有限。
- 如果 provider 不可用，最终验收不能标记为通过；只能明确记录 blocked/fail。
- deterministic fake-upstream tests 仍然是 CI 级别的保真证明；live tests 是发布前真实客户端兼容性证明。

### TDD 开发要求

开发必须遵循红灯、绿灯、重构：

1. 先写验收测试和单元测试，确认它们在当前实现上失败。
2. 每个失败测试必须对应一个明确的 spec invariant。
3. 只写让当前红灯变绿的最小实现。
4. 绿灯后再重构，重构过程中保持 `pnpm test:passthrough` 通过。
5. 禁止先改实现再补测试。
6. 每个阶段完成时，都必须在 PR 或变更说明中列出运行过的验收命令。

本功能的开发完成定义不是“代码看起来符合 spec”，而是
`pnpm test:passthrough` 可重复通过；合并/发布前最终完成定义是
`pnpm test:passthrough:final` 通过。

## 实施计划

### Phase 1: TDD 自动化验收测试

先实现 `pnpm test:passthrough:unit`、`pnpm test:passthrough:e2e`、`pnpm test:passthrough`、
`pnpm test:passthrough:live:*` 和 `pnpm test:passthrough:final`。
在任何实现改动前，新增失败测试覆盖：

- native headers 除 denylisted/overwritten headers 外都被保留；
- 未知 native body 字段被保留；
- memory 关闭时，`model` 是默认唯一 body rewrite；
- memory injection 是尾部追加式；
- Anthropic native stream 保留 event/data payload，并在支持时保留 keepalives；
- Responses native stream 不合成 prelude、不丢弃上游 prelude、不改写 `response.id`；
- mutation ledger 记录每个修改且不包含 secrets。

### Phase 2: Native Carrier

用 typed native carrier 替换松散的 `metadata.native_request` object：

```ts
interface NativePassthroughCarrier {
  protocol: "anthropic_messages" | "openai_responses";
  body: Record<string, unknown>;
  rawBody?: string;
  headers: Record<string, string | string[]>;
  mutations: NativePassthroughMutationLedger;
}
```

route 应在可行时先捕获 raw body text，再解析 JSON。

### Phase 3: Header Passthrough Merge

新增共享 header 清理和 provider-specific merge 函数：

- `sanitizeNativePassthroughHeaders(headers)`
- `mergeAnthropicNativeHeaders(clientHeaders, providerHeaders, profile)`
- `mergeResponsesNativeHeaders(clientHeaders, providerHeaders, profile)`

### Phase 4: Raw Native Stream Branch

provider native stream 方法应该在 route 可以原样转发时暴露 upstream raw bytes/chunks。
route 应该 tee bytes 做 usage 和 payload capture，而不是拆分并重建协议事件。

如果框架路径无法保留 raw bytes，则保留当前 event/data splitter 作为 fallback，但标记
`stream_reframed: true`。

### Phase 5: Provider Profiles

增加显式 provider passthrough profile 配置，例如：

```yaml
providers:
  anthropic-official:
    native_passthrough:
      profile: anthropic_official_safe
      force_accept_encoding_identity: true
      merge_required_beta_headers: true
  codex-official:
    native_passthrough:
      profile: codex_official_safe
      default_store_false: true
```

### Phase 6: Docs 和 Admin 可见性

在 `implementation-notes.md`、provider config docs 和 admin request detail 中记录最终契约。
Admin telemetry 应显示是否使用 native passthrough，以及应用了哪些 mutations。

## 验收标准

- `pnpm test:passthrough` 是本功能的确定性自动化验收命令，并且必须稳定通过。
- `pnpm test:passthrough:final` 是合并/发布前最终验收命令，必须运行 Claude CLI 和 Codex CLI live E2E。
- Anthropic 和 Responses native passthrough 测试在实现前失败，实现后通过。
- native path 不会把客户端 Helm credentials 转发到上游。
- 未知字段能通过 native passthrough 保留。
- 客户端 identity/session headers 会保留，除非被显式 deny 或 overwrite。
- Responses native streams 不再收到 Helm synthetic prelude 或 id rewrite。
- memory injection 保持追加式，并在 mutation ledger 中可见。
- same-protocol fallback safety 继续强制执行。
- provider profile shims 默认关闭。
- fake upstream 验收不依赖真实 provider credentials 或外网服务。
- 所有允许 mutation 都必须在 mutation ledger 中可程序化断言。
- 最终验收必须生成 live CLI 机器可读报告，且报告不得包含 secrets。

## 已确认决策

### 1. ChatGPT/Codex Responses 中客户端显式发送 `store: true` 时怎么处理？

决策：选项 C。对 ChatGPT/Codex backend，静默覆盖为 `store: false`。

实现要求：

- 仅在 ChatGPT/Codex backend 或 `codex_official_safe` profile 生效。
- 如果客户端缺失 `store`，也设置为 `false`。
- 如果客户端显式发送 `store: true`，覆盖为 `false`。
- 对客户端不返回额外错误，但在 mutation ledger 中记录，例如
  `body_shims_applied: ["store_forced_false"]`。

理由：这是账号安全优先的特例。它会牺牲一点 body fidelity，但可以降低 Codex backend
因 storage 行为触发风险的概率。

### 2. 只有 headers 改变、body 不变时，是否转发原始 JSON 文本？

决策：选项 A。只要 body 未被修改，就转发 raw body text。

实现要求：

- route 捕获 raw body text。
- 如果没有 `model` 改写、memory injection、provider profile body shim，则 provider 转发
  raw body text。
- 如果 body 被修改，则重新序列化修改后的对象，并记录对应 mutation。

理由：这是最高保真策略，可以保留 key 顺序、空白和数字写法；安全风险不增加，
因为 Helm 已经解析过 JSON 用于验证和路由。

### 3. `accept-encoding: identity` 应该默认用于所有 native SSE providers，还是只用于官方 subscription profiles？

决策：选项 B。只在官方 subscription profiles 中强制 `identity`。

实现要求：

- 默认保留客户端 `accept-encoding`，除非 denylist 或 provider profile 要求覆盖。
- 在 `anthropic_official_safe` 等官方 subscription profile 中，可以强制
  `accept-encoding: identity`。
- 强制覆盖时记录 `accept_encoding_forced_identity: true`。

理由：CRS 的经验主要针对官方 subscription/Cloudflare SSE 稳定性；对所有 provider
默认强制会过度干预 header fidelity。

### 4. Sticky session routing 应该放在 provider OAuth account selection，还是 generic routing layer？

决策：选项 C。generic layer 提取 session key，provider/account layer 使用它。

实现要求：

- generic 层统一提取 session key，来源包括 `session_id`、`x-session-id`、
  `prompt_cache_key`、`conversation_id` 和稳定 metadata。
- provider/account 层负责 sticky account 选择、账号池状态、cooldown 和凭证可用性。
- 不同 provider 可以共享 session key 提取逻辑，但保留各自账号调度策略。

理由：session key 提取规则可以共享，避免重复实现；真正的 sticky account 选择属于
provider/account 层，因为不同 provider 的账号池、冷却和凭证状态不同。
