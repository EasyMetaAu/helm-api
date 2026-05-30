# 01 · 总览与定位

## 一句话定义

Helm API 是一个**开源、自托管**的 LLM 路由网关（MIT 协议，Docker 部署）。你可以把它理解成"**LLM 世界的 nginx**"：用简单的 YAML 配置完成模型的分配与调度，对客户端则始终是统一的标准与输出。

它接收标准的 AI API 请求，识别任务类型与复杂度，将每个请求路由到合适的 lane，通过 provider 适配器执行，并记录完整的请求日志以便调试。启动后还自带一个管理界面，做基本规则管理。

把流量当**配置**来管，而不是当**代码**来写。

## 问题

AI 应用开发者不想在每个客户端里管理上百个模型、各家 provider 的怪癖、fallback 行为、成本权衡以及长期的路由决策。他们想要的是一个 API：足够便宜、足够可靠、默认就够用，并且在出问题时可以调试。

之前的 llm-router 方向变得过于宽泛：provider 别名太多、太偏向于模型市场的思路，而且路由核心里塞了太多逻辑。Helm API 应该更聚焦、更收敛。

## 类比：LLM 世界的 nginx

这个类比帮助理解 Helm 是什么、不是什么——它约束了产品边界：

- nginx 不托管内容 → Helm **不拥有模型**，对外暴露的是 lane 抽象，不是模型市场。
- nginx 配置是声明式的 → 一切都在 `lanes.yaml` / `policies.yaml`，不写代码。
- nginx 有 upstream + 健康检查 + 故障转移 → lane 的 `primary + fallback[]` + 熔断器。
- nginx 是你自己部署的"无聊但可靠"的基础设施 → Helm 同样**开源自托管**，不是 SaaS、不是平台。

如果你不熟悉 nginx 也没关系：把 Helm 当成"一个你自己跑的、用配置管理模型流量的 API 网关"即可。

## 客户端 API 呈现面

Helm 应当支持标准的 AI API 形态：

- OpenAI Chat Completions
- Anthropic Messages
- OpenAI Responses
- Gemini API（后续支持）

客户端应当只需要修改 `base_url` 和 API key。客户端无需知道实际由哪个 provider 或模型来执行请求。各协议之间的互译见 [05 · 协议互译](05-protocol-translation.md)。

## Provider 呈现面

Provider 适配器可以支持：

- OpenAI 兼容的 provider：OpenRouter、ZenMux、vLLM、DeepSeek、Qwen、本地模型、自定义 endpoint
- Anthropic 原生
- Gemini 原生
- 未来的 OAuth provider，例如 Claude Code、Codex、Copilot，或类似的基于订阅的 provider

Provider 别名属于内部的供应链细节。它们不是面向用户的主要产品呈现面。

## MVP 目标

1. 以最小的迁移成本支持标准客户端 API（只改 `base_url` 和 API key）。
2. 用确定性规则对每个请求做第一层分类；规则不确定时，可选地用小模型评估；都判不出来则落到 balanced。
3. 通过可配置的 lane 路由请求，而不是直接暴露原始的 provider 别名。
4. 通过主用和 fallback provider 执行每条 lane。
5. 记录每一次路由决策和每一次 provider 尝试，以便调试。
6. 开箱即用：默认三条 lane，默认**不开启** LLM 评估。
7. 启动时强制存在 API key；不允许匿名访问。
8. 开源、自托管：Docker 一键部署，配置即代码，不强依赖外部服务（见 [10 · 部署](10-deployment.md)）。
9. 启动后自带管理界面，做基本规则管理，认证用 HTTP Basic 账号密码（见 [11 · 管理界面](11-admin-ui.md)）。
10. 将 Memory、Guardrails、Signals、agent 编排以及 IM 控制保持在 MVP 之外。

## 非目标

- 不构建模型市场。
- 不把上百个 provider 别名作为产品对外的呈现面。
- 不在路由核心中实现完整的 RAG 产品。
- 不在 MVP 中实现 Memory（它是 MVP 之后的中间件，见 [08 · 记忆中间件](08-memory-middleware.md)）。
- 不在 MVP 中构建完整的 agent 编排平台。
- 第一层路由不依赖黑盒 LLM 分类器（确定性规则优先）。
- 不把 provider 基准测试作为主要的运行时决策机制。
- 不做 SaaS、不售卖、不做托管多租户平台（开源自托管，MIT 协议）。

## 核心产品闭环

```text
Client request
  -> Protocol Adapter        # 协议归一化
  -> Auth / API Key          # 鉴权，启动时强制有 key
  -> Task Classifier         # 三层分类级联
  -> Policy / Lane Router     # 选择 lane
  -> Provider Adapter + Fallback   # 执行 + 链内回退
  -> Request Log / Debug UI   # 全量遥测
```

各组件的职责与数据结构见 [02 · 架构](02-architecture.md)；分类见 [03](03-classification.md)，路由与 lane 见 [04](04-routing-and-lanes.md)。
