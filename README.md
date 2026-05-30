# Helm API

Helm API 是 **LLM 的 nginx**：一个声明式的智能模型网关——用简单 YAML 完成模型分配与调度，对客户端始终是统一的标准与输出。它接收标准的 AI API 请求，按确定性规则（必要时辅以小模型评估）对任务类型与复杂度进行分类，将每个请求路由到可配置的 lane，通过带回退机制的 provider 适配器执行，并记录完整的请求与调试遥测数据。

本仓库目前存放产品与技术规格文档。待 MVP 范围确定后，将着手实现。

## Specs

文档按编号排序，建议按顺序阅读；完整索引见 [docs/README.md](docs/README.md)。

- [01 · 总览与定位](docs/01-overview.md)
- [02 · 架构](docs/02-architecture.md)
- [03 · 分类级联](docs/03-classification.md)
- [04 · 路由与 Lane](docs/04-routing-and-lanes.md)
- [05 · 协议互译](docs/05-protocol-translation.md)
- [06 · 鉴权、API Key 与限流](docs/06-auth-and-rate-limits.md)
- [07 · 错误模型与可观测性](docs/07-observability.md)
- [08 · 记忆中间件（MVP 之后）](docs/08-memory-middleware.md)
- [09 · MVP 路线图与成功标准](docs/09-roadmap.md)
- [调研笔记（附录）](docs/research-notes.md)
