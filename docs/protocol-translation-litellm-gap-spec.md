# LiteLLM 对照下的协议互译缺口修复 Spec

## 0. 背景

本 spec 基于 `/Users/lukin/Projects/llm-router-packages/litellm` 的当前实现，对 Helm API 的四个客户端协议面做 route + transformer + executor 级别对照：

- OpenAI Chat Completions
- Anthropic Messages
- OpenAI Responses
- Google Gemini GenerateContent


状态说明：本文是完整缺口 backlog 和验收规格；证据索引和第 3 节各项的“现状”块来自本轮分析时的快照，不一定反映当前代码。截至目前，全部 P1 项（P1-RESP-01/02/03、P1-ANT-01/02、P1-CHAT-02、P1-GEM-01/02/03）以及本文列出的大部分 P2 项（P2-GEM-01/02、P2-RESP-03/04、P2-ANT-01、P2-CHAT-03/04）均已落地，并由 `scripts/protocol-compat/ast-grep-gates.sh`（经 `pnpm test:protocol-compat:ast` 调用）正向门禁强制保证实现存在。真正仍未实现的剩余项是 P3（P3-ANT-02 thinking-signature retry、P3-RESP-06 WebSocket）以及第 4 节明确声明的非目标。

相关实现已经整理到 wiki：

- `/Users/lukin/Projects/llm-router-packages/wiki/litellm/openai-chat-completions.md`
- `/Users/lukin/Projects/llm-router-packages/wiki/litellm/anthropic-messages.md`
- `/Users/lukin/Projects/llm-router-packages/wiki/litellm/openai-responses.md`
- `/Users/lukin/Projects/llm-router-packages/wiki/litellm/gemini-generate-content.md`
- `/Users/lukin/Projects/llm-router-packages/wiki/helm-api/openai-chat-completions.md`
- `/Users/lukin/Projects/llm-router-packages/wiki/helm-api/anthropic-messages.md`
- `/Users/lukin/Projects/llm-router-packages/wiki/helm-api/openai-responses.md`
- `/Users/lukin/Projects/llm-router-packages/wiki/helm-api/gemini-generate-content.md`
- `/Users/lukin/Projects/llm-router-packages/wiki/comparisons/protocol-compatibility-gap-analysis.md`

目标不是复制 LiteLLM，而是用 LiteLLM 作为 field-coverage 和 route-behavior reference，找出 Helm 在协议兼容、互译、生命周期、token helper、流式语义上的真实缺口。所有修复都必须保持 Helm 自己的治理能力：鉴权、rate limit、budget、routing、payload capture、telemetry、memory observe/inject 不可绕过。

## 1. 总原则

1. **客户端协议优先**：客户端发来的协议字段只要能安全传递，就不应被 Helm 提前拒绝、删除或重写。
2. **治理不可绕过**：auth、rate limit、concurrency、budget、routing、telemetry、payload capture、memory observe/inject 必须执行。
3. **直通优先于有损互译**：入站协议和目标 provider 协议一致时，优先 native passthrough；只有治理、安全或上游兼容需要才做显式、可记录的最小修改。
4. **跨协议才触发互译限制**：某些字段无法跨协议表达时，应在 provider-selection / protocol-guard 层处理，而不是在入站解析阶段提前拒绝。
5. **按目标协议过滤 provider_raw**：`provider_raw` 不是任意上游 body bag。Anthropic-only、Responses-only、Gemini-only 字段只能发给对应 native target 或被结构化拒绝/记录 warning。
6. **不在 core transformer 做网络 I/O**：远程媒体拉取、provider helper、token counting provider call 必须放在 gateway/provider 层，`packages/core/src/protocol` 保持纯函数。
7. **公开协议不能泄露内部字段**：`provider_raw`、mutation ledger、telemetry-only 信息不能出现在客户端协议响应 body，除非该协议本身定义了等价字段。
8. **TDD 强制**：每个修复点先写失败测试，再写最小实现，再重构。

## 2. 证据索引

本轮使用的关键 `ast-grep` 命令：

```bash
ast-grep --lang ts -p 'rejectUnsupportedPreviousResponseContinuation($ARG)' packages/core/src/protocol/responses.ts
ast-grep --lang ts -p '$APP.$METHOD($PATH, unsupportedLifecycle($OP))' apps/gateway/src/routes/responses.ts
ast-grep --lang ts -p 'responseStreamPrelude($$$)' apps/gateway/src/routes/responses.ts
ast-grep --lang ts -p 'convertOpenAIStreamToResponses($$$)' apps/gateway/src/routes/messages-pipeline.ts packages/core/src/protocol/responses-stream.ts
ast-grep --lang ts -p 'return c.json({ input_tokens: $EXPR })' apps/gateway/src/routes/messages.ts
ast-grep --lang ts --globs 'apps/gateway/src/routes/execute.ts' -p 'for (const $KEY of PROVIDER_RAW_FORWARD_KEYS) { $$$ }' .
ast-grep --lang ts --globs 'packages/core/src/provider/anthropic.ts' -p '$BETAS.add($VALUE)' .
ast-grep --lang ts -p 'if ($ROUTE === null) { $$$BODY }' apps/gateway/src/routes/gemini.ts
ast-grep --lang ts -p 'return [{ text: $TEXT }]' packages/core/src/protocol/gemini/gemini-transformer.ts
ast-grep --lang python -p '@router.post($$$ARGS)' /Users/lukin/Projects/llm-router-packages/litellm/litellm/proxy
ast-grep --lang python --globs 'litellm/llms/anthropic/experimental_pass_through/messages/handler.py' -p 'messages = strip_empty_text_blocks_from_anthropic_messages(messages)' /Users/lukin/Projects/llm-router-packages/litellm
```

