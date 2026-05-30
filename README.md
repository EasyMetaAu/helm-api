# Helm API

Helm API 是一个规划中的智能 LLM 路由网关。它接收标准的 AI API 请求，对任务类型与复杂度进行分类，将每个请求路由到可配置的 lane，通过带回退机制的 provider 适配器执行，并记录完整的请求与调试遥测数据。

本仓库目前存放产品与技术规格文档。待 MVP 范围确定后，将着手实现。

## Specs

- [产品规格](docs/product-spec.md)
- [架构规格](docs/architecture-spec.md)
- [记忆中间件规格](docs/memory-middleware-spec.md)
- [研究笔记](docs/research-notes.md)
