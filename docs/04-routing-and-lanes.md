# 04 · 路由与 Lane

分类（见 [03](03-classification.md)）产出 `task_type`/`complexity`/`constraints` 后，路由层据此选出一条 lane，再按 lane 的有序链路执行。

## Lane 路由优先级

路由优先级顺序：

```text
explicit model/lane           # 客户端显式指定，跳过一切规则
  > server-side custom policy  # 服务端策略
  > task-specific lane         # 任务专属 lane
  > complexity fallback lane   # 复杂度兜底 lane
```

默认 lane 应当数量少且易于理解。

## 默认 lane

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

## 可选的任务 lane

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

**客户端显式指定模型**优先级最高：当客户端直接指定一个具体模型时，跳过分类与策略，直接执行（等价于 nginx 的直通）。是否允许由 key 的 `allow_custom_model` 控制，见 [06](06-auth-and-rate-limits.md)。

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
4. 如果所有候选都失败，返回一个结构化错误（见 [07 · 可观测性](07-observability.md)）。
5. 记录每一次尝试，包含原因和耗时。