重要匹配：

| 缺口 | Helm 证据 | LiteLLM 参考 |
|---|---|---|
| OpenAI Chat 生产路径绕过 content normalizer | `apps/gateway/src/routes/chat.ts:154-200`, `apps/gateway/src/routes/execute.ts:964-993` | `gpt_transformation.py:227-280`, `gpt_transformation.py:429-455` |
| OpenAI Chat 未清理 `cache_control` | `apps/gateway/src/routes/internal-request-params.ts:23-24`, `apps/gateway/src/routes/execute.ts:937-938` | `gpt_transformation.py:406-427` |
| Anthropic-only raw params 可泄露到 OpenAI target | `apps/gateway/src/routes/execute.ts:954-982`, `packages/core/src/provider/openai.ts:216-219` | `anthropic/.../adapters/handler.py:501-515` |
| Anthropic native passthrough 缺少空文本块 sanitizer | `packages/core/src/protocol/anthropic/request.ts:489-493`, `apps/gateway/src/routes/execute.ts:713-720` | `anthropic/.../messages/handler.py:216`, `handler.py:399` |
| Anthropic 响应泄露 `provider_raw` | `packages/core/src/protocol/anthropic/response.ts:182-191`, `response.ts:430-442`, `apps/gateway/src/routes/messages.ts:593` | `types/llms/anthropic_messages/anthropic_response.py:75-97` |
| Anthropic beta header 覆盖不足 | `packages/core/src/provider/anthropic.ts:172-184` | `anthropic/.../messages/transformation.py:397-473` |
| Anthropic `count_tokens` 是本地估算 | `apps/gateway/src/routes/messages.ts:226-261` | `anthropic_endpoints/endpoints.py:203-245` |
| Responses `previous_response_id` 在 native passthrough 前被拒绝 | `packages/core/src/protocol/responses.ts:294-315`, `responses.ts:379-382` | `responses/main.py:1008-1182` |
| Responses 生命周期接口是 unsupported stub | `apps/gateway/src/routes/responses.ts:177-189`, `responses.ts:505-512` | `response_api_endpoints/endpoints.py:446-936` |
| Responses 非原生流可能重复 prelude | `apps/gateway/src/routes/responses.ts:357-364`, `messages-pipeline.ts:1024-1035`, `responses-stream.ts:466-476` | `responses/streaming_iterator.py:120-1060` |
| Responses provider 是 Codex profile，不是 generic OpenAI Responses | `packages/core/src/provider/openai-responses.ts:1-436` | `llms/openai/responses/transformation.py:31`, `llms/openai_like/responses/transformation.py:17` |
| Gemini `countTokens` 缺失 | `apps/gateway/src/routes/gemini.ts:131-148` | `google_endpoints/endpoints.py:140-190` |
| Gemini `parametersJsonSchema` 丢失 | `packages/core/src/protocol/gemini/gemini-types.ts:84-90`, `gemini-transformer.ts:435-442` | `google_genai/adapters/transformation.py:332-344` |
| Gemini `responseJsonSchema` 忽略 | `packages/core/src/protocol/gemini/gemini-types.ts:101-128`, `gemini-transformer.ts:447-451` | `gemini/google_genai/transformation.py:57-98`, `transformation.py:338-348` |
| Gemini native upstream 缺失 | `apps/gateway/src/server.ts:646-689`, `messages-pipeline.ts:996-1015` | `google_genai/main.py:137-175`, `llm_http_handler.py:10855-10903` |
| Gemini 远程图片降级为文本占位 | `packages/core/src/protocol/gemini/gemini-transformer.ts:547-555` | `gemini/chat/transformation.py:114-162`, `vertex_ai/gemini/transformation.py:582-616` |

## 3. 缺口与修复方案

### P1-CHAT-01：OpenAI Chat 生产路径必须复用 OpenAI transformer 的 content normalization

**现状**

Helm 的 `/v1/chat/completions` route 通过 `toInternalRequest()` 手动构造 `InternalRequest`，执行阶段再通过 `stripInternal()` 手动构造 OpenAI-compatible body。核心 `openaiTransformer` 虽然能处理 `image_url`、`input_audio`、`file` 等 content part，但生产 route 没有使用它。

**问题**

LiteLLM 在 OpenAI Chat provider call 前会做内容清理：bare-string `image_url` 转为 `{ url }`；移除 LiteLLM-only `format`；HTTP(S) PDF URL in `file.file_id` 可转为 `file_data`；缺失 filename 时补默认文件名。Helm 生产路径可能把不兼容内容原样发到 OpenAI-like upstream。

**修改要求**

- 将 `/v1/chat/completions` 入站转换改为复用 `openaiTransformer.transformRequestOut()`，或把同一套 content normalization 提取成 route 和 transformer 共用的纯函数。
- `stripInternal()` 输出 OpenAI-compatible body 前必须调用同一套 IR-to-OpenAI native renderer。
- 不允许出现 transformer tests 通过但 route path 不经过同等 normalization 的双真源。
- HTTP(S) PDF materialization 不能放在 core transformer；如果实现，必须放在 provider/gateway 层并受配置控制。

**TDD 验收**

- route-level 测试：OpenAI Chat 请求中 `image_url: "https://..."` 到 fake upstream 时变成 `{ image_url: { url: "https://..." } }`。
- route-level 测试：`file.file_data` 缺 `filename` 时 provider body 有安全默认 filename；HTTP(S) `file_id` 的 materialization 若未启用，必须结构化 warning 或保持明确 non-goal。
- ast-grep gate：`toInternalRequest` / `stripInternal` 不能再成为 OpenAI Chat content normalization 的独立实现。

