# Helm API

> 开源、自托管的 LLM 路由网关 · Docker 部署 · MIT License

Helm API 是一个**开源、自托管**的 LLM 路由网关——你可以把它理解成"LLM 世界的 nginx"：用**配置**（而非代码）来分配和调度模型流量。它接收标准的 AI API 请求，按确定性规则（必要时辅以默认关闭的小模型评估）对任务类型与复杂度分类，将每个请求路由到可配置的 lane，通过带回退机制的 provider 适配器执行，并记录完整的请求与调试遥测。

- **开箱即用**：默认三条 lane（economy / balanced / premium），LLM 评估默认关闭。
- **自托管**：Docker 一键部署，配置即代码；不依赖外部服务即可跑起来。
- **统一接口**：客户端只改 `base_url` + API key；OpenAI / Anthropic 等协议互译。
- **自带管理界面**：启动后即有 Web 控制台，做基本规则管理 + 请求调试（HTTP Basic 账号密码）。
- **MIT 协议**：自由部署、修改、商用；不做 SaaS、不售卖。

本仓库目前存放产品与技术规格文档（spec-first），待 MVP 范围锁定后实现。

## 部署

Docker 一键部署，配置与持久化通过挂载卷管理，账号密码经环境变量注入。详见 [10 · 部署](docs/10-deployment.md)。

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
- [10 · 部署（自托管 / Docker）](docs/10-deployment.md)
- [11 · 管理界面（Admin UI）](docs/11-admin-ui.md)
- [调研笔记（附录）](docs/research-notes.md)

## License

[MIT](LICENSE) © 2026 EasyMeta AU / 路田（上海）网络科技有限公司
