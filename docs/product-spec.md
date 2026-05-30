# Helm API 产品规格说明

## 一句话定义

Helm API 是 **LLM 的 nginx**：一个声明式的智能模型网关。你用简单的 YAML 配置完成模型的分配与调度，对客户端则始终是统一的标准与输出。它接收标准的 AI API 请求，识别任务类型与复杂度，将每个请求路由到合适的 lane，通过 provider 适配器执行，并记录完整的请求日志以便调试。

把流量当**配置**来管，而不是当**代码**来写。

## 问题

AI 应用开发者不想在每个客户端里管理上百个模型、各家 provider 的怪癖、fallback 行为、成本权衡以及长期的路由决策。他们想要的是一个 API：足够便宜、足够可靠、默认就够用，并且在出问题时可以调试。

之前的 llm-router 方向变得过于宽泛：provider 别名太多、太偏向于模型市场的思路，而且路由核心里塞了太多逻辑。Helm API 应该更聚焦、更收敛。

## nginx 定位

这个比喻不只是营销，它约束了产品边界：

- nginx 不托管内容 → Helm **不拥有模型**，不做模型市场。
- nginx 配置是声明式的 → 一切都在 `lanes.yaml` / `policies.yaml`，不写代码。
- nginx 有 upstream + 健康检查 + 故障转移 → lane 的 `primary + fallback[]` + 熔断器。
- nginx 是"无聊但可靠"的基础设施 → 这就是产品气质，不是平台。

## MVP 目标

1. 以最小的迁移成本支持标准客户端 API（只改 `base_url` 和 API key）。
2. 用确定性规则对每个请求做第一层分类；规则不确定时，可选地用小模型评估；都判不出来则落到 balanced。
3. 通过可配置的 lane 路由请求，而不是直接暴露原始的 provider 别名。
4. 通过主用和 fallback provider 执行每条 lane。
5. 记录每一次路由决策和每一次 provider 尝试，以便调试。
6. 开箱即用：默认三条 lane，默认**不开启** LLM 评估。
7. 启动时强制存在 API key；不允许匿名访问。
8. 将 Memory、Guardrails、Signals、agent 编排以及 IM 控制保持在 MVP 之外。

## 非目标

- 不构建模型市场。
- 不把上百个 provider 别名作为产品对外的呈现面。
- 不在路由核心中实现完整的 RAG 产品。
- 不在 MVP 中实现 Memory（它是 MVP 之后的中间件，见下文）。
- 不在 MVP 中构建完整的 agent 编排平台。
- 第一层路由不依赖黑盒 LLM 分类器（确定性规则优先）。
- 不把 provider 基准测试作为主要的运行时决策机制。

## 核心产品闭环

```text
Client request
  -> Protocol Adapter        # 协议归一化
  -> Auth / API Key          # 鉴权，启动时强制有 key
  -> Task Classifier         # 三层分类级联（见下）
  -> Policy / Lane Router     # 选择 lane
  -> Provider Adapter + Fallback   # 执行 + 链内回退
  -> Request Log / Debug UI   # 全量遥测
```

## 客户端 API 呈现面

Helm 应当支持标准的 AI API 形态：

- OpenAI Chat Completions
- Anthropic Messages
- OpenAI Responses
- Gemini API（后续支持）

客户端应当只需要修改 `base_url` 和 API key。客户端无需知道实际由哪个 provider 或模型来执行请求。各协议之间的互译参考成熟开源实现（见架构规范）。

## Provider 呈现面

Provider 适配器可以支持：

- OpenAI 兼容的 provider：OpenRouter、ZenMux、vLLM、DeepSeek、Qwen、本地模型、自定义 endpoint
- Anthropic 原生
- Gemini 原生
- 未来的 OAuth provider，例如 Claude Code、Codex、Copilot，或类似的基于订阅的 provider

Provider 别名属于内部的供应链细节。它们不是面向用户的主要产品呈现面。

## 路由概念

### 分类级联（Classification cascade）

这是 Helm 的核心。请求进入后，按三层顺序决定 lane，命中即停：

```text
请求进入
  → 第 1 层：确定性规则（rules）            [始终开启，零成本、零延迟]
        命中且 confidence ≥ 阈值 → 直接进对应 lane
  → 第 2 层：小模型评估（eval）              [默认关闭，带缓存]
        小模型判出 complexity / task_type → 进对应 lane
  → 第 3 层：兜底 → balanced lane           ← 永远安全的默认
```

**关键区分：两种 fallback 是两件事，必须分开记录。**