### P1-CHAT-02：OpenAI-compatible 上游请求必须清理 Anthropic-style `cache_control`

**现状**

Helm 把 top-level `cache_control` 作为请求参数复制并转发，messages/tools 中的 nested `cache_control` 也会随 `messages` / `tools` 原样进入 OpenAI-compatible upstream。

**问题**

LiteLLM 在 OpenAI Chat transform 中会递归删除 messages/tools 里的 `cache_control`。这些字段是 Anthropic prompt-cache 标记，不是 OpenAI Chat 标准字段。

**修改要求**

- target provider protocol 为 `openai_chat` 时：
  - 从 messages/tools 中递归删除 `cache_control`；
  - top-level `cache_control` 只允许进入 Anthropic native target，不应发送到 OpenAI-compatible target；
  - 删除动作写入 mutation/attempt warning，例如 `cache_control_stripped_for_openai`。
- Anthropic native passthrough 不受影响，仍保留合法 cache control。

**TDD 验收**

- OpenAI Chat route-level fake upstream：带 nested `cache_control` 的 message/tool 到上游时已清理。
- Anthropic target/route 测试：合法 cache control 不被错误删除。
- ast-grep gate：`FORWARDED_REQUEST_PARAM_KEYS` 中不能无条件向 OpenAI target 发送 `cache_control`。

### P1-ANT-01：Anthropic-only raw params 不能泄露到 OpenAI-compatible target

**现状**

Helm 的 `PROVIDER_RAW_FORWARD_KEYS` 会把 `context_management`、`mcp_servers`、`container`、`speed`、`output_config` 等 Anthropic/Responses 语义字段复制进 OpenAI-compatible request body。

**问题**

LiteLLM 非原生 Anthropic translation path 会显式排除 Anthropic-only raw keys。Helm 当前做法会让严格 OpenAI-compatible provider 400，也可能让语义字段以未知扩展形式进入错误 target。

**修改要求**

- 引入按 target protocol 过滤的 provider_raw renderer，例如 `renderProviderRawForTarget(providerRaw, targetProtocol)`。
- `openai_chat` target 默认只允许 OpenAI-compatible keys；Anthropic-only keys 必须被删除并记录 `provider_raw_stripped_for_openai`。
- `anthropic_messages` target 保留 Anthropic 合法 keys。
- `openai_responses` target 保留 Responses 合法 keys；不允许 Anthropic-only/Gemini-only keys 混入。
- 如果某字段对目标协议是强语义但不可执行，不要静默删除；应通过 protocol guard 返回结构化 `capability_unsatisfiable` 或记录明确 warning。

**TDD 验收**

- Anthropic request 携带 `context_management` / `mcp_servers`，fallback 到 OpenAI-compatible fake provider 时，上游 body 不含这些 keys，并有 mutation/warning。
- Anthropic native fake provider 收到相同字段时不被删除。
- ast-grep gate：`PROVIDER_RAW_FORWARD_KEYS` 不能作为无 target-protocol 判断的全局 forwarding list 使用。

### P1-ANT-02：Anthropic native passthrough 需要空文本块 sanitizer

**现状**

Helm 在 Anthropic request transformer 中保留 text block 原文。native passthrough 使用解析后的 native body 直接发给 Anthropic target。

**问题**

LiteLLM 在 native Anthropic dispatch 前会 strip empty/whitespace text blocks。Claude Code-style 历史中常见空文本 block 与 `tool_use` 并存；Anthropic 原生接口可能因此 400。

**修改要求**

- 在 gateway/provider native Anthropic dispatch 前执行 sanitizer：删除 `content[]` 中 `type:"text"` 且 `text.trim() === ""` 的 block。
- 只在 Anthropic native target 上应用；payload capture 仍保留客户端原始请求，provider attempt capture 记录上游实际发送 body。
- sanitizer 必须记录 mutation ledger，例如 `empty_anthropic_text_blocks_stripped:N`。
- 不允许删除非空文本、thinking、tool_use、tool_result、image/document block。

**TDD 验收**

- native Anthropic fake upstream：空文本 block 被删除，tool_use/tool_result 保留。
- payload capture 测试：inbound 原始请求仍可见空文本；outbound attempt 或 mutation ledger 记录 sanitizer。
- cross-protocol OpenAI target 不走 Anthropic native sanitizer，而是通过目标 renderer 处理。

### P1-RESP-01：Responses `previous_response_id` continuation 不应在入站阶段阻断 native passthrough

**现状**

Helm 的 `toIRRequest` 在解析 Responses 请求后立即调用 `rejectUnsupportedPreviousResponseContinuation(parsed)`。当请求包含 `previous_response_id`，并且 input 里只有 `function_call_output`、没有同请求内的 `function_call` 历史时，会直接抛错。

**问题**

这对跨协议翻译是合理防御，但对 same-protocol Responses native passthrough 是错误的。真实 OpenAI/Codex Responses 上游可以用 `previous_response_id` 找到 provider-side history，Helm 不应提前 400。

**修改要求**

- 将 `previous_response_id` continuation 检查从入站 transformer 移出。
- 在 `protocol-guards` 或 provider-selection 阶段判断：
  - target protocol 是 `openai_responses` 且 native passthrough 可用：允许原请求继续。
  - target protocol 不是 `openai_responses`，且本地没有足够 function-call history：返回结构化 `capability_unsatisfiable` 或 `invalid_request`，并写明原因。
- `provider_raw.previous_response_id` 必须继续保留。
- telemetry 里记录 guard 决策：`responses_previous_response_id_native_passthrough` 或 `responses_previous_response_id_cross_protocol_blocked`。

**TDD 验收**

