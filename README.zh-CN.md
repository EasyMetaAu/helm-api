<div align="center">

# Helm API

[English](README.md) · **简体中文**

> 开源、自托管的 LLM 路由网关 —— *LLM 世界的 nginx*。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![Built with Hono](https://img.shields.io/badge/gateway-Hono-ff5e00.svg)](https://hono.dev)
[![Admin: SvelteKit](https://img.shields.io/badge/admin-SvelteKit-ff3e00.svg)](https://kit.svelte.dev)

</div>

Helm API 站在你的 LLM 供应商前面，用**配置而非代码**决定每个请求该去哪里。它接收标准的 AI API 请求（OpenAI Chat Completions、Anthropic Messages、OpenAI Responses），用确定性规则（可选地辅以**默认关闭**的小模型评估）按任务类型与复杂度分类，将其路由到一个可配置的 **lane**，通过带**自动回退**与**熔断器**的 provider 适配器执行，并为每一次决策记录完整、可调试的遥测。

你的客户端只需更改 `base_url` 和 API key。其余的一切——模型选择、成本/质量权衡、provider 故障转移、协议互译——都发生在 Helm 内部。

---

## 为什么是 Helm？

- **暴露 lane，而非模型市场。** 客户端只选意图（`economy` / `balanced` / `premium`）；provider 别名是内部供应链细节。
- **配置即代码。** 行为由 `config/*.yaml` + 环境变量驱动，并用 Zod 校验。非法配置**拒绝启动（fail-closed）**——绝不带病运行。
- **fail-open 路由。** 分类、eval、缓存等任一辅助环节失败，请求都会降级到 `balanced` lane 并记录日志——绝不为辅助失败返回 5xx。只有"所有 provider 都失败"才产生结构化错误。
- **确定性优先。** 第 1 层路由是纯函数、零网络、可单测；可选的第 2 层 eval 以 `temperature: 0` 运行、带缓存，且默认关闭。
- **密钥安全、正文可观测。** API key 只存 SHA-256 哈希——日志、遥测、payload 表里绝不出现明文。完整的请求/响应正文记录到独立的表（可开关、可设保留期），便于调试与审计。
- **核心可无界面运行。** 路由/分类/执行/翻译/存储核心与框架无关，脱离管理界面也能跑。
- **MIT 协议、自托管。** Docker 部署，完全在内部运行。不做 SaaS、不回传。

## 特性

- **直接兼容** OpenAI Chat Completions、Anthropic Messages、OpenAI Responses，含 SSE 流式（Chat 与 Messages）。
- **跨协议互译**：经统一的内部表示，精细映射 SSE 事件。
- **三层分类级联**：确定性规则 → 可选小模型 eval → `balanced` 兜底。
- **基于 lane 的路由**：首条匹配策略 + 按组织的上限封顶。
- **多 provider 执行**：跨 provider 回退链、能力过滤（JSON / 工具 / 视觉 / 上下文 / 流式）、按模型的熔断器。
- **可插拔存储**：默认 SQLite，可选 Postgres/Supabase，统一藏在 Store 端口接口之后。
- **强制 API key 鉴权**、首次启动引导 root key、可选的 per-key 限流（RPM/TPM）。
- **自带管理界面**（SvelteKit SPA）：管理 key、lane、策略、分类器调参、请求调试、系统设置——由 HTTP Basic 鉴权保护，支持 5 种语言。

## 架构

```
        ┌──────────────────────────── Helm API 网关 (Hono) ───────────────────────────────┐
        │                                                                                  │
客户端 ─┤  /v1/chat/completions ─┐                                                          │
(OpenAI/ │  /v1/messages ─────────┼─▶ 鉴权 ─▶ 限流 ─▶ 分类 ─▶ 路由 ─▶ 执行 ───────────────┼─▶ 上游
 Anthropic) /v1/responses ────────┘     │        │        │        │        │              │   provider
        │                               │        │        │        │        │              │  (openai-crs,
        │   /admin (SPA, HTTP Basic) ───┘   per-key RPM/TPM 三层级联 lane+策略 provider 回退 │   zenmux,
        │   /admin/api/*                                                    + 熔断器        │   openrouter…)
        │   /healthz  /version                                                              │
        │                                                                                   │
        └──────────────────────────── 存储（默认 SQLite · 可选 Postgres）────────────────────┘
              key · 决策遥测 · 请求正文 · 限流桶 · 记忆
```

核心（`packages/core`）承载所有路由/分类/provider/翻译/存储逻辑，不依赖任何 Web 框架。网关（`apps/gateway`）是一层轻薄的 Hono，并负责托管管理界面 SPA。

## 快速开始（Docker）

```bash
# 1. 获取配置与 env 文件
git clone https://github.com/EasyMetaAu/helm-api.git && cd helm-api
cp .env.example .env
#    编辑 .env —— 设置 HELM_ADMIN_PASSWORD，至少填好 OPENAI_API_KEY

# 2. 运行
docker compose up -d

# 3. 首次启动会打印一次 root API key —— 从日志里复制下来
docker compose logs helm | grep -i "root key"
```

- 网关：`http://localhost:8080`
- 管理界面：`http://localhost:8080/admin`（用 `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` 登录）
- 健康/版本：`GET /healthz`、`GET /version`

`docker-compose.yml` 将 `./config` 与 `./data` 挂载为卷，配置与 SQLite 数据库会在重启间持久化。凭证仅经环境变量注入——绝不写进镜像。

## 使用网关

把任意 OpenAI 兼容客户端指向 Helm，并使用 Helm 的 API key：

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $HELM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "balanced",
    "messages": [{"role": "user", "content": "用两句话解释一致性哈希。"}],
    "stream": true
  }'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="<你的-helm-key>")
client.chat.completions.create(
    model="balanced",                       # 或 economy / premium / 某个任务 lane
    messages=[{"role": "user", "content": "你好"}],
)
```

| 端点 | 协议 | 流式 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | ✅ SSE |
| `POST /v1/messages` | Anthropic Messages | ✅ SSE |
| `POST /v1/responses` | OpenAI Responses | ❌ 非流式（0.1） |

> `model` 字段接受一个 **lane** 名（`economy`、`balanced`、`premium`，或如 `coding` 的任务 lane）。若省略或无法识别，Helm 会自行分类并为你选 lane。核心中已有 Gemini 适配器，但尚未暴露为路由——见[路线图](docs/09-roadmap.md)。

## 配置

一切皆为 `config/*.yaml` 中的配置即代码（由 Zod 校验；非法配置拒绝启动）。可热重载的文件也能在管理界面中实时编辑。

| 文件 | 用途 | 可实时编辑 |
|---|---|---|
| `server.yaml` | 主机 / 端口 / base path | — |
| `auth.yaml` | 强制 API key + root key 引导 | — |
| `runtime.yaml` | 请求限制、限流默认值、存储驱动 | 部分 |
| `providers.yaml` | 上游 provider + 模型别名（凭证只填环境变量**名**） | — |
| `lanes.yaml` | lane 定义（primary + fallback 链、约束） | ✅ |
| `policies.yaml` | 首条匹配的路由策略 | ✅ |
| `classifier.yaml` | 第 1 层规则 + 第 2 层 eval 设置 | ✅ |
| `capabilities.yaml` / `pricing.yaml` | 对生成的模型目录的手动覆盖 | — |

关键环境变量（完整列表见 [`.env.example`](.env.example)）：

| 变量 | 用途 |
|---|---|
| `OPENAI_API_KEY` | 主 provider 凭证（**必填**） |
| `ZENMUX_API_KEY`、`OPENROUTER_API_KEY` | 可选的回退 provider 凭证 |
| `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` | 管理界面 HTTP Basic 凭证 |
| `HELM_PORT` / `HELM_HOST` | 服务绑定（默认 `0.0.0.0:8080`） |
| `HELM_STORE_DRIVER` | `sqlite`（默认）或 `supabase` |
| `HELM_RATE_LIMIT_ENABLED` | 限流总开关（默认关闭） |

默认 lane：**economy** / **balanced** / **premium**，外加任务 lane **coding** / **json** / **vision** / **tool_use**。`balanced` 是分类兜底的终点（必需）。

## 管理界面

托管于 `/admin`，由 HTTP Basic 鉴权保护。页面：仪表盘、API key（创建 / 吊销 / per-key 限流）、lane、策略、分类器调参、请求遥测（列表 + 决策链详情）、系统设置（正文抓取、保留期、限流开关）。支持英文（默认）、简体/繁体中文、日语、韩语。

## 仓库结构

```
helm-api/
├─ apps/
│  ├─ gateway/   # Hono API + 托管管理界面 SPA + /healthz、/version
│  └─ admin/     # SvelteKit + Tailwind 管理界面（adapter-static SPA）
├─ packages/
│  ├─ core/      # 路由 · 分类 · provider · 协议互译 · Store 端口（框架无关）
│  └─ shared/    # Zod schema + 共享类型（类型唯一来源）
├─ config/       # 默认 lanes / policies / classifier / providers / … YAML
├─ docs/         # 文档（按 01 → 11 阅读）
└─ scripts/      # sync:catalog 等构建期工具
```

## 开发

需要 **Node ≥ 22** 与 **pnpm**。

```bash
pnpm install
pnpm dev          # 管理界面开发服务器
pnpm test         # Vitest 单测
pnpm test:e2e     # Playwright 端到端测试
pnpm typecheck    # 全仓 tsc --noEmit
pnpm lint         # Biome
pnpm build        # 构建网关 + 管理界面静态资源
pnpm sync:catalog # 刷新生成的模型目录（能力 + 定价）
```

项目以测试先行的方式开发（核心用 Vitest，端到端流程用 Playwright）。完整规格见 [`docs/`](docs/README.md)，设计决策与取舍见 [`implementation-notes.md`](implementation-notes.md)。

## 文档

请按顺序阅读——从 [`docs/README.md`](docs/README.md) 开始：

[01 总览](docs/01-overview.md) ·
[02 架构](docs/02-architecture.md) ·
[03 分类](docs/03-classification.md) ·
[04 路由与 Lane](docs/04-routing-and-lanes.md) ·
[05 协议互译](docs/05-protocol-translation.md) ·
[06 鉴权与限流](docs/06-auth-and-rate-limits.md) ·
[07 可观测性](docs/07-observability.md) ·
[08 记忆中间件](docs/08-memory-middleware.md) ·
[09 路线图](docs/09-roadmap.md) ·
[10 部署](docs/10-deployment.md) ·
[11 管理界面](docs/11-admin-ui.md)

> 文档正文为英文（开源社区通用语言）；本中文 README 提供项目概览。

## 路线图

0.1 交付完整的路由网关、三种客户端协议、多 provider 回退、管理界面，以及观察式记忆的 **observe** 阶段。后续计划：Gemini 客户端路由、`/v1/responses` 流式、记忆 **inject** 阶段，以及更丰富的配额/限流控制。见 [09 路线图](docs/09-roadmap.md)。

## 贡献

欢迎提交 issue 与 PR。请在分支上开发，并在开 PR 前确保 CI 全绿（`pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e`）。

## 许可证

[MIT](LICENSE) © 2026 EasyMeta AU / 路田（上海）网络科技有限公司
