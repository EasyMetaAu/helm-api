# Helm API

Helm API 是 **LLM 的 nginx**：一个声明式的智能模型网关——用简单 YAML 完成模型分配与调度，对客户端始终是统一的标准与输出。它接收标准的 AI API 请求，按确定性规则（必要时辅以小模型评估）对任务类型与复杂度进行分类，将每个请求路由到可配置的 lane，通过带回退机制的 provider 适配器执行，并记录完整的请求与调试遥测数据。

本仓库目前存放产品与技术规格文档。待 MVP 范围确定后，将着手实现。

## Specs

- [产品规格](docs/product-spec.md)
- [架构规格](docs/architecture-spec.md)
- [记忆中间件规格](docs/memory-middleware-spec.md)
- [研究笔记](docs/research-notes.md)