- `packages/core/src/protocol/responses.test.ts`：`previous_response_id + function_call_output` 不再在 `transformRequestOut` 阶段 throw。
- route-level deterministic e2e：same-protocol native Responses fake provider 收到原始 `previous_response_id` 请求。
- cross-protocol target 测试：同样请求不能被错误翻译成无历史 tool result；必须结构化拒绝。

### P1-RESP-02：Responses 生命周期接口不能永远停在 unsupported stub

**现状**

Helm 已注册以下路径，但全部返回 authenticated unsupported error：

- `POST /v1/responses/compact`
- `POST /v1/responses/input_tokens`
- `GET /v1/responses/:response_id/input_items`
- `POST /v1/responses/:response_id/cancel`
- `GET /v1/responses/:response_id`
- `DELETE /v1/responses/:response_id`

LiteLLM 对应实现支持 polling state 或 provider pass-through。

**修改要求**

分两阶段实现，不允许假成功。

#### Phase A：输入 token helper

- 实现 `POST /v1/responses/input_tokens`、`/responses/input_tokens`、`/openai/v1/responses/input_tokens`。
- 优先 provider-native token counter；没有 provider 支持时返回确定性本地估算，并在响应里标注 `estimated: true`。
- 保持 OpenAI-shaped error envelope。

#### Phase B：状态型生命周期

新增 Responses object registry：

```text
response_id -> account_id, key_id, provider_alias, provider_model, provider_protocol, created_at, expires_at, status
```

- create route 在 `store:true`、`background:true` 或 provider 返回持久 response id 时写 registry。
- retrieve/delete/cancel/input_items 先查 registry；找不到返回 OpenAI-compatible 404，而不是 unsupported。
- 找到且 provider client 支持 lifecycle method：转发到 provider。
- 找到但 provider 不支持：返回 structured unsupported/capability error。
- `compact` 有 request body 和 model 时可走正常 routing；没有可执行 provider 时返回 structured unsupported。

**TDD 验收**

- 当前 `unsupportedLifecycle` 的 ast-grep 匹配在 Phase A/B 对应完成后必须减少到只剩明确非目标项，最终目标为 0。
- fake Responses provider 覆盖 retrieve/delete/cancel/input_items/compact 正常路径。
- registry 404、provider unsupported、auth failure 都必须有 OpenAI-shaped error。

### P1-RESP-03：Responses 非原生 streaming 不能重复 prelude

**现状**

Helm Responses route 在 `pipeline.run()` 后对非 native passthrough 手动写入 `responseStreamPrelude(...)`。但 pipeline 的 `openai_responses` 分支已经使用 `convertOpenAIStreamToResponses(...)`，该 converter 无条件 yield `response.created` 与 `response.in_progress`。

**问题**

客户端可能收到两组 `response.created` / `response.in_progress`，sequence number 和 response object 状态可能冲突。这违反 Responses SSE 单一状态机原则。

**修改要求**

- 只保留一个 prelude 生成点。
- 推荐保留 `convertOpenAIStreamToResponses()` 内部 prelude，因为它掌握 stream state machine；route 不再补发 prelude。
- native passthrough 继续完全以 provider upstream frames 为准。
- 对 empty/zero-chunk stream 仍必须有完整 created/in_progress/completed 或 error 终止。

**TDD 验收**

- route-level streaming fake upstream：非 native Responses stream 中 `response.created` 和 `response.in_progress` 各出现一次。
- zero-chunk stream 仍有合法 terminal frame。
- native passthrough stream 不出现 Helm synthetic prelude。
- ast-grep gate：`apps/gateway/src/routes/responses.ts` 不再调用 `responseStreamPrelude(...)`。

### P1-GEM-01：Gemini `countTokens` 缺失

**现状**

LiteLLM 注册 `/v1beta/models/{model_name:path}:countTokens` 和 `/models/{model_name:path}:countTokens`。Helm 的 Gemini route 只接受 `generateContent` / `streamGenerateContent`，其他操作统一 404。

**修改要求**

- `parseGeminiPath` 增加 `countTokens` operation。
- route 注册仍可复用 catch-all，但 `countTokens` 分支不能进入 generation pipeline。
- 输出兼容 Gemini `countTokens`：至少包含 `totalTokens`，可选 `totalBillableCharacters` 和 `promptTokensDetails`。
- 计数策略：
  1. 如果 path model 解析到 native Gemini provider 且 provider 支持 token count，转发 provider count。
  2. 否则使用 deterministic local estimator，并返回 `estimated: true`。
- 仍执行 auth/rate-limit/concurrency；不写 completion cost。

**TDD 验收**

- `/v1beta/models/gemini-foo:countTokens` 返回 200 Gemini shape。
- `/models/publishers/google/models/gemini-foo:countTokens` 支持 path-style model。
- malformed body 返回 Gemini `INVALID_ARGUMENT`。
- `ast-grep --lang ts -p 'if ($ROUTE === null) { $$$BODY }' apps/gateway/src/routes/gemini.ts` 不能再把 `countTokens` 归入 unsupported path。

### P1-GEM-02：保留 Gemini `parametersJsonSchema` 工具参数 schema

**现状**

LiteLLM 的 Google GenAI adapter 会把 `functionDeclarations[].parametersJsonSchema` 映射到 OpenAI function `parameters`。Helm 的 Gemini schema 只声明 `parameters`，并且 transformer 只读取 `d.parameters`。由于 schema `.passthrough()`，`parametersJsonSchema` 不会报错，但会在转换时丢失。

**修改要求**

- `GeminiFunctionDeclarationSchema` 增加 `parametersJsonSchema`。
- native Gemini -> IR 时，参数 schema 取值优先级：`parametersJsonSchema` > `parameters`。
- IR -> Gemini native 时，根据目标 provider/profile 决定输出 `parameters` 或 `parametersJsonSchema`，默认保持 REST `parameters`，Google GenAI native profile 输出 `parametersJsonSchema`。

