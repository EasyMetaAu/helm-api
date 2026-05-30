# 调研笔记

## Manifest

GitHub: https://github.com/mnfst/manifest

Manifest 是一个面向智能体和 AI 应用的智能模型路由器。它会把每个请求路由到能够处理它的最便宜的模型上。

有价值的思路：

- 本地、确定性的复杂度打分。
- 23 个维度：关键词、结构以及上下文信号。
- 四个层级：简单、标准、复杂、推理。
- 针对具体任务的检测，涵盖编程、网页浏览、数据分析、图像生成、视频生成、社交媒体、邮件、日历以及交易。
- 针对简短后续消息的会话惯性（session momentum）。

值得借鉴：

- 廉价的本地分类器。
- 可解释的复杂度与任务信号。
- 针对简短后续消息的惯性机制。

不要盲目照搬：

- 模型市场（model-market）的定位。
- 把广泛的供应商接入作为产品的主要呈现面。

落地补充（扫描源码后确认）：

- 仓库确认即 `mnfst/manifest`（TypeScript，NestJS + SolidJS，**MIT**，可借鉴）。companion 测试器在 `mnfst/wingman`。
- "23 维" = 14 个关键词维度 + 9 个结构/上下文维度；关键词通过一棵 trie 一次性匹配。
- 四档边界（`scoring/config.ts`）：`simple < -0.10 ≤ standard < 0.08 ≤ complex < 0.35 ≤ reasoning`。
- 置信度：`confidence = sigmoid(k=8 · 到最近边界的距离)`；< 0.45 视为不确定，降级到 standard。
- 硬覆盖：`HEARTBEAT_OK` → simple；形式逻辑关键词 → reasoning；带 tools → 下限 standard；> 50k token → 下限 complex；< 50 字符且无复杂信号 → simple。
- 会话动量：按 `x-session-key` 存最近 5 条、30 分钟 TTL；短消息（< 30 字符）历史权重最高可达 60%，> 100 字符则关闭动量。
- 任务检测：维度→类目映射 + 工具名前缀（`browser_`/`code_`/`gmail_`…）+ 结构信号（URL、≥40 字符代码块、文件路径、堆栈）；`web_browsing` 激活阈值特意调高到 3.0。
- **可移植边界**：维度名/权重/关键词/边界/阈值都是数据，可直接搬成 `classifier.yaml`（约 90% 调参面）；约 9 个结构打分函数、正则信号、覆盖控制流需要用代码实现。

## llm-router probe（评估小模型的来源）

llm-router 的 5 段流水线里第 2 段 "probe" 就是一个经济型 LLM 预分类器，是 Helm 第 2 层 eval 的直接参考。

复用的设计：

- strict-JSON 输出 + Zod 校验；`temperature:0`、非流式。
- 双超时硬化：runner 内 `Promise.race`（500/300ms）+ consumer 独立外层 `Promise.race`（250ms）。
- fail-open：超时/provider 错误/熔断/解析失败一律 → `advisory=null`，主路径继续。
- L1 缓存：按 `conversation_id`、60s TTL、LRU 5000 条。

为 Helm 要改的点：

- probe 是**仅咨询**（不改路由）；Helm 的 eval 改为**可决策**，输出直接选 lane。
- 缓存键从 `conversation_id` 改为 **content-hash**（无状态网关更合适）。
- probe 调用**无 `max_tokens` 上限**（规模化成本风险）→ Helm 必须加上限。
- probe 的 `fallbacks` / `production_timeout_ms` 是"配了但没接线"→ Helm 要么实现要么删掉，不要让配置说谎。

## 协议互译实现参考（Protocol translation）

调研开源的 OpenAI / Anthropic / Responses / Gemini 协议互译实现（含流式 SSE），用于设计 Protocol Adapter。**我们不抄代码，自己重写——参考其实现思路与架构**（授权问题另行处理，不作为选型约束）。以"完整度 + 正确性 + 架构清晰度"为标尺做了覆盖矩阵对比。

### 👑 参考标杆：musistudio/llms

`https://github.com/musistudio/llms`（TypeScript，claude-code-router 的翻译引擎）。它是唯一**存在意义就是协议互译**的项目，契约最干净、双向、且已是我们的目标语言。

为什么它在"我们这个具体问题"上完整度最高：

