# Helm API 产品规格说明

## 一句话定义

Helm API 是一个可配置的智能模型网关：它接收标准的 AI API 请求，识别任务类型与复杂度，将每个请求路由到合适的 lane，通过 provider 适配器执行，并记录完整的请求日志以便调试。

## 问题

AI 应用开发者不想在每个客户端里管理上百个模型、各家 provider 的怪癖、fallback 行为、成本权衡以及长期的路由决策。他们想要的是一个 API：足够便宜、足够可靠、默认就够用，并且在出问题时可以调试。

之前的 llm-router 方向变得过于宽泛：provider 别名太多、太偏向于模型市场的思路，而且路由核心里塞了太多逻辑。Helm API 应该更聚焦、更收敛。

## MVP 目标

1. 以最小的迁移成本支持标准客户端 API。
2. 按任务类型、复杂度和约束对每个请求进行分类。
3. 通过可配置的 lane 路由请求，而不是直接暴露原始的 provider 别名。
4. 通过主用和 fallback provider 执行每条 lane。
5. 记录每一次路由决策和每一次 provider 尝试，以便调试。
6. 将 Memory、Guardrails、Signals、agent 编排以及 IM 控制保持在 MVP 核心之外。

## 非目标

- 不构建模型市场。
- 不把上百个 provider 别名作为产品对外的呈现面。
- 不在路由核心中实现完整的 RAG 产品。
- 不把 Memory 直接放进路由策略里。
- 不在 MVP 中构建完整的 agent 编排平台。
- 第一层路由不依赖黑盒 LLM 分类器。
- 不把 provider 基准测试作为主要的运行时决策机制。

## 核心产品闭环

```text
Client request
  -> Protocol Adapter
  -> Auth / API Key
  -> Task Classifier
  -> Policy / Lane Router
  -> Provider Adapter + Fallback
  -> Request Log / Debug UI
```

## 客户端 API 呈现面

Helm 应当支持标准的 AI API 形态：

- OpenAI Chat Completions
- Anthropic Messages
- OpenAI Responses
- Gemini API（后续支持）

客户端应当只需要修改 `base_url` 和 API key。客户端无需知道实际由哪个 provider 或模型来执行请求。

## Provider 呈现面

Provider 适配器可以支持：

- OpenAI 兼容的 provider：OpenRouter、ZenMux、vLLM、DeepSeek、Qwen、本地模型、自定义 endpoint
- Anthropic 原生
- Gemini 原生
- 未来的 OAuth provider，例如 Claude Code、Codex、Copilot，或类似的基于订阅的 provider

Provider 别名属于内部的供应链细节。它们不是面向用户的主要产品呈现面。

## 路由概念

### 任务分类

分类器输出：

```yaml
complexity: simple | standard | complex | reasoning
task_type: chat | coding | math | writing | extraction | tool_use | vision | web | data
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
- 当 Memory Middleware 启用时，可选的 memory 摘要

### Lane 路由

路由优先级顺序：

```text
explicit model/lane
  > server-side custom policy
  > task-specific lane
  > complexity fallback lane
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

## Debug UI 需求

请求列表应当展示：

- 时间
- API key / 用户 / 组织
- 请求的模型
- 路由模式：shadow / real
- 分类得到的任务类型
- 复杂度
- 选中的 lane
- 最终模型
- fallback 次数
- 状态
- 延迟
- 成本
- 错误原因

请求详情应当展示：

- 原始请求元数据，以及脱敏后的 payload 摘要
- 分类器输出
- 命中的策略
- lane 候选链路
- provider 尝试记录
- 最终响应元数据，或结构化错误
- 成本拆分
- Trace ID
- 当 memory 启用时的 memory 元数据

## MVP 成功标准

- 新客户端可以把一个 OpenAI 兼容的 SDK 指向 Helm，无需自定义配置即可获得可用的路由。
- 默认的 economy / balanced / premium lane 开箱即用。
- 一个 coding 请求在配置了 coding lane 时能路由到该 lane，否则回退到 premium 或 balanced。
- 一个带 JSON 约束的请求绝不会悄无声息地被路由到一个会忽略 JSON 约束的模型。
- 任何出乎意料的 provider 选择都能从请求日志中得到解释。