**TDD 验收**

- native request 只带 `parametersJsonSchema` 时，IR tool `function.parameters` 不为空。
- same-protocol round-trip 不丢 schema。
- cross-protocol OpenAI target 能收到 OpenAI function `parameters`。

### P1-GEM-03：支持 Gemini `responseJsonSchema` / `response_json_schema`

**现状**

LiteLLM 支持较新的 Google GenAI `response_json_schema` / `responseJsonSchema`，并按模型能力从 `response_schema` 归一。Helm 只识别 `generationConfig.responseSchema`。

**修改要求**

- `GeminiGenerationConfigSchema` 增加 camelCase `responseJsonSchema`；如果需要 SDK-shape 兼容，也接受 snake_case `response_json_schema`。
- inbound Gemini -> IR structured output 取值优先级：`responseJsonSchema` / `response_json_schema` > `responseSchema`。
- outbound IR -> Gemini 时，根据 provider/profile 输出 `responseSchema` 或 `responseJsonSchema`；默认 REST 兼容用 `responseSchema`，Google GenAI profile 可用 `responseJsonSchema`。

**TDD 验收**

- `generationConfig.responseJsonSchema` 能转成 IR `response_format`。
- `response_json_schema` SDK-shape 输入不丢。
- outbound profile 测试证明字段名可配置。

### P2-ANT-03：Anthropic 响应不能暴露内部 `provider_raw`（已解决）

**现状**

已解决：客户端可见的 Anthropic response body 不再暴露 `provider_raw`。`packages/core/src/protocol/anthropic/response.ts:410` 的注释明确说明 the public Anthropic response body never exposes provider_raw；raw stop reason、usage、tool-name map 仅存在于 IR/telemetry 路径，不进入客户端响应 body。下文保留为最初分析快照与验收口径。

**问题**

LiteLLM/Anthropic public response shape 没有 `provider_raw`。该字段不一定是 secret，但属于内部调试/telemetry 信息，会破坏协议保真。

**修改要求**

- 客户端响应 body 不再包含 `provider_raw`。
- 需要保留的信息写入 telemetry、payload capture、attempt metadata 或 mutation ledger。
- 若 tool-name reverse map 是协议转换必需信息，应只存在于内部 stream/response assembly state，不能返回给客户端。

**TDD 验收**

- Anthropic translated non-stream response body 不含 `provider_raw`。
- Anthropic stream terminal/metadata frames 不含 `provider_raw`。
- telemetry 仍能看到必要调试信息。

### P2-ANT-04：补齐 Anthropic feature beta header 覆盖

**现状**

Helm 只根据 `context_management`、compact edit、`speed:"fast"` 添加 beta headers。LiteLLM 还会根据 structured output、advisor、tool-search 等能力加 beta。

**修改要求**

- 根据 Helm 已支持或计划支持的 Anthropic native fields，补齐 beta header mapping：
  - `output_format` / `output_config` -> structured output beta；
  - advisor tools -> advisor beta；
  - tool-search tools -> tool-search beta。
- 如果 Helm 尚不执行某能力，应在 protocol guard 中明确拒绝或 warning，不要只加 header 假装支持。
- Header 合并要保留客户端原有 `anthropic-beta`，去重，顺序稳定。

**TDD 验收**

- fake Anthropic provider：带 `output_config` 的请求包含 structured output beta。
- advisor/tool-search 请求要么带正确 beta 并执行，要么结构化拒绝。
- 客户端传入 beta header 不被覆盖。

### P2-ANT-01：Anthropic `count_tokens` 应从本地粗估升级为 provider-first / tokenizer-backed

**现状**

Helm 现在只返回 `estimateAnthropicInputTokens(native)`。这可以防止 Claude Code 404，但不是协议准确实现。

**修改要求**

- 保留现有 `/v1/messages/count_tokens` route 和 auth 行为。
- 优先使用 provider-native count tokens 或 shared tokenizer service。
- provider 不支持时返回本地估算，但必须带 `estimated: true` 或在 telemetry 中记录 `count_tokens_estimated`。
- 不允许因为计数失败影响普通 `/v1/messages` generation。

**TDD 验收**

- fake Anthropic provider count 返回准确值时，Helm 返回 provider 值。
- provider 不支持时，Helm 返回估算值并标记 estimated。
- 认证失败仍是 Anthropic error envelope。

### P2-RESP-04：区分 Codex-profile Responses provider 与 generic OpenAI Responses provider

**现状**

Helm 的 `openai-responses` provider 是 Codex/ChatGPT subscription profile，带有固定 `store:false`、`stream:true`、`include:["reasoning.encrypted_content"]`、`text.verbosity` 等行为。LiteLLM 同时有 generic OpenAI/OpenAI-like Responses provider configs。

**修改要求**

- 在 provider config/schema 中显式区分：
  - `openai_responses_generic`：OpenAI `/v1/responses` generic provider；
  - `codex_responses` 或现有 profile：Codex/ChatGPT subscription provider。
- generic provider 必须按 Responses 原生协议转发合法 optional params，不强加 Codex defaults。
- Codex profile 的特殊默认值继续保留，但文档和 telemetry 必须说明它不是 generic OpenAI Responses。

**TDD 验收**

- generic fake provider 收到客户端 Responses body 中的 `include`、`background`、`max_output_tokens` 等合法字段。
- Codex profile 仍保持当前需要的 subscription-specific defaults。
- provider selection 根据 config protocol/profile 选择正确 executor。

### P2-RESP-05：Responses translated fallback 需要明确参数保真边界

**现状**

