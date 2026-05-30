# Helm API 架构规范

## 架构概览

```text
Client
  -> API Gateway
  -> Protocol Adapter
  -> Auth Resolver
  -> Optional Memory Middleware
  -> Task Classifier
  -> Policy Engine
  -> Lane Resolver
  -> Capability Filter
  -> Circuit Breaker
  -> Provider Executor
  -> Telemetry / Request Log
```

## 组件

### API Gateway

API 网关（API Gateway）。职责：

- 接收标准 API 请求。
- 规范化请求头和请求 ID。
- 施加请求大小和超时限制。
- 转发到正确的协议适配器。

### Protocol Adapter

协议适配器（Protocol Adapter）。职责：

- 将 OpenAI / Anthropic / Responses / 未来的 Gemini 请求归一化为统一的内部请求结构。
- 将提供方的响应转换回客户端所请求的协议。
- 保持流式语义。

### Auth Resolver

鉴权解析器（Auth Resolver）。职责：

- 解析 API key 身份。
- 附加账户、组织、用户和权限元数据。
- 绝不在遥测中存储明文 API key。
- 记录 key 来源和 key ID，使每个请求都能追溯到对应的 key。

### Task Classifier

任务分类器（Task Classifier）。职责：

- 计算 `task_type`、`complexity` 和 `constraints`。
- 优先使用确定性的本地启发式规则。
- 允许未来在功能开关后接入基于 LLM/嵌入的分类器。
- 为调试 UI 返回可解释的信号。

初始分类器的信号来源：

- 类清单式（manifest-style）的本地复杂度评分。
- 针对特定任务的关键词/工具检测。
- 请求字段，例如 tools、response format、attachments、max tokens。
- 启用 memory 时可选的 memory 摘要。

### Policy Engine

策略引擎（Policy Engine）。职责：

- 应用明确的服务端策略规则。
- 解析组织/用户/项目级别的覆盖项。
- 强制执行上限，例如 `max_lane` 或允许的 lane。
- 为遥测生成单条匹配的策略记录。

### Lane Resolver

Lane 解析器（Lane Resolver）。职责：

- 选择目标 lane。
- 当缺少特定任务的 lane 时使用默认 lane。
- 保持声明的 primary/fallback 顺序。
- 避免将 `*/auto` 提供方别名的评分排在明确指定的 primary 模型之上。

### Capability Filter

能力过滤器（Capability Filter）。职责：

- 检查 tools 支持情况。
- 检查 JSON / 结构化输出支持情况。
- 检查视觉/多模态支持情况。
- 检查上下文长度。
- 检查流式支持情况。
- 返回明确的跳过原因。

### Circuit Breaker

熔断器（Circuit Breaker）。职责：

- 跟踪每个提供方/模型的健康状况。
- 跳过处于 `OPEN` 状态的熔断电路。
- 在真实调用前使用 `HALF_OPEN` 探测锁。
- 在收到首个有效的提供方数据块之前记录失败。
- 仅在收到有效响应/数据块之后记录成功。
- 将客户端中止视为非提供方故障。

### Provider Executor

提供方执行器（Provider Executor）。职责：

- 按 lane 顺序执行各提供方。
- 将请求转换为提供方原生协议。
- 一致地处理流式和非流式路径。
- 返回结构化的尝试记录。

### Telemetry / Request Log

遥测 / 请求日志（Telemetry / Request Log）。职责：

- 持久化请求级别的路由决策。
- 持久化提供方尝试链。
- 持久化鉴权/key 身份元数据。
- 持久化成本和延迟信息。
- 脱敏密钥和私有载荷字段。

## 内部请求结构

```yaml
request_id: string
protocol: openai_chat | anthropic_messages | openai_responses | gemini
account_id: string
api_key_id: string
user_id: string | null
org_id: string | null
requested_model: string
messages: array
tools: array | null
response_format: object | null
attachments: array | null
max_tokens: number | null
stream: boolean
metadata:
  conversation_id: string | null
  thread_id: string | null
  resource_id: string | null
  project_id: string | null
  memory_mode: off | observe | inject
```

## 决策记录

```yaml
request_id: string
route_mode: shadow | real
requested_model: string
classifier:
  task_type: string
  complexity: string
  constraints: object
  explanation: array
policy:
  matched_policy_id: string | null
  reason: string
lane:
  selected_lane: string
  candidate_chain: array
provider_attempts:
  - alias: string
    skipped: boolean
    skip_reason: string | null
    status: ok | error
    error_class: string | null
    latency_ms: number
    cost_usd: number | null
final:
  model_alias: string | null
  provider_model: string | null
  status: ok | error
  error_reason: string | null
```

## 配置文件

预期的配置拆分：

```text
config/
  lanes.yaml           # 默认 lane 与任务 lane 的定义
  policies.yaml        # 服务端路由策略
  providers.yaml       # 提供方别名与凭证引用
  capabilities.yaml    # 模型/提供方能力元数据
  pricing.yaml         # 定价元数据与覆盖项
```

## 安全规则

- 生产环境路由仅使用激活的 lane 和激活的允许列表（allowlist）。
- 目录（catalog）元数据绝不直接进入运行时选择。
- 提供方 auto 别名是 fallback 末端，除非另有明确配置。
- 生成的目录属于供应链输入，而非策略。
- 调试 UI 必须解释某个提供方为何被选中或被跳过。
- 密钥绝不能以明文记录。
