# Helm API 文档

本目录存放 Helm API 的产品与技术规范。本仓库采用 **spec-first（规范先行）** 模式：这些文档定义了 MVP 的范围与架构，待范围锁定后再开始实现。

## 阅读顺序

从最上方开始，依次向下阅读。每篇文档都假定你已经读过它上面的文档。

| # | Document | 它回答了什么 |
|---|---|---|
| 1 | [Product Specification](product-spec.md) | Helm 是什么、服务于谁、哪些内容在 MVP 之内、哪些在之外。 |
| 2 | [Architecture Specification](architecture-spec.md) | 请求如何在各组件之间流转、内部的请求形态，以及配置布局。 |
| 3 | [Memory Middleware Specification](memory-middleware-spec.md) | 紧贴路由、但不在路由内部的可选记忆层。 |
| 4 | [Research Notes](research-notes.md) | 现有方案（Manifest、Plano、Portkey、Tingly Box、Mastra）以及哪些值得借鉴、哪些应当规避。 |

## 一段话讲清 Helm 是什么

Helm API 是 **LLM 的 nginx**：一个声明式的智能模型网关。它接收标准的 AI API 请求（OpenAI Chat、Anthropic Messages、OpenAI Responses，后续支持 Gemini），用确定性规则（必要时辅以默认关闭的小模型评估）按任务类型和复杂度分类，将其路由到一个可配置的 **lane** 而非裸的 provider 别名，通过主用和 fallback provider 执行，并记录每一次路由决策以便调试。客户端只需更改 `base_url` 和 API key。

## 核心产品闭环

```text
Client request
  -> Protocol Adapter
  -> Auth / API Key
  -> Task Classifier
  -> Policy / Lane Router
  -> Provider Adapter + Fallback
  -> Request Log / Debug UI
```

## 设计原则

这些原则让 Helm 比它的前身（`llm-router`）更聚焦——后者扩张得过于宽泛：

- **售卖 lane，而非一个模型集市。** 用户选择 `economy / balanced / premium`。provider 别名是内部的供应链细节。
- **路由内核保持精简且可解释。** 策略是显式且可检视的；运行时的决策路径中没有黑盒式的模型打分。
- **记忆是中间件，而非策略。** 它帮助请求被理解；它绝不重写 lane 规则。
- **确定性分类优先。** 由本地启发式规则决定第一层路由；LLM／嵌入分类器则置于 feature flag 之后。
- **每一个出人意料的 provider 选择都必须可解释**，依据来自请求日志。

## MVP 范围之外

模型集市、数百个公开的 provider 别名、完整的 RAG 产品、置于路由策略内部的记忆，以及 agent 编排。完整清单见 [产品规格 → 非目标](product-spec.md#非目标)。

## 配置布局

运行时行为由配置驱动，而非靠改代码：

```text
config/
  lanes.yaml         # default and task lane definitions
  policies.yaml      # server-side routing policies
  providers.yaml     # provider aliases and credential references
  capabilities.yaml  # model/provider capability metadata
  pricing.yaml       # pricing metadata and overrides
```

关于每个文件如何馈入流水线，见 [Architecture Specification](architecture-spec.md)。

## 状态

| Stage | 状态 |
|---|---|
| Specifications | 已起草（即这些文档） |
| MVP scope lock | 待定 |
| Implementation | 尚未开始 |