Helm native passthrough 可以保留完整 raw body；但一旦进入 translated fallback，只有部分 Responses optional params 会进入 IR/provider_raw，`include`、`background` 等字段可能丢失。

**修改要求**

- 扩展 Responses schema/provider_raw，保留 OpenAI Responses 合法 optional params。
- same-protocol native target 原样转发。
- translated target 中无法执行的字段必须进入 guard/warning，而不是静默丢弃。
- `background:true` 若没有 lifecycle registry 支持，必须结构化拒绝或降级为 documented warning；不允许假装 background 成功。

**TDD 验收**

- Responses request with `include` / `background` / `max_output_tokens` 在 native fake provider 中不丢。
- non-native translated target 对不可执行字段产生 structured guard/warning。
- payload capture 保留客户端原始 body。

### P2-CHAT-03：OpenAI-compatible streaming 需要 reasoning alias normalization

**现状**

Helm OpenAI provider stream 逐 chunk yield 原始上游 bytes，Chat route 直接写给客户端。LiteLLM 对部分 OpenAI-compatible providers 的 `delta.reasoning` 做 `delta.reasoning_content` 归一。

**修改要求**

- 默认继续保持 OpenAI streaming byte forwarding。
- 当 provider profile 标记需要 reasoning alias normalization 时，启用 streaming frame transformer：
  - `choices[].delta.reasoning` -> `choices[].delta.reasoning_content`；
  - 不改变其他 data frame；
  - 保留 `[DONE]`。
- normalization 必须记录 `stream_reframed:true` 或 provider-profile mutation。

**TDD 验收**

- fake upstream 发 `delta.reasoning`，profile 开启时客户端看到 `reasoning_content`。
- profile 关闭时 byte forwarding 保持不变。

### P2-CHAT-04：OpenAI Chat response model restamping 策略需要明确

**现状**

LiteLLM 会把 Chat response 的 model 处理为客户端请求模型/别名。Helm 当前返回 provider body，路由身份主要在 headers/telemetry 里。

**推荐方案**

- 默认不改 response body，避免破坏真实 provider identity。
- 增加可配置 `response_model_policy`：
  - `provider`：保持 provider 返回，默认；
  - `requested_alias`：对 OpenAI-compatible clients 返回请求 model/lane；
  - `both`：body 保持 provider，增加 `x-helm-requested-model` / `x-helm-provider-model`。
- docs 明确此项是兼容策略，不是 transformer bug。

**TDD 验收**

- 默认行为保持现有。
- `requested_alias` 配置开启时 response `model` 为请求 model，telemetry 仍记录 provider model。

### P2-GEM-01：新增 Gemini native upstream provider client

**现状**

Helm 能接收 Gemini 客户端请求，但 provider 创建逻辑没有 Gemini-native 分支；除 Anthropic/OpenAI Responses 特例外，默认走 OpenAI-compatible client。Gemini response 是从 OpenAI SSE/JSON 映射回 Gemini。

**修改要求**

- 增加 provider protocol/type，例如 `gemini` 或 `google-genai`。
- provider client 支持：
  - `generateContent` non-stream；
  - `streamGenerateContent?alt=sse`；
  - 可选 `countTokens`。
- same-protocol Gemini client -> Gemini provider 时，优先 native passthrough 或 native transformer，不走 OpenAI bridge。
- 保留治理和 telemetry。

**TDD 验收**

- fake Gemini provider 收到 native GenerateContent body，不是 OpenAI Chat body。
- streaming fake Gemini SSE 到客户端仍是 Gemini nameless `data:` frames，无 `[DONE]`。
- fallback 到 OpenAI-compatible provider 时现有 bridge 行为不破坏。

### P2-GEM-04：保留 Google GenAI 高级 optional params

**现状**

LiteLLM 支持 `routing_config`、`model_selection_config`、`labels`、`media_resolution`、`speech_config`、`audio_timestamp`、`automatic_function_calling`、`image_config` 等 Google GenAI 参数。Helm 目前只映射 generationConfig 的核心子集。

**修改要求**

- 无通用 IR home 的 Google GenAI 参数进入 `provider_raw.google_genai`。
- same-protocol Gemini native provider 时原样重放。
- cross-protocol target 时触发 warning 或 capability guard，不能静默丢失关键执行参数。

**TDD 验收**

- native Gemini -> Gemini native round-trip 保留这些参数。
- native Gemini -> OpenAI target 时记录 `provider_raw_not_executable` 或明确 warning。

### P2-GEM-02：Gemini 远程媒体转换需要 provider 层可选实现

**现状**

OpenAI/Responses 的 remote image URL 翻译到 Gemini native target 时，Helm 在 core transformer 中输出文本占位。LiteLLM 对 Google AI Studio 可以将 HTTPS 图片/文件转为 base64，对 Vertex 可以在可判定 mime type 时使用 `file_data`。

**修改要求**

- 不在 `packages/core/src/protocol/gemini` 发起网络请求。
- 新增 provider/gateway 层 media materializer：
  - `remote_media_fetch.enabled` 默认 `false`，配置开启后才 fetch。
  - 只允许 `https://`，限制 content-length、mime type、timeout、redirect 次数。
  - fetch 后生成 `inlineData` 或 provider-accepted `fileData`。
  - 所有 fetch 行为写 telemetry，不能记录媒体原文或 secret URL query。
- 如果未开启 fetch，继续显式降级，但要在 `provider_raw.warnings` 或 decision attempt 中记录 `remote_media_not_materialized`。

**TDD 验收**

- core transformer 仍是纯函数，无 fetch/http import。
- provider helper 在配置开启时把 fake HTTPS media 转为 Gemini `inlineData`。
- 配置关闭时返回现有占位或 structured warning。