- 每个协议 = 一个类，实现 **5 方法契约**：`transformRequestOut`（native 入站 → 统一 IR）、`transformRequestIn`（IR → native 出站）、`transformResponseIn`、`transformResponseOut`、`endPoint`（它负责的入站路由，如 `/v1/messages`、`/v1beta/models/:modelAndAction`）。入站与出站翻译在同一个文件里，一个协议一处描述完——这正是它"可重写"的原因。
- 统一中枢 = **OpenAI Chat Completions 形态**。litellm / Portkey / new-api / one-api / Bifrost 五个独立实现都收敛到同一个 IR，所以这是事实标准；选它意味着遇到边界 case 还能交叉参考其他五个实现。
- **流式状态机最值得啃**且很成熟：`anthropic.transformer.ts` 的 `convertOpenAIStreamToAnthropic` 用单调 `contentIndex` 分配器 + `toolCallIndexToContentBlockIndex` 映射（并行/流式工具调用的正确解法）+ 临时 id 后补升级 + `safeClose/safeEnqueue` 幂等关闭守卫。这恰好是 litellm 踩错的那类 bug（Gemini `input_json_delta` 丢失 #25561）的正面参照。

弱点：Responses API 比 litellm 浅、文档稀疏（要读源码）、单人维护（靠 claude-code-router 用户量实战）。

### 🥈 正确性规范：BerriAI/litellm

`https://github.com/BerriAI/litellm`（Python）。架构耦合进大框架不适合当模板，但**边界 case 的正确性最全**，当"checklist"用：

- 唯一有**真正完整的 Responses API 翻译深度**：Anthropic `/v1/messages` → `/responses` 的 item 展开、`tool_use`/`tool_result` 提升为顶层 item、`budget_tokens`→effort、reasoning item、compaction 形状映射（doc: `anthropic_unified/messages_to_responses_mapping`）。即便我们用 TS 实现，也要照它的 spec 级清单补齐。
- 正确性 helper：`truncate_tool_name`（OpenAI 64 字符上限 vs Anthropic 无限制，SHA-256 防碰撞截断 + 响应时还原）、`_add_additional_properties_false`（递归强制 OpenAI strict-mode JSON schema）、按模型族 gate `cache_control`。

第三参照：**QuantumNous/new-api**（Go），其 adaptor 显式暴露 `ConvertOpenAIRequest`/`ConvertClaudeRequest`/`ConvertGeminiRequest`，验证 any-to-any 入站矩阵。

### 要啃的源码（musistudio/llms，`src/transformer/`）

- `anthropic.transformer.ts` — 核心。`transformRequestOut`（system 数组→system 消息、`tool_result`→`role:"tool"`、`tool_use`→`tool_calls`、thinking+signature）、`convertOpenAIResponseToAnthropic`（finish-reason 映射、usage 拆分 `input = prompt − cached`）、`convertOpenAIStreamToAnthropic`（流式状态机）。
- `gemini.transformer.ts` + `utils/gemini.util.ts` — `alt=sse`、`x-goog-api-key`、无 tool-call ID、schema `format` 限制。
- `openai.transformer.ts` + `openai.responses.transformer.ts` — 中枢恒等变换 + Responses 面。
- `tooluse / reasoning / maxtoken / streamoptions ...transformer.ts` — **可叠加的横切行为 transformer** 管线模式。
- `index.ts`（transformer 注册表）、`server.ts`（`endPoint` 如何挂成入站路由）。

### 要 lift 的架构模式（思路，非代码）

1. **唯一 IR = OpenAI Chat 形态**（5 个独立实现共同验证）。
2. **每协议一个类、5 方法契约**，入站+出站同处一文件。
3. **翻译永远走 `nativeIn → IR → nativeOut`**，绝不做 N×N 直连对：N 个协议 = **2N 个变换函数,不是 N² 个适配器**——这是最重要的设计决策。
4. **流式 = 显式的每方向状态机**（不是透传）：维护 content-block index 分配器、tool-call-index→block-index 映射、临时 id→真 id 升级、幂等关闭守卫；确定性地发 `message_start → content_block_start/delta/stop → message_delta → message_stop`。
5. **横切关注点做成可叠加的行为 transformer**（max-token 钳制、tool-use 归一、reasoning 注入）叠在协议 transformer 之上。

补充要点（在上述 5 点之上）：

- 统一 IR 在 OpenAI Chat 形态基础上**扩展可选字段**：thinking/推理块、多部件 typed content（图像/文档）、tool-call ID、cache-control、`provider_raw` 透传袋（装上游原生 `stop_reason`/`usage`，供 agent 客户端还原）。
- 若一个协议既可作入站（client）又可作出站（provider），就是 2N 变换函数；若入站集合与出站集合分开，则是 N+M 适配器——本质都是"经中枢中转，绝不 N×N 直连"。
- 为"客户端要流式但上游是单 JSON（缓存命中 / 非流式 provider）"准备 **JSON→SSE 合成器**。

**必须处理的 5 个流式 / 边界坑**：

