<div align="center">

# Helm API

[English](README.md) · **简体中文**

### 一个网关，挡在你所有大模型供应商前面——用配置选模型，而不是改代码。

开源 · 自托管 · MIT

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![Built with Hono](https://img.shields.io/badge/gateway-Hono-ff5e00.svg)](https://hono.dev)
[![Admin: SvelteKit](https://img.shields.io/badge/admin-SvelteKit-ff3e00.svg)](https://kit.svelte.dev)

</div>

**痛点。** 你的应用写死了一个模型。等哪天你想给简单的请求换个更便宜的模型、给难的请求上更强的模型，或者在某个供应商挂掉时自动切到备用——你都得改代码、重新部署。

**Helm 做的事。** Helm 站在你的应用和各家模型供应商中间。应用照常把 OpenAI 或 Anthropic 请求发给 Helm；Helm 判断这条请求该用哪个模型，调用对应的供应商（失败就自动换备用），并记录每一次决策。你的应用始终只需要设置 `base_url` 和 API key——所有路由逻辑都放在一份你自己掌控的配置文件里。

你填的不再是某个模型名，而是一条 **lane**（车道）——比如 `economy`、`balanced`、`premium` 这样的档位。Helm 会在背后把每条 lane 对应到真实的模型，所以你换模型的时候，应用一行都不用改。

```python
# 你的应用：还是同一个 OpenAI 客户端，只换 base_url 和 key。
client = OpenAI(base_url="http://localhost:8080/v1", api_key="<helm-key>")
client.chat.completions.create(model="balanced", messages=[...])   # 用哪个模型，交给 Helm
```

---

## 为什么用它

- **换模型不用改代码。** 在配置文件里把某条 lane 指到另一个模型即可，客户端完全无感。
- **不会无故报错。** 万一某个可选环节出问题（分类、打分、缓存），请求会自动退回 `balanced` 这条 lane 继续跑。只有当所有供应商都真的不可用时，才会返回错误。
- **默认就是安全的。** 配置不合法就拒绝启动；API key 只保存哈希值；限流和那个可选的打分模型默认都关着，需要时你再打开。
- **每一次决策都看得见。** 每条请求都会记录走了哪条 lane、最终用了哪个模型、为什么、花了多少钱，在控制台里都能查到。
- **跑在你自己的机器上。** MIT 协议、Docker 部署，不做 SaaS，数据不会离开你的服务器。

## 它能做什么

- 接收 **OpenAI Chat Completions**、**Anthropic Messages**、**OpenAI Responses** 请求——前两者支持流式。
- 在不同协议之间互译，一个客户端就能对接多家后端。
- 用内置的快速规则挑选 lane（还可以加一个小模型做二次确认，默认关闭）。
- 自动在多个供应商之间回退，会先检查每个候选模型的能力（JSON、工具、视觉、上下文长度），并跳过正在故障的。
- 默认用 SQLite 存储，规模上来了可以换成 Postgres/Supabase。
- 自带网页控制台，用来管理 key、lane、策略和排查请求——支持 5 种语言。

## 一条请求是怎么流动的

```
        ┌──────────────────────────── Helm API 网关 (Hono) ───────────────────────────────┐
        │                                                                                  │
客户端 ─┤  /v1/chat/completions ─┐                                                          │
(OpenAI/ │  /v1/messages ─────────┼─▶ 鉴权 ─▶ 限流 ─▶ 分类 ─▶ 路由 ─▶ 执行 ───────────────┼─▶ 上游
 Anthropic) /v1/responses ────────┘     │        │        │        │        │              │   provider
        │                               │        │        │        │        │              │  (openai-crs,
        │   /admin (SPA, HTTP Basic) ───┘  per-key RPM/TPM 选一条 lane 应用策略 逐个尝试，   │   zenmux,
        │   /admin/api/*                                                  失败就回退        │   openrouter…)
        │   /healthz  /version                                                              │
        │                                                                                   │
        └──────────────────────────── 存储（默认 SQLite · 可选 Postgres）────────────────────┘
              key · 决策日志 · 请求正文 · 限流计数 · 记忆
```

路由逻辑都在 `packages/core` 里，不依赖任何 Web 框架；`apps/gateway` 只是一层很薄的 Hono，顺带托管控制台。

## 快速开始

三条命令把网关跑起来：

```bash
# 1. 克隆并准备 env 文件
git clone https://github.com/EasyMetaAu/helm-api.git && cd helm-api
cp .env.example .env
#    在 .env 里设置 HELM_ADMIN_PASSWORD，并至少填上 OPENAI_API_KEY

# 2. 启动
docker compose up -d

# 3. 复制 root API key——它只在首次启动时打印一次
docker compose logs helm | grep -i "root key"
```

- **网关** → `http://localhost:8080`
- **控制台** → `http://localhost:8080/admin`（用 `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` 登录）
- **健康 / 版本** → `GET /healthz`、`GET /version`

`docker-compose.yml` 把 `./config` 和 `./data` 挂成卷，所以配置和数据库重启后都还在。凭证只通过环境变量传入，不会打进镜像。

## 怎么调用

任何 OpenAI 兼容的客户端都行。把地址指向 Helm，用 Helm 的 key 即可：

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

`model` 字段填的是 **lane** 名，而不是某家厂商的具体型号：

| 端点 | 协议 | 流式 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | ✅ |
| `POST /v1/messages` | Anthropic Messages | ✅ |
| `POST /v1/responses` | OpenAI Responses | ❌ 暂不支持（0.1） |

> 可以填 `economy`、`balanced`、`premium`，或者像 `coding` 这样的任务 lane。留空（或填一个 Helm 不认识的名字），Helm 就自己替你选一条 lane。核心里已经有 Gemini 适配器，只是还没接成路由——见[路线图](docs/09-roadmap.md)。

## 配置

所有配置都在 `config/*.yaml` 里。文件加载时会校验，配置不合法就不让网关启动。其中 lane、策略、分类器还能直接在控制台里改。

| 文件 | 管什么 | 可热改 |
|---|---|---|
| `server.yaml` | 主机 / 端口 / base path | — |
| `auth.yaml` | 是否强制 API key + 首次启动生成 root key | — |
| `runtime.yaml` | 请求上限、限流默认值、存储驱动 | 部分 |
| `providers.yaml` | 上游供应商 + 模型别名（凭证只填环境变量**名**） | — |
| `lanes.yaml` | lane——每条 lane 的主模型和它的备用链 | ✅ |
| `policies.yaml` | 选择或封顶 lane 的规则 | ✅ |
| `classifier.yaml` | 内置规则 + 可选的打分模型 | ✅ |
| `capabilities.yaml` / `pricing.yaml` | 对模型目录的手动覆盖 | — |

最常用的环境变量（完整清单见 [`.env.example`](.env.example)）：

| 变量 | 用途 |
|---|---|
| `OPENAI_API_KEY` | 主供应商凭证（**必填**） |
| `ZENMUX_API_KEY`、`OPENROUTER_API_KEY` | 备用供应商凭证（选填） |
| `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` | 控制台登录 |
| `HELM_PORT` / `HELM_HOST` | 服务绑定（默认 `0.0.0.0:8080`） |
| `HELM_STORE_DRIVER` | `sqlite`（默认）或 `supabase` |
| `HELM_RATE_LIMIT_ENABLED` | 打开限流（默认关闭） |

Helm 自带 **economy**、**balanced**、**premium** 三条 lane，外加任务 lane **coding**、**json**、**vision**、**tool_use**。`balanced` 是每条请求都能安全退回的那条 lane。

## 控制台

在 `/admin`，用账号密码（HTTP Basic）登录后：实时概览、API key 管理（创建、吊销、设置单个 key 的限额）、lane 与策略编辑器、分类器设置，以及一份能逐条下钻、看清每个请求是怎么被路由的请求日志。支持英文（默认）、简体与繁体中文、日语、韩语。

## 仓库结构

```
helm-api/
├─ apps/
│  ├─ gateway/   # Hono API + 托管控制台 + /healthz、/version
│  └─ admin/     # SvelteKit + Tailwind 控制台（静态 SPA）
├─ packages/
│  ├─ core/      # 路由、分类、provider、协议互译、存储端口（不依赖框架）
│  └─ shared/    # Zod schema + 共享类型（类型唯一来源）
├─ config/       # 默认 lanes / policies / classifier / providers / … YAML
├─ docs/         # 文档（按 01 → 11 阅读）
└─ scripts/      # sync:catalog 等构建期工具
```

## 本地开发

需要 **Node ≥ 22** 和 **pnpm**。

```bash
pnpm install
pnpm dev          # 控制台开发服务器
pnpm test         # Vitest 单测
pnpm test:e2e     # Playwright 端到端测试
pnpm typecheck    # 全仓 tsc --noEmit
pnpm lint         # Biome
pnpm build        # 构建网关 + 控制台
pnpm sync:catalog # 刷新生成的模型目录（能力 + 定价）
```

测试先行（核心用 Vitest，完整链路用 Playwright）。完整规格见 [`docs/`](docs/README.md)，设计决策记录在 [`implementation-notes.md`](implementation-notes.md)。文档正文是英文（开源社区通用语），本页提供中文导览。

## 文档

建议按顺序读，从 [`docs/README.md`](docs/README.md) 开始：

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

## 路线图

**0.1** 包含完整的路由网关、三种客户端协议、多供应商回退、控制台，以及记忆功能的前半部分（observe，观察）。接下来：Gemini 路由、`/v1/responses` 流式、记忆的后半部分（inject，注入），以及更细的配额控制。详见 [09 路线图](docs/09-roadmap.md)。

## 参与贡献

欢迎提 issue 和 PR。请在分支上开发，开 PR 前先确保各项检查通过：

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
```

## 许可证

[MIT](LICENSE) © 2026 EasyMeta AU / 路田（上海）网络科技有限公司