### P2-RESP-03：Responses MCP / file_search 语义目前只保形，不执行

**现状**

Helm Responses transformer 保存 raw tools，但没有 LiteLLM 的 MCP gateway、file_search emulation、或 native tool execution dispatch。

**修改要求**

先做产品决策：

- **推荐方案 A**：短期把 MCP/file_search 标为明确 non-goal，但必须在 protocol guard 中结构化拒绝，不能假装执行。
- **方案 B**：实现 provider-native Responses tool pass-through，只在 target 是 `openai_responses` 且 provider 支持时允许。
- **方案 C**：实现 Helm 自己的 MCP/file_search execution layer，成本最高，不建议本轮做。

本 spec 推荐先选 A + B 的组合：跨协议拒绝，same-protocol native provider pass-through。

**TDD 验收**

- Responses request 带 `tools:[{type:"mcp"}]` 时：
  - native Responses target：原样到 fake upstream。
  - non-Responses target：结构化拒绝，不静默变成 OpenAI function tool。
- `file_search` 同理。

### P3-ANT-02：Anthropic invalid thinking signature retry

**现状**

LiteLLM 有 provider-error recovery hook：遇到 Anthropic invalid thinking signature 时，strip thinking blocks 后重试。Helm 目前只保留 thinking/redacted_thinking，不做该 retry。

**修改要求**

- 暂不作为 P1。
- 如果线上出现该错误，再在 Anthropic provider executor 加一次性 retry。
- retry 必须记录 mutation ledger：`thinking_signature_retry_stripped:true`。
- 只匹配明确的 Anthropic invalid thinking signature 错误，不能泛化 strip thinking。

### P3-ANT-05：Anthropic `max_tokens` 严格性差异

LiteLLM native Anthropic path 要求 `max_tokens`，Helm 目前允许缺省并在 outbound Anthropic request 中补默认值。建议保持 Helm 的更宽松 client surface，但在 docs 中标记为有意差异；如果未来要 strict parity，可通过配置开启 `anthropic_require_max_tokens:true`。

### P3-RESP-06：Responses WebSocket 与未知事件覆盖

LiteLLM 有 Responses WebSocket route，Helm 当前没有。除非 Codex/SDK live e2e 证明必须支持，否则本轮只记录 non-goal。非 passthrough Responses event coverage 也窄于 LiteLLM；native passthrough 是优先解法，translated fallback 若遇到未知 event，应记录 data-loss warning 或引入 generic event carrier。

## 4. 非目标 / 明确差异

- `/api/event_logging/batch`：LiteLLM 是 unauthenticated stub；Helm 保持 authenticated stub。原因：Helm 强制 API key 鉴权，这是安全边界，不为了兼容放开。
- 不把 LiteLLM 的全部 provider-specific 行为复制到 core transformer。
- 不在没有 registry/provider support 的情况下伪造 Responses retrieve/delete/cancel 成功。
- 不为追求兼容而绕过 budget/rate/concurrency/memory/telemetry。
- 不在 core transformer 中 fetch 远程媒体。
- 默认不 restamp OpenAI Chat response `model`；除非配置显式要求。

## 5. 自动化验收

### 5.1 ast-grep / structural gates

已新增可执行脚本 `scripts/protocol-compat/ast-grep-gates.sh`，并通过 `pnpm test:protocol-compat:ast` 调用。完整 backlog 继续推进时，在该脚本中逐步移除白名单/补充 P1/P2 门禁：

当前首批实现门禁至少覆盖：Responses stream prelude 不重复、`provider_raw` target-aware、Anthropic empty-text sanitizer、`cache_control` 不再无条件转发。后续 P1/P2 完成后，把下列目标门禁逐项收紧到脚本中。

```bash
#!/usr/bin/env bash
set -euo pipefail

# P1-RESP-01 完成后：入站 transformer 不应再直接调用这个拒绝函数。
! ast-grep --lang ts -p 'rejectUnsupportedPreviousResponseContinuation($ARG)' packages/core/src/protocol/responses.ts

# P1-RESP-02 完成后：Responses 生命周期不应仍然指向 unsupportedLifecycle。
! ast-grep --lang ts -p '$APP.$METHOD($PATH, unsupportedLifecycle($OP))' apps/gateway/src/routes/responses.ts

# P1-RESP-03 完成后：route 不应再补发 Responses stream prelude。
! ast-grep --lang ts -p 'responseStreamPrelude($$$)' apps/gateway/src/routes/responses.ts

# P1-GEM-01 完成后：Gemini route/parser 应显式处理 countTokens。
ast-grep --lang ts -p '$OP === "countTokens"' packages/core/src/protocol/gemini/gemini-transformer.ts apps/gateway/src/routes/gemini.ts

# P1-ANT-01 完成后：provider_raw forwarding 必须通过 target-aware renderer。
ast-grep --lang ts -p 'renderProviderRawForTarget($RAW, $TARGET)' apps/gateway/src/routes/execute.ts packages/core/src/**/*.ts

# P1-ANT-02 完成后：Anthropic native dispatch 前必须有 sanitizer。
ast-grep --lang ts -p 'stripEmptyAnthropicTextBlocks($MESSAGES)' apps/gateway/src/routes/execute.ts
```

如果某个阶段故意保留部分 unsupported，需要脚本允许精确白名单，不允许宽松忽略。

### 5.2 单元测试

必须覆盖：

