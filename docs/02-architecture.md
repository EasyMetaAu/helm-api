# 02 · 架构

## 架构概览

```text
Client
  -> API Gateway
  -> Auth Resolver               # 强制 API key（启动时引导生成）
  -> Rate Limiter                # 可选，默认关闭
  -> Protocol Adapter
  -> Task Classifier             # 三层级联：rules -> eval -> balanced
  -> Policy Engine
  -> Lane Resolver
  -> Capability Filter
  -> Circuit Breaker
  -> Provider Executor
  -> Telemetry / Request Log
  -> (Memory Middleware)         # MVP 之后；MVP 不接入
```

定位：Helm 是 **LLM 的 nginx**——声明式配置驱动的模型网关。客户端只见统一标准与输出，模型分配/调度全部由 YAML 配置和上述流水线完成。

## 组件

各组件此处只列**职责概要**；深入设计见对应专章。

### API Gateway

API 网关。职责：

- 接收标准 API 请求。
- 规范化请求头和请求 ID。
- 施加请求大小和超时限制。
- 转发到正确的协议适配器。

### Protocol Adapter

协议适配器。职责：归一化各客户端协议为内部请求结构，并把响应转换回客户端协议，保持流式语义。详见 [05 · 协议互译](05-protocol-translation.md)。

### Auth Resolver

鉴权解析器。职责：解析 API key 身份，附加账户/组织/用户/权限元数据，强制鉴权，遥测中绝不存明文 key。详见 [06 · 鉴权与限流](06-auth-and-rate-limits.md)。

### Rate Limiter

限流器（可选，默认关闭）。位于 Auth 之后、分类之前；触发即返回 `rate_limited`。详见 [06](06-auth-and-rate-limits.md)。

### Task Classifier

任务分类器。三层级联（rules → eval → balanced），计算 `task_type`/`complexity`/`confidence`/`constraints`。详见 [03 · 分类级联](03-classification.md)。

### Policy Engine

策略引擎。职责：

- 应用明确的服务端策略规则。
- 解析组织/用户/项目级别的覆盖项。
- 强制执行上限，例如 `max_lane` 或允许的 lane。
- 为遥测生成单条匹配的策略记录。

### Lane Resolver

Lane 解析器。职责：

- 选择目标 lane。
- 当缺少特定任务的 lane 时使用默认 lane。
- 保持声明的 primary/fallback 顺序。
- 避免将 `*/auto` 提供方别名的评分排在明确指定的 primary 模型之上。

### Capability Filter

能力过滤器。职责：

- 检查 tools 支持情况。
- 检查 JSON / 结构化输出支持情况。
- 检查视觉/多模态支持情况。
- 检查上下文长度。
- 检查流式支持情况。
- 返回明确的跳过原因。

### Circuit Breaker

熔断器。职责：

- 跟踪每个提供方/模型的健康状况。
- 跳过处于 `OPEN` 状态的熔断电路。
- 在真实调用前使用 `HALF_OPEN` 探测锁。
- 在收到首个有效的提供方数据块之前记录失败。
- 仅在收到有效响应/数据块之后记录成功。
- 将客户端中止视为非提供方故障。

### Provider Executor

提供方执行器。职责：

- 按 lane 顺序执行各提供方。
- 将请求转换为提供方原生协议。
- 一致地处理流式和非流式路径。
- 返回结构化的尝试记录。

### Telemetry / Request Log

遥测 / 请求日志。职责：持久化路由决策、提供方尝试链、鉴权/key 身份、成本与延迟；脱敏密钥与私有载荷。错误模型与 Debug UI 见 [07 · 可观测性](07-observability.md)。

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
  # 以下 memory 字段在 MVP 中仅预留，不接入（见 08-memory-middleware.md）
  thread_id: string | null
  resource_id: string | null
  project_id: string | null
  memory_mode: off | observe | inject
```

## 决策记录

```yaml
request_id: string
requested_model: string
classifier:
  task_type: string
  complexity: string
  confidence: number
  decided_by: rules | eval | default   # 哪一层定的 lane
  eval_cache_hit: boolean | null       # 触发 eval 时是否命中缓存
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
  classifier.yaml      # 分类器：rules 维度/权重/阈值 + eval 小模型与缓存
  providers.yaml       # 提供方别名与凭证引用
  capabilities.yaml    # 模型/提供方能力元数据
  pricing.yaml         # 定价元数据与覆盖项
  auth.yaml            # require_api_key + 启动引导 key（或经环境变量/DB）
```

## 安全规则

- 生产环境路由仅使用激活的 lane 和激活的允许列表（allowlist）。
- 目录（catalog）元数据绝不直接进入运行时选择。
- 提供方 auto 别名是 fallback 末端，除非另有明确配置。
- 生成的目录属于供应链输入，而非策略。
- 调试 UI 必须解释某个提供方为何被选中或被跳过。
- 密钥绝不能以明文记录。
