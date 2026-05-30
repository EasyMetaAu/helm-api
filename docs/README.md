# Helm API 文档

本目录存放 Helm API 的产品与技术规范。本仓库采用 **spec-first（规范先行）** 模式：这些文档定义了 MVP 的范围与架构，待范围锁定后再开始实现。文档按编号排序，建议按顺序阅读。

## 一段话讲清 Helm 是什么

Helm API 是 **LLM 的 nginx**：一个声明式的智能模型网关。它接收标准的 AI API 请求（OpenAI Chat、Anthropic Messages、OpenAI Responses，后续支持 Gemini），用确定性规则（必要时辅以默认关闭的小模型评估）按任务类型和复杂度分类，将其路由到一个可配置的 **lane** 而非裸的 provider 别名，通过主用和 fallback provider 执行，并记录每一次路由决策以便调试。客户端只需更改 `base_url` 和 API key。

## 阅读顺序

| # | 文档 | 内容 |
|---|---|---|
| 01 | [总览与定位](01-overview.md) | Helm 是什么、nginx 定位、MVP 目标与非目标、核心闭环。 |
| 02 | [架构](02-architecture.md) | 流水线、组件职责、内部请求结构、决策记录、配置布局、安全规则。 |
| 03 | [分类级联](03-classification.md) | 三层级联（rules → eval → balanced）、任务分类、Manifest 规则引擎、小模型评估。 |
| 04 | [路由与 Lane](04-routing-and-lanes.md) | 路由优先级、默认/任务 lane、策略、执行与回退。 |
| 05 | [协议互译](05-protocol-translation.md) | Protocol Adapter 设计、统一 IR、流式状态机、必处理的坑。 |
| 06 | [鉴权、API Key 与限流](06-auth-and-rate-limits.md) | 强制鉴权、启动引导 key、Key 管理、per-key 限流。 |
| 07 | [错误模型与可观测性](07-observability.md) | 结构化错误、错误分类表、Debug UI。 |
| 08 | [记忆中间件](08-memory-middleware.md) | MVP 之后的可选记忆层（不在 MVP 内）。 |
| 09 | [MVP 路线图与成功标准](09-roadmap.md) | 分阶段路线图与验收标准。 |
| — | [调研笔记](research-notes.md) | 附录：Manifest、协议互译、probe 等开源参考与对比。 |

## 设计原则

让 Helm 比前身 `llm-router` 更聚焦：

- **售卖 lane，而非模型市场。** 用户选 `economy / balanced / premium`；provider 别名是内部供应链细节。
- **路由内核精简且可解释。** 策略显式可检视，运行时无黑盒打分。
- **确定性分类优先。** 本地规则定第一层，小模型评估默认关闭、置于其后。
- **记忆是中间件，不进 MVP。** 它帮请求被理解，绝不重写 lane 规则。
- **任何出人意料的 provider 选择都能从日志解释。**

## 状态

| 阶段 | 状态 |
|---|---|
| 规格 | 已起草（即这些文档） |
| MVP 范围锁定 | 待定 |
| 实现 | 尚未开始 |
