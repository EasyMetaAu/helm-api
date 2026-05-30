# Helm API 架构规范

## 架构概览

```text
Client
  -> API Gateway
  -> Auth Resolver               # 强制 API key（启动时引导生成）
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
- 保持流式语义（SSE 事件跨协议映射）。

设计（参考 musistudio/llms + Portkey，详见研究笔记）：

- **统一中枢用 OpenAI Chat 形态**，扩展 thinking/推理块、多部件 content、tool-call ID、`provider_raw` 透传袋（装上游原生 `stop_reason`/`usage`）。
- **每协议一对 transformer**：client 侧 `requestIn / responseOut`，provider 侧 `requestOut / responseIn`；规模是 **N+M 而非 N×M**。
- **流式统一走中枢**：provider `responseIn` 产出统一 chunk 迭代器，client `responseOut` 发各自 SSE；维护每流状态（block index、`openai_index→block_index` 映射、`started/finished/closed` 守卫）；为缓存命中/非流式上游提供 JSON→SSE 合成器。
- 已知必处理坑：finish_reason/stop_reason 枚举错配、usage 字段翻译与缓存计费、tool-call 流式 index/ID 协调、block/role 一致性、system 与多模态结构错配。

### Auth Resolver

鉴权解析器（Auth Resolver）。职责：

- 解析 API key 身份。
- 附加账户、组织、用户和权限元数据。
- 绝不在遥测中存储明文 API key。
- 记录 key 来源和 key ID，使每个请求都能追溯到对应的 key。
- **强制鉴权**：`require_api_key: true`，不允许匿名访问。

**启动引导（bootstrap）**：服务启动时若不存在任何 key，自动生成一把 root key，仅在首次打印到启动日志/持久化一次（`generate_if_missing` + `print_once`）。这保证 Helm 装好即有一把可用的 key，而不暴露给匿名流量。

### Task Classifier

任务分类器（Task Classifier）。它是一个**三层级联**，命中即停：

```text
第 1 层 rules（确定性规则，始终开启）
  命中且 confidence ≥ 阈值 → 输出 lane
第 2 层 eval（小模型评估，默认关闭，带缓存）
  小模型判出 complexity / task_type → 输出 lane
第 3 层 default → balanced lane（分类兜底终点）
```

职责：

- 计算 `task_type`、`complexity`、`confidence` 和 `constraints`。
- 第 1 层优先：确定性的本地加权评分，零成本、零额外延迟。
- 第 1 层不确定（confidence 低于阈值）时，可选地进入第 2 层小模型评估。
- 都判不出来则落到 balanced。
- 为调试 UI 返回可解释的信号（命中的维度、置信度、决策层级、是否命中 eval 缓存）。

**第 1 层：确定性规则引擎（参考开源 Manifest）**

- 加权维度评分：关键词 / 结构 / 上下文维度，各有权重与方向，累加成 `rawScore`。
- 四档复杂度边界：`simple | standard | complex | reasoning`。
- 任务检测：关键词集合 + 工具名前缀 + 结构信号（URL、代码块、文件路径、堆栈）。
- 会话动量：短的后续消息按历史倾向加权。
- 硬覆盖：心跳直判 simple；形式逻辑直判 reasoning；带 tools 下限 standard；超长上下文下限 complex。
- 置信度闸门：`sigmoid(到最近边界的距离)`，低于阈值进入第 2 层。
- 维度/权重/关键词/边界/阈值是**数据**，放进 `classifier.yaml`；结构信号正则与控制流是代码。

**第 2 层：小模型评估（eval，默认关闭）**

- 借鉴 llm-router 的 probe 管线（strict-JSON、`temperature:0`、非流式、双超时、fail-open），但改为**可决策**：输出 `{ complexity, task_type, confidence }` 直接选 lane。
- 缓存按 **content-hash**（规范化"最后用户消息 + tools 签名"）+ TTL，网关无状态友好。
- 加 `max_tokens` 上限封顶成本；超时/解析失败 → fail-open 到 `balanced`。
- 评估调用经过一个内部小模型 provider，不属于对外三条 lane。

请求字段信号：tools、response format、attachments、max tokens 等可被两层共用。

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
  # 以下 memory 字段在 MVP 中仅预留，不接入（见 memory-middleware-spec.md）
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