- **分类兜底（classification fallback）**：我不知道这是什么任务 → 落到 balanced lane。
- **执行兜底（provider fallback）**：选中的 provider 挂了 / 超时 / 限流 → 走 lane 链内的下一个 model。

第一个发生在"选 lane"阶段，第二个发生在"执行 lane"阶段。两套机制、两套日志字段，绝不能混淆。

### 任务分类

分类器输出：

```yaml
complexity: simple | standard | complex | reasoning
task_type: chat | coding | math | writing | extraction | tool_use | vision | web | data
confidence: number          # [0,1]，低于阈值则进入下一层
constraints:
  needs_tools: boolean
  needs_json: boolean
  needs_vision: boolean
  long_context: boolean
  low_latency: boolean
  low_cost: boolean
```

分类器的输入可以使用：

- 当前用户消息
- 最近的若干条消息
- 工具定义
- 响应格式
- 最大 token 目标
- 附件 / 多模态元数据

### 第 1 层：确定性规则（参考 Manifest）

第一层是本地、确定性、零成本的加权评分，借鉴开源 Manifest 模型路由器的设计：

- **加权维度评分**：一组关键词 / 结构 / 上下文维度，每个维度有权重和方向，累加成一个 `rawScore`。
- **四档复杂度**：用固定边界把分数映射到 `simple | standard | complex | reasoning`。
- **任务检测**：按关键词集合、工具名前缀、结构信号（URL、代码块、文件路径、堆栈）识别 `coding / web / data / vision` 等任务类型。
- **会话动量（momentum）**：短的后续消息按历史会话倾向加权，避免单条短消息把分类带偏。
- **硬覆盖与捷径**：心跳类（如 `HEARTBEAT_OK`）直接判 simple；形式逻辑关键词直接判 reasoning；带 tools 的请求下限为 standard；超长上下文（如 > 50k token）下限为 complex。
- **置信度闸门**：`confidence = sigmoid(到最近边界的距离)`；低于阈值（默认 `0.45`）视为"不确定"，进入第 2 层。

可移植性：维度名/权重/关键词列表/边界/阈值都是**数据**，应当放进 `classifier.yaml`，可调而不需改代码；少量结构信号正则和控制流是代码实现。

### 第 2 层：小模型评估（LLM eval）

当第 1 层不确定时，用一个便宜的小模型对内容做一次评估，结果决定 lane。**默认关闭**。

```yaml
classifier:
  rules:
    enabled: true
    confidence_threshold: 0.45     # 低于此值才进入 eval

  eval:
    enabled: false                 # 默认关闭
    model: deepseek/deepseek-v4-flash   # 便宜、快、JSON 可靠；可替换
    temperature: 0
    max_tokens: 256                # 只输出一个 JSON，封顶成本
    timeout_ms: 300                # 超时即放弃，不阻塞主路径
    on_failure: balanced           # 超时/解析失败 → 默认 lane
    cache:
      enabled: true
      key: content_hash            # 规范化(最后用户消息 + tools 签名)
      ttl_sec: 300                 # 不必每次都评估
```

设计要点（借鉴 llm-router 的 probe，但改为可决策）：

- 输出严格 JSON：`{ complexity, task_type, confidence }`，校验失败即 fail-open 到 `balanced`。
- `temperature: 0`、非流式，结果可缓存。
- 与 llm-router 的 probe 不同：probe 是"仅咨询、不改路由"；Helm 的 eval 是"可决策"——它的输出直接选 lane。
- 缓存按 **content-hash**（而非 conversation_id），因为网关是无状态的；同样/相似请求命中缓存，不重复评估。
- 评估调用本身也经过一个 provider，因此它在配置上是一个内部的小模型，不属于对外的三条 lane。

### Lane 路由

路由优先级顺序：

```text
explicit model/lane           # 客户端显式指定，跳过一切规则
  > server-side custom policy  # 服务端策略
  > task-specific lane         # 任务专属 lane
  > complexity fallback lane   # 复杂度兜底 lane
```

默认 lane 应当数量少且易于理解。

### 默认 lane

```yaml
economy:
  purpose: Cheap and fast for simple tasks
  primary: cheap_model
  fallback: [balanced_model]

balanced:
  purpose: Default quality/cost tradeoff
  primary: default_good_model
  fallback: [premium_model, economy_model]

premium:
  purpose: Strong reasoning and high quality
  primary: best_reasoning_model
  fallback: [balanced_model]
```

`balanced` 永远必须配置且健康——它是分类兜底的终点。

