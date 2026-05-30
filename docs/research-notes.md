# 调研笔记

## Manifest

GitHub: https://github.com/mnfst/manifest

Manifest 是一个面向智能体和 AI 应用的智能模型路由器。它会把每个请求路由到能够处理它的最便宜的模型上。

有价值的思路：

- 本地、确定性的复杂度打分。
- 23 个维度：关键词、结构以及上下文信号。
- 四个层级：简单、标准、复杂、推理。
- 针对具体任务的检测，涵盖编程、网页浏览、数据分析、图像生成、视频生成、社交媒体、邮件、日历以及交易。
- 针对简短后续消息的会话惯性（session momentum）。

值得借鉴：

- 廉价的本地分类器。
- 可解释的复杂度与任务信号。
- 针对简短后续消息的惯性机制。

不要盲目照搬：

- 模型市场（model-market）的定位。
- 把广泛的供应商接入作为产品的主要呈现面。

## Plano

GitHub: https://github.com/katanemo/plano

Plano 是一个面向智能体应用、AI 原生的代理与数据平面。它包含智能体编排、模型路由、过滤链、可观测性以及信号（signals）。

有价值的思路：

- 智能体 / 数据平面的框架视角。
- 把过滤链作为中间件。
- 语义别名与偏好感知的路由。
- 用 Agentic Signals 实现低成本的生产环境反馈。

值得借鉴：

- 为 Memory / Guardrails 设立的中间件边界。
- 把 Signals 作为未来的反馈层。
- 通道（lane）/ 别名抽象。

不要盲目照搬：

- 庞大的平台范围。
- 在 MVP 阶段就内置智能体编排。

## Portkey

Website: https://portkey.ai/

Portkey 是一个企业级 AI 网关 / LLMOps 平台。

有价值的思路：

- 统一的供应商网关。
- 重试、回退、负载均衡、条件路由。
- 可观测性、成本、护栏以及密钥管理。

值得借鉴：

- 请求追踪与成本看板。
- 虚拟密钥管理。
- 回退策略的相关概念。

不要盲目照搬：

- 在 MVP 阶段就铺开企业级控制平面。

## Tingly Box

GitHub: https://github.com/tingly-dev/tingly-box

Tingly Box 是一个本地 / 自托管的 Agent Gateway 与控制盒。它把模型代理、OAuth 供应商复用、Web UI、远程 IM 控制、智能体配置档（agent profiles）、护栏以及用量分析结合在一起。

有价值的思路：

- 复用 OAuth 订阅配额。
- 智能体配置档管理。
- 用户 token 与模型 token 的分离。
- 用于管理供应商、路由、别名和 token 的 Web UI。

值得借鉴：

- OAuth 供应商集成的模式。
- 本地控制平面的交互体验思路。
- token 分离。

不要盲目照搬：

- IM 远程控制以及完整的智能体控制盒范围。
- 在 MVP 阶段就引入庞大的安全面。

## Mastra Observational Memory

Issue: https://github.com/EasyMetaAu/llm-router/issues/362
Docs: https://mastra.ai/docs/memory/observational-memory
Research: https://mastra.ai/research/observational-memory

有价值的思路：

- 网关层的记忆。
- Observer 与 Reflector 后台智能体。
- 稳定、对缓存友好的记忆上下文。
- 用观测（observations）与反思（reflections）代替完整的原始历史。

值得借鉴：

- 把记忆作为可选的中间件。
- `thread/resource/project` 记忆作用域。
- 观测 + 反思的流水线。

不要盲目照搬：

- 在 MVP 的核心路径中引入记忆。
- 把动态 RAG 作为默认的记忆策略。