1. **finish_reason / stop_reason 枚举错配**：OpenAI SDK 对非法枚举会丢弃整个响应（含已生成内容）；全塌成 `stop` 又会让 agent 静默误判。→ 映射成合法枚举**并**把原始值存进 `provider_raw`。
2. **token usage 字段翻译与缓存重复计费**：Anthropic 的 `input_tokens/cache_read_input_tokens` vs OpenAI 的 `prompt_tokens/prompt_tokens_details.cached_tokens`；流式下曾把缓存读当全价输入导致 ~10× 成本错误。→ 显式翻译、`input = prompt − cached`、流式末事件 buffer usage。
3. **tool-call 流式的 index/ID 协调**：OpenAI 按整数 index 流、id/name 可能只在首片、参数分片到达；Anthropic 需先 `tool_use` 块带 id+name 再 `input_json_delta`。→ 维护 index→block 映射、合成临时 id/name 后覆盖、容忍残缺 JSON（jsonrepair）。
4. **流式 block/part ID 与 role 一致性**：每个块必须先 start 再 delta 后 stop，缺 start 的 delta 会被严格消费方静默丢弃；OpenAI 首片 delta 必须带 `role:"assistant"` 否则 LangChain 检测不到工具调用。→ 跟踪开块状态 + 关闭守卫防"controller already closed"。
5. **system 提示与多模态结构错配**：OpenAI 把 system 放 `messages[0]`，Anthropic 用顶层 `system` 且禁止连续同角色消息（需合并连续 user/tool_result）；图像 `image_url` vs `source:{base64}` 要拆字段；Gemini 无 tool-call ID 需合成、`format` 仅支持 date/date-time。

参考源：
- https://github.com/musistudio/llms — `src/transformer/anthropic.transformer.ts`
- https://github.com/Portkey-AI/gateway — `src/handlers/streamHandler.ts`、`src/handlers/responseHandlers.ts`
- https://github.com/BerriAI/litellm — usage/finish_reason 坑的 issue 来源
- https://github.com/maxnowack/anthropic-proxy

## Plano

GitHub: https://github.com/katanemo/plano

Plano 是一个面向智能体应用、AI 原生的代理与数据平面。它包含智能体编排、模型路由、过滤链、可观测性以及信号（signals）。

有价值的思路：

- 智能体 / 数据平面的框架视角。
- 把过滤链作为中间件。
- 语义别名与偏好感知的路由。
- 用 Agentic Signals 实现低成本的生产环境反馈。

值得借鉴：

- 为 Memory / Guardrails 设立的中间件边界。
- 把 Signals 作为未来的反馈层。
- 通道（lane）/ 别名抽象。

不要盲目照搬：

- 庞大的平台范围。
- 在 MVP 阶段就内置智能体编排。

## Portkey

Website: https://portkey.ai/

Portkey 是一个企业级 AI 网关 / LLMOps 平台。

有价值的思路：

- 统一的供应商网关。
- 重试、回退、负载均衡、条件路由。
- 可观测性、成本、护栏以及密钥管理。

值得借鉴：

- 请求追踪与成本看板。
- 虚拟密钥管理。
- 回退策略的相关概念。

不要盲目照搬：

- 在 MVP 阶段就铺开企业级控制平面。

## Tingly Box

GitHub: https://github.com/tingly-dev/tingly-box

Tingly Box 是一个本地 / 自托管的 Agent Gateway 与控制盒。它把模型代理、OAuth 供应商复用、Web UI、远程 IM 控制、智能体配置档（agent profiles）、护栏以及用量分析结合在一起。

有价值的思路：

- 复用 OAuth 订阅配额。
- 智能体配置档管理。
- 用户 token 与模型 token 的分离。
- 用于管理供应商、路由、别名和 token 的 Web UI。

值得借鉴：

- OAuth 供应商集成的模式。
- 本地控制平面的交互体验思路。
- token 分离。

不要盲目照搬：

- IM 远程控制以及完整的智能体控制盒范围。
- 在 MVP 阶段就引入庞大的安全面。

## Mastra Observational Memory

Issue: https://github.com/EasyMetaAu/llm-router/issues/362
Docs: https://mastra.ai/docs/memory/observational-memory
Research: https://mastra.ai/research/observational-memory

有价值的思路：

- 网关层的记忆。
- Observer 与 Reflector 后台智能体。
- 稳定、对缓存友好的记忆上下文。
- 用观测（observations）与反思（reflections）代替完整的原始历史。

值得借鉴：

- 把记忆作为可选的中间件。
- `thread/resource/project` 记忆作用域。
- 观测 + 反思的流水线。

不要盲目照搬：

- 在 MVP 的核心路径中引入记忆。
- 把动态 RAG 作为默认的记忆策略。