### 可选的任务 lane

```yaml
coding:
  primary: coding_model
  fallback: [premium, balanced]

vision:
  primary: vision_model
  fallback: [premium]

tool_use:
  primary: tool_capable_model
  fallback: [premium]

json:
  primary: strict_json_model
  fallback: [balanced]
```

如果没有配置任务专属的 lane，路由器会回退到三条默认 lane。

## 鉴权与 API Key

Helm 默认**不允许匿名访问**。

- `require_api_key: true`：所有请求都必须带 key。
- **启动引导（bootstrap）**：服务启动时若不存在任何 key，自动生成一把 root key，并**仅打印/持久化一次**，供运维取走。
- key 通过 Auth Resolver 解析为账户/组织/用户身份；遥测中绝不存明文 key。

```yaml
auth:
  require_api_key: true
  bootstrap:
    generate_if_missing: true        # 启动时无 key 则生成一把 root key
    persist_to: ./data/helm-keys.json   # 或环境变量 / 数据库
    print_once: true                 # 首次生成时打印到启动日志一次
```

## 策略配置

策略（Policy）让你在不修改客户端代码的情况下进行服务端定制。

示例：

```yaml
policies:
  - match:
      task_type: coding
      complexity: complex
    use_lane: coding

  - match:
      needs_json: true
    use_lane: json

  - match:
      user_id: vip_user
    use_lane: premium

  - match:
      org_id: low_cost_org
    max_lane: balanced
```

策略必须保持显式且可检视。它不应把难以调试的模型打分行为藏在某种魔法背后。

**客户端显式指定模型**优先级最高：当客户端直接指定一个具体模型时，跳过分类与策略，直接执行（等价于 nginx 的直通）。

## 执行模型

每条 lane 都有一条声明好的有序链路：

```yaml
lane:
  primary: model_a
  fallback:
    - model_b
    - model_c
  constraints:
    require_tools: true
    require_json: false
    max_latency_ms: 30000
```

执行规则：

1. 先尝试 primary。
2. 跳过不满足能力约束（capability constraints）的候选。
3. 当遇到 provider 错误、超时、限流，或熔断器处于打开状态时，尝试下一个 fallback。
4. 如果所有候选都失败，返回一个结构化错误。
5. 记录每一次尝试，包含原因和耗时。

## Memory（MVP 之后）

Memory 是一个**可选的中间件**，帮助请求在分类与执行之前获得足够上下文。它**不进入 MVP**：MVP 不实现 Memory 的读写与注入，也不把 Memory 放进路由策略。

内部请求结构与 Debug UI 会**预留** memory 相关字段（如 `memory_mode`、`thread_id`），但在 MVP 中保持惰性/关闭，为后续中间件留好接缝。详见 [记忆中间件规范](memory-middleware-spec.md)。

## Debug UI 需求

请求列表应当展示：

- 时间
- API key / 用户 / 组织
- 请求的模型
- 路由模式：shadow / real
- 分类得到的任务类型
- 复杂度
- **决策层级**：rules / eval / default（哪一层定的 lane）
- 选中的 lane
- 最终模型
- fallback 次数
- 状态
- 延迟
- 成本
- 错误原因

请求详情应当展示：

- 原始请求元数据，以及脱敏后的 payload 摘要
- 分类器输出（含置信度与命中的维度/信号）
- 是否触发 eval、eval 是否命中缓存
- 命中的策略
- lane 候选链路
- provider 尝试记录
- 最终响应元数据，或结构化错误
- 成本拆分（含 eval 评估自身的成本）
- Trace ID

## MVP 成功标准

- 新客户端可以把一个 OpenAI 兼容的 SDK 指向 Helm，无需自定义配置即可获得可用的路由。
- 默认的 economy / balanced / premium lane 开箱即用，且 LLM 评估默认关闭。
- 启动时若无 key，自动生成一把 root key；无 key 的请求被拒绝。
- 第 1 层规则能确定分类时直接进对应 lane；不确定且 eval 关闭时落到 balanced。
- 开启 eval 后，小模型的判定能选 lane，且相同请求命中缓存不重复评估。
- 一个 coding 请求在配置了 coding lane 时能路由到该 lane，否则回退到 premium 或 balanced。
- 一个带 JSON 约束的请求绝不会悄无声息地被路由到一个会忽略 JSON 约束的模型。
- 任何出乎意料的 provider 选择都能从请求日志中得到解释（包括是哪一层、哪条规则、哪个 provider 尝试导致的）。