- OpenAI Chat content normalization shared by route + transformer。
- OpenAI target 清理 nested/top-level `cache_control`，Anthropic target 不误删。
- Anthropic-only provider_raw 在 OpenAI-compatible target 上被过滤并记录 warning。
- Anthropic native empty text blocks sanitizer 只删除空 text block。
- Anthropic translated response 不含 `provider_raw`。
- Anthropic beta header merge 去重、保留客户端 header、补齐 supported feature betas。
- Responses `previous_response_id` continuation 不在 transformer 阶段 throw。
- Responses cross-protocol guard 能拒绝无本地历史的 continuation。
- Responses stream prelude 只出现一次，zero-chunk stream 仍完整终止。
- Gemini `parseGeminiPath` 支持 `countTokens`。
- Gemini `parametersJsonSchema` / `responseJsonSchema` 不丢失。
- Anthropic/Gemini/Responses token helper 的 provider-first 与 fallback-estimated 两条路径。
- Gemini remote media materializer 的 on/off 行为和安全限制。

### 5.3 路由级 deterministic e2e

必须用真实 Hono app + fake providers，不允许直接调用 provider client 代替路由：

- `POST /v1/chat/completions` with bare-string `image_url`，fake OpenAI upstream 收到 normalized body。
- Anthropic request with `context_management` fallback 到 OpenAI provider，fake upstream 不收到 Anthropic-only raw keys。
- Anthropic native request with empty text block，fake Anthropic upstream 收到 sanitized body，payload capture 仍保留原始 inbound body。
- Anthropic translated response body 不含 `provider_raw`。
- `POST /v1/responses` with `previous_response_id + function_call_output`，native Responses fake upstream 收到原始 body。
- Responses streaming fake upstream：`response.created` / `response.in_progress` 各出现一次。
- Responses retrieve/delete/cancel/input_items/compact/input_tokens 路由返回正确 shape。
- Gemini `:countTokens` 在 `/v1beta/models` 和 `/models` 两个 path family 都成功。
- Gemini tool `parametersJsonSchema` 和 `generationConfig.responseJsonSchema` 到 fake upstream/IR 不丢失。
- Anthropic `/v1/messages/count_tokens` provider count 成功和 fallback estimate 成功。
- governance reject 时 fake upstream 调用次数为 0。

### 5.4 live e2e 最终验收

实现完成后必须补一轮 live integration，覆盖真实客户端行为：

- Claude CLI through Helm `/v1/messages`：包含 tool_use/tool_result、空文本块、streaming、count_tokens helper；确认不会因为 sanitizer/headers 破坏 Claude CLI。
- Codex CLI through Helm `/v1/responses`：包含 `previous_response_id` continuation、streaming、function_call_output、native passthrough；确认 Responses stream 没有重复 prelude。
- Gemini SDK or curl-equivalent：`generateContent`、`streamGenerateContent?alt=sse`、`:countTokens`。
- OpenAI Chat curl-equivalent：vision content、cache_control 清理、reasoning alias profile（如果启用）。

live e2e 允许使用测试 key / fake provider where possible；但 Claude CLI 和 Codex CLI 的真实客户端路径必须至少跑一次 smoke，输出 trace_id，并在 PR 描述中记录。

### 5.5 回归套件

每次实现后至少运行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

如果改动触及流式协议，还必须运行相关 e2e：

```bash
pnpm test:e2e
```

## 6. 实施顺序

1. P1-RESP-03：先修 Responses duplicate prelude，风险小、验证清晰，避免 live Codex 流式误判。
2. P1-ANT-01：按 target protocol 过滤 provider_raw，防止跨协议泄露导致 provider 400。
3. P1-ANT-02：加 Anthropic empty text sanitizer，保护 Claude CLI/tool history。
4. P1-CHAT-01 / P1-CHAT-02：统一 OpenAI Chat route 与 transformer 真源，并按 target protocol 清理 `cache_control`。
5. P1-RESP-01：修 Responses continuation 过早拒绝。这是 native Responses/Codex 忠实直通的最大风险。
6. P1-GEM-01：补 Gemini `countTokens`，这是 SDK 兼容面最清晰的缺口。
7. P1-GEM-02 / P1-GEM-03：补 Gemini `parametersJsonSchema` 和 `responseJsonSchema` 保真。
8. P2-ANT-03 / P2-ANT-04：去掉公开 `provider_raw`，补齐 beta header policy。
9. P2-ANT-01：把 Anthropic count_tokens 升级为 provider-first；保留估算 fallback。
10. P1-RESP-02 Phase A：实现 Responses `input_tokens`。
11. P1-RESP-02 Phase B：实现 Responses registry + lifecycle provider pass-through。
12. P2-RESP-04 / P2-RESP-05：区分 generic OpenAI Responses 与 Codex profile，补 Responses optional-param fidelity。
13. P2-CHAT-03 / P2-CHAT-04：按 provider profile / config 补 streaming reasoning alias 与 response model policy。
14. P2-GEM-01：新增 Gemini native upstream provider client。
15. P2-GEM-02：按配置实现 remote media materializer。
16. P2-GEM-04：保留 Google GenAI 高级 optional params。
17. P2-RESP-03：对 MCP/file_search 做明确 guard；只在 same-protocol native provider 支持时 pass-through。
18. P3-ANT-02 / P3-ANT-05 / P3-RESP-06：只有出现真实错误证据或客户端需要后再做。

## 7. 完成定义

- wiki 里的四协议实现与对比已更新到当前代码行号。
- 本 spec 中每个 P1/P2 项都有红/绿测试。
- ast-grep 门禁可以在 CI 或本地一键运行。
- deterministic route e2e 覆盖 fake providers 与治理拦截。
- Claude CLI 与 Codex CLI live e2e smoke 已执行，并在 PR 描述中记录 trace_id / 命令 / 结果。
- 对客户端可见的协议行为不再依赖隐式 404、假成功、重复 prelude 或提前丢字段。
- 任何仍保留的 LiteLLM 差异都在 docs 中明确标为 non-goal，并有安全/架构理由。
