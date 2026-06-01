<div align="center">

# Helm API

[English](README.md) · **简体中文**

### 用一份配置，把每个 LLM 请求送到最合适的模型——而不是写死在代码里。

*给大模型流量配个 **nginx**。* 开源、自托管、MIT。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![Built with Hono](https://img.shields.io/badge/gateway-Hono-ff5e00.svg)](https://hono.dev)
[![Admin: SvelteKit](https://img.shields.io/badge/admin-SvelteKit-ff3e00.svg)](https://kit.svelte.dev)

</div>

你把应用接到了某个模型，然后呢——出了更便宜的新模型、供应商开始限流、某条请求要用上视觉、账单悄悄往上涨……每改一次，都得重新发一次版。**Helm API 在你的供应商前面架一层又快又薄的网关，把这些选择从代码里挪进配置里。**

客户端照常发 OpenAI 或 Anthropic 请求，Helm 先掂量这条请求有多"重"，把它分到对应的 **lane**（`economy` / `balanced` / `premium` ……），交给带自动故障转移的 provider 适配器执行，并把"为什么这条请求走了这条路"原原本本记下来。你的应用自始至终只动 `base_url` 和 API key，其余的随你在配置文件或自带控制台里慢慢调。

```bash
# 应用代码原封不动，只换 base_url 和 key
client = OpenAI(base_url="http://localhost:8080/v1", api_key="<helm-key>")
client.chat.completions.create(model="balanced", messages=[...])   # 用哪个模型，交给 Helm
```

---

## ✨ 为什么用 Helm

- **对外给的是 lane，不是模型清单。** 调用方只说意图——`economy`、`balanced`、`premium`——根本不用关心背后是哪家供应商、哪个型号。想换模型？改 lane 就行，客户端一行都不用动。
- **配置才是主角，配错就别想起来。** 路由、lane、策略、供应商全写在 `config/*.yaml` 里，由 Zod 校验。配置不合法，Helm 宁可**拒绝启动**，也绝不带病上线。
- **旁路出岔子，主流程不背锅。** 分类、eval、缓存任意一环抽风，请求都会悄悄降级到 `balanced` 继续跑，绝不为这点小事甩你一个 5xx。只有当**所有供应商**真的全挂了，才会给出结构化错误。
- **快路径是确定性的。** 路由判断是个纯函数：零网络、可单测、跑多少遍结果都一样。那个可选的"小模型复核"以 `temperature: 0` 运行、带缓存，而且**默认关闭**——不偷偷加延迟，也不偷偷烧钱。
- **密钥只存哈希，正文照样留底。** API key 只以 SHA-256 哈希落库，日志里不打、响应里不回显；完整的请求/响应正文进单独的表，可开关、可设保留期——出了问题真能查。
- **能无头跑，也能有面子。** 整套路由引擎不依赖任何 Web 框架，没界面照样跑；想要的时候，又有一个像样的管理控制台等着你。
- **跑在自己手里。** MIT 协议、Docker 部署，不做 SaaS、不回传数据。你的网关，你的机器。

## 🧩 都有些什么

- 🔌 **直接兼容** OpenAI Chat Completions、Anthropic Messages、OpenAI Responses——Chat 与 Messages 还支持 SSE 流式。
- 🔁 **各种"方言"通吃**：统一收敛到一套内部表示，SSE 事件映射帮你处理好。
- 🧭 **三层路由**：确定性规则 → 可选的小模型 eval → `balanced` 兜底。
- 🛣️ **lane + 策略引擎**：首条匹配规则，外加按组织封顶。
- 🪂 **跨供应商故障转移**：能力过滤（JSON / 工具 / 视觉 / 上下文 / 流式）一应俱全，每个模型还各有一只熔断器。
- 💾 **存储随你换**：开箱即用 SQLite，规模上来了换 Postgres/Supabase——同一套接口，说换就换。
- 🔒 **鉴权默认就开**：强制 API key，首次启动自动生成一把 root key，可选的 per-key RPM/TPM 限流。
- 📊 **一个真能用的控制台**（SvelteKit）：管 key、调 lane 与策略、调分类器、扒请求详情——HTTP Basic 鉴权，支持 5 种语言。

## 🗺️ 一条请求是怎么流动的

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

路由的"大脑"在 `packages/core` 里，不依赖任何 Web 框架；`apps/gateway` 只是一层薄薄的 Hono 外壳，顺带托管控制台。

## 🚀 三步跑起来

```bash
# 1. 克隆 + 准备 env 文件
git clone https://github.com/EasyMetaAu/helm-api.git && cd helm-api
cp .env.example .env
#    在 .env 里填好 HELM_ADMIN_PASSWORD，至少再填上 OPENAI_API_KEY

# 2. 起服务
docker compose up -d

# 3. 把首次启动只打印一次的 root API key 抄下来
docker compose logs helm | grep -i "root key"
```

搞定：

- **网关** → `http://localhost:8080`
- **控制台** → `http://localhost:8080/admin`（用 `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` 登录）
- **健康 / 版本** → `GET /healthz`、`GET /version`

`docker-compose.yml` 把 `./config` 和 `./data` 挂成卷，配置和 SQLite 数据库重启都还在。凭证只经环境变量注入，绝不打进镜像。

## 🔗 怎么调用

任意 OpenAI 兼容客户端都行，把地址指向 Helm、带上 Helm 的 key 就好：

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
| `POST /v1/chat/completions` | OpenAI Chat Completions | ✅ SSE |
| `POST /v1/messages` | Anthropic Messages | ✅ SSE |
| `POST /v1/responses` | OpenAI Responses | ❌ 非流式（0.1） |

> 填 `economy`、`balanced`、`premium`，或像 `coding` 这样的任务 lane 都行。不填（或填个不认识的），Helm 就自己分类、替你挑一条 lane。核心里已经有 Gemini 适配器，只是还没接成路由——见[路线图](docs/09-roadmap.md)。

## ⚙️ 配置

一切皆为 `config/*.yaml` 里的配置即代码——Zod 校验、配错即拒。可热重载的那几个，也能直接在控制台里改。

| 文件 | 管什么 | 可热改 |
|---|---|---|
| `server.yaml` | 主机 / 端口 / base path | — |
| `auth.yaml` | 强制 API key + root key 引导 | — |
| `runtime.yaml` | 请求上限、限流默认值、存储驱动 | 部分 |
| `providers.yaml` | 上游供应商 + 模型别名（凭证只填环境变量**名**） | — |
| `lanes.yaml` | lane（primary + fallback 链、约束） | ✅ |
| `policies.yaml` | 首条匹配的路由规则 | ✅ |
| `classifier.yaml` | 第 1 层规则 + 第 2 层 eval | ✅ |
| `capabilities.yaml` / `pricing.yaml` | 对模型目录的手动覆盖 | — |

最常用的环境变量（完整清单见 [`.env.example`](.env.example)）：

| 变量 | 用途 |
|---|---|
| `OPENAI_API_KEY` | 主供应商凭证（**必填**） |
| `ZENMUX_API_KEY`、`OPENROUTER_API_KEY` | 备用供应商凭证（选填） |
| `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` | 控制台登录 |
| `HELM_PORT` / `HELM_HOST` | 服务绑定（默认 `0.0.0.0:8080`） |
| `HELM_STORE_DRIVER` | `sqlite`（默认）或 `supabase` |
| `HELM_RATE_LIMIT_ENABLED` | 限流总开关（默认关闭） |

默认带 **economy** / **balanced** / **premium** 三条 lane，外加任务 lane **coding** / **json** / **vision** / **tool_use**。`balanced` 是每次分类都能稳稳退守的那条兜底线。

## 🖥️ 控制台

在 `/admin`，HTTP Basic 鉴权后面：实时仪表盘、API key 管理（创建 / 吊销 / per-key 限流）、lane 与策略编辑器、分类器调参、带完整决策链下钻的请求遥测，以及系统设置（正文抓取、保留期、限流开关）。界面支持英文（默认）、简体与繁体中文、日语、韩语。

## 🗂️ 仓库结构

```
helm-api/
├─ apps/
│  ├─ gateway/   # Hono API + 托管控制台 + /healthz、/version
│  └─ admin/     # SvelteKit + Tailwind 控制台（adapter-static SPA）
├─ packages/
│  ├─ core/      # 路由 · 分类 · provider · 协议互译 · Store 端口（不依赖框架）
│  └─ shared/    # Zod schema + 共享类型（类型唯一来源）
├─ config/       # 默认 lanes / policies / classifier / providers / … YAML
├─ docs/         # 文档（按 01 → 11 阅读）
└─ scripts/      # sync:catalog 等构建期工具
```

## 🛠️ 本地开发

需要 **Node ≥ 22** 和 **pnpm**。

```bash
pnpm install
pnpm dev          # 控制台开发服务器
pnpm test         # Vitest 单测
pnpm test:e2e     # Playwright 端到端测试
pnpm typecheck    # 全仓 tsc --noEmit
pnpm lint         # Biome
pnpm build        # 构建网关 + 控制台资源
pnpm sync:catalog # 刷新生成的模型目录（能力 + 定价）
```

测试先行（核心用 Vitest，链路用 Playwright）。完整规格见 [`docs/`](docs/README.md)，设计决策与取舍记在 [`implementation-notes.md`](implementation-notes.md)。文档正文为英文（开源社区通用语），本页提供中文导览。

## 📚 文档

建议按顺序读，从 [`docs/README.md`](docs/README.md) 起步：

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

## 🧭 路线图

**0.1** 交付完整的路由网关、三种客户端协议、跨供应商故障转移、控制台，以及观察式记忆的 *observe* 阶段。接下来：Gemini 客户端路由、`/v1/responses` 流式、记忆的 *inject* 阶段，以及更细的配额控制。详见 [09 路线图](docs/09-roadmap.md)。

## 🤝 参与贡献

欢迎提 issue 和 PR。请在分支上开发，开 PR 前先把 CI 跑绿：

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
```

## 📄 许可证

[MIT](LICENSE) © 2026 EasyMeta AU / 路田（上海）网络科技有限公司
