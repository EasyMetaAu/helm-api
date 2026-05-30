# Helm API 记忆中间件规范

## 定位

记忆并不属于 MVP 路由核心。记忆是一个可选的中间件，它在分类和执行之前为请求提供足够的上下文。

```text
Memory helps the request be understood.
Router decides the lane.
Provider executes.
Logs explain what happened.
```

## 来源 issue

本规范基于 llm-router issue #362：Memory Gateway / Observational Memory（记忆网关 / 观察式记忆）。

Issue: https://github.com/EasyMetaAu/llm-router/issues/362

## 核心思路

采用受 Mastra Observational Memory 启发的网关级记忆层：

- 客户端传入稳定的 ID，例如 `x-thread-id`、`x-resource-id` 和 `x-project-id`。
- 网关存储原始消息和工具结果。
- 后台 Observer 将旧的原始历史压缩为带日期的观察记录。
- 后台 Reflector 将观察记录合并为稳定的反思。
- Provider 上下文由反思、观察记录、近期原始消息以及当前消息组装而成。

在 MVP 方向上这并不是动态 RAG。目标是构建一个稳定、对缓存友好的上下文前缀。

## 请求头

```http
x-thread-id: current conversation or task thread
x-resource-id: current document, asset, issue, or workspace object
x-project-id: project-level memory scope
x-memory-mode: off | observe | inject
```

默认值：

```text
x-memory-mode = off
```

模式：

- `off`：不进行记忆读写；保持当前路由行为。
- `observe`：记录消息和工具输出，但不注入记忆。
- `inject`：加载记忆上下文、组装 prompt，并将回写任务入队。

## 流水线

```text
Request comes in
  -> save raw message if observe/inject
  -> if inject:
       load reflection + active observations
       assemble stable context
  -> classifier uses current message + short memory context
  -> route + provider execute
  -> save response/tool result
  -> enqueue observer job
  -> observer compresses raw history into observations
  -> reflector periodically merges observations into reflection
```

## 上下文组装顺序

```text
system prompt
+ project reflection
+ resource reflection
+ thread observations
+ recent raw messages
+ current user message
```

规则：

- 反思应当稳定且缓慢变化。
- 必须保留近期原始消息，以避免压缩造成信息丢失。
- 观察记录文本应包含时间锚点。
- 记忆注入应保持在 token 预算范围内。
- 如果记忆加载失败，主请求应在无记忆的情况下继续执行，并记录该失败。

## 存储模型

最小表集合：

```text
memory_threads
  id, project_id, resource_id, owner_id, created_at, updated_at

memory_messages
  id, thread_id, role, content, token_estimate, created_at

memory_observations
  id, thread_id, source_message_range, observation_text,
  observed_at, referenced_at, priority, tags

memory_reflections
  id, project_id, resource_id, thread_id, reflection_text,
  version, token_estimate, updated_at

memory_jobs
  id, type, scope_id, status, error, created_at, updated_at
```

`source_message_range` 是必填字段，这样压缩后的记忆才能与原始消息进行审计核对。

## 路由集成

分类器可以使用：

- 当前消息。
- 近期的原始对话轮次。
- 简短的记忆摘要。
- 工具/请求元数据。

路由输出保持不变：

```text
task_type
complexity
constraints
lane
```

记忆不得直接改写 lane 规则。例如，用户权益路由应归属于 Policy Engine，而非记忆。

## 调试 UI 字段

新增请求级别的记忆元数据：

```text
memory_mode
thread_id
resource_id
project_id
memory_hydrated
reflection_version
observation_count
memory_tokens_injected
observer_job_id
memory_writeback_status
```

请求详情默认可以展示记忆元数据。完整的记忆内容应需要显式授权，并且应被审计。

## 成本核算

独立的 token/成本分桶：

- Actor 请求 token。
- Actor 响应 token。
- 记忆补水（hydrate）token。
- Observer token。
- Reflector token。

记忆维护必须在成本报告中可见，且不应隐藏在 Provider 执行成本之中。

## 阶段计划

### 阶段 1：记忆就绪（Memory-ready）

- 接受记忆请求头。
- 在 observe 模式下持久化原始消息。
- 在请求日志中展示记忆元数据。
- 暂不注入记忆。

### 阶段 2：观察式记忆 MVP（Observational Memory MVP）

- 实现 Observer：原始消息 -> 观察记录。
- 实现 Reflector：观察记录 -> 反思。
- 实现 inject 模式的上下文组装。
- 仅在显式设置 `x-memory-mode=inject` 时运行。

### 阶段 3：项目记忆（Project memory）

- 项目/资源/线程的作用域层级。
- 结构化事实与资产图谱。
- 创意/项目工作区支持。

## 非目标

- 不在路由核心中构建完整的 RAG 产品。
- 默认不进行逐轮的动态检索。
- 不进行跨项目的记忆共享。
- 首个版本中不引入全局用户画像。
- 不在主请求路径中引入同步的 Observer。
- 不在记忆中间件中进行 agent 编排。
