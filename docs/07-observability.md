# 07 · 错误模型与可观测性

决策记录（每个请求的完整路由轨迹）的结构见 [02 · 架构](02-architecture.md)。本章覆盖错误模型与 Debug UI。

## 错误模型

所有错误都是**结构化的**，并以**客户端所用协议的错误形态**返回（OpenAI 客户端拿到 OpenAI 错误形状，Anthropic 客户端拿到 Anthropic 错误形状），让现有 SDK 能直接解析。

统一内部错误结构：

```yaml
error:
  error_class: auth_error | invalid_request | lane_unavailable
              | all_providers_failed | capability_unsatisfiable
              | upstream_error | timeout | rate_limited
  http_status: number          # 见下表
  message: string              # 脱敏后的人类可读信息
  trace_id: string             # 关联决策记录，可在 Debug UI 还原
  provider_raw: object | null  # 上游原始错误（脱敏），便于排障
```

错误分类（`error_class`）及建议 HTTP 状态：

| error_class | HTTP | 含义 |
|---|---|---|
| `auth_error` | 401 | 缺/错 key |
| `invalid_request` | 400 | 请求不合法 / 协议字段错误 |
| `lane_unavailable` | 503 | 选中的 lane 无可用候选 |
| `all_providers_failed` | 502 | 候选链全部失败 |
| `capability_unsatisfiable` | 422 | 无候选满足能力约束（如强制 JSON / vision） |
| `upstream_error` | 502 | 上游 provider 返回错误 |
| `timeout` | 504 | 超时 |
| `rate_limited` | 429 | 触发限流 |

Protocol Adapter 的 `responseOut` 负责把统一错误翻成各协议的错误形状（见 [05](05-protocol-translation.md)）。

## Debug UI 需求

请求列表应当展示：

- 时间
- API key / 用户 / 组织
- 请求的模型
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
