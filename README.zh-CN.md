<div align="center">

# Helm API

[English](README.md) · **简体中文**

### 一个网关，挡在所有 LLM 供应商前面。选模型靠配置，不靠改代码。

开源 · 自托管 · MIT

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.8.6-blue.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![Built with Hono](https://img.shields.io/badge/gateway-Hono-ff5e00.svg)](https://hono.dev)
[![Admin: SvelteKit](https://img.shields.io/badge/admin-SvelteKit-ff3e00.svg)](https://kit.svelte.dev)

</div>

兜底逻辑、各家供应商的怪癖、成本权衡、模型更替——这些东西，你正在往每一个客户端里重复维护。它们本该集中在一个地方，藏在一个接口后面。

Helm API 就是这个地方：一个开源、自托管的 **LLM 路由网关**——*LLM 世界的 nginx*。你的应用照常发一个 OpenAI、Anthropic 或 Gemini 请求；由一份声明式 YAML 配置决定哪个模型来应答、供应商挂了切到哪个备用、协议怎么双向互译，并把每一次决策记录在案。客户端只设 `base_url` 和 API key，别的什么都不用管。

> **把流量当配置来管，而不是当代码来改。**

```python
# 你的应用：还是那个 OpenAI 客户端，只换 base_url 和 key。
client = OpenAI(base_url="http://localhost:8080/v1", api_key="<helm-key>")
client.chat.completions.create(model="auto", messages=[...])   # Helm 负责分类与路由
```

要换 lane 背后的模型？改一行 YAML，或在面板里点一下。应用毫无感知。

## 快速上手

**前置条件：** [Docker](https://docs.docker.com/get-docker/)；或 **Node ≥ 22** + **pnpm 10** 从源码构建。

```bash
# 1. 克隆并创建环境变量文件
git clone https://github.com/EasyMetaAu/helm-api.git && cd helm-api
cp .env.example .env
#    在 .env 里至少设好 HELM_ADMIN_PASSWORD 和 DEEPSEEK_API_KEY

# 2. 启动
docker compose up -d

# 3. 复制 root API key —— 首次启动时生成，只打印一次
docker compose logs helm | grep -i "root API key"
```

| 入口 | 地址 |
|---|---|
| 网关 | `http://localhost:8080`（`/` 是状态落地页） |
| 管理面板 | `http://localhost:8080/admin` —— 用 `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` 登录 |
| API 文档 | `GET /docs`（Swagger UI）· `GET /openapi.json`（OpenAPI 3.1，与网关校验所用为同一套 Zod schema） |
| 健康 / 版本 | `GET /healthz` · `GET /version` |

`docker-compose.yml` 挂载了 `./config` 和 `./data`——配置和数据库都能跨重启保留。凭证只经环境变量注入，绝不打进镜像。

## 你能得到什么

|  | 功能 | 说明 |
| :---: | :--- | :--- |
| 🔀 | **四种客户端协议** | OpenAI Chat、Anthropic Messages、OpenAI Responses、Google Gemini——全部支持流式 + 非流式。中间是同一套 IR：任意客户端触达任意后端，输出格式一致，SSE 也不例外。 |
| 🧭 | **三层分类** | 确定性规则（纯函数、零网络、有单测——常驻开启）→ 可选的小模型 eval（`temperature: 0`、带缓存、默认关闭——需要先配好 eval 模型）→ `balanced` lane 作为 fail-open 兜底口。 |
| 🛣️ | **Lane + 策略路由** | 请求走 lane（`economy` / `balanced` / `premium`，外加任务 lane `coding`、`json`、`vision`、`tool_use`），从不直接面对供应商名。首条命中的策略可以钉死或封顶 lane。每条 lane = 一个主模型 + 一条兜底链，全在配置里。 |
| 🛡️ | **稳健的执行层** | 熔断器（OPEN/HALF_OPEN + 单探针）、能力过滤（跳过候选时记下明确原因）、`:free` 档 429 跳过、按 key 并发排队。客户端断连永远不算供应商故障。 |
| 🔐 | **OAuth 订阅** | 把 Claude Pro/Max、ChatGPT Codex、GitHub Copilot 的**订阅**当后端来路由——多账号组池，逐账号做模型策展 / 出口代理 / 调度，全部热重载。*（可选功能，先读 [ToS 警告](#oauth-订阅类供应商claude-promaxchatgpt-codexgithub-copilot)。）* |
| 🔑 | **带约束力的 key** | 强制鉴权；key 只存 SHA-256 哈希。每把 key 可设：lane 白名单、自定义模型权限、RPM/TPM 限流、用量预算（降级或拒绝）、并发上限、记忆模式。先软吊销，再永久删除。 |
| 🧠 | **Memory 中间件** | 默认开启：路由前把记忆注入上下文；后台 worker 负责压缩与归并——压缩**全自动、零配置**（价格与上下文窗口取自模型目录；按体量 / 空闲 / 上下文压力三种时机触发）；遗忘/分层机制（衰减、强化、保留期）防止记忆膨胀。可按 key 或按请求关闭（`x-memory-mode: off`）。 |
| 📊 | **全程可观测** | 每个请求一条脱敏决策记录——分类、策略、lane、每次供应商尝试、延迟、兜底、成本。正文逐字捕获单独存表（默认开，保留 30 天）。可编辑的 **Retry** 按钮能重放任何已捕获的请求。 |
| 🖥️ | **管理面板** | `/admin` 上的 SvelteKit SPA，HTTP Basic 把守：概览、key 增删改、lane / 策略 / 分类器编辑器、系统设置、可下钻的请求日志。编辑会**写回 `config/*.yaml`**（保留注释、原子写入）并实时重绑——无需重启，重启也不丢。支持 5 种语言。 |
| 💾 | **存储** | 默认 SQLite（一个本地文件）。Postgres / Supabase 走同一套 Store 端口抽象——改一个环境变量即可切换。 |

**路线图：** 接 LLM 的记忆摘要（observer/reflector 的摘要步骤目前是确定性桩）· 更细粒度的配额 / 账户级计费。详见 [09 路线图](docs/09-roadmap.md)。

## 两套失败纪律

整个设计都挂在这条规则上：

- **配置与凭证 fail-closed。** YAML 非法、缺必填 key、存储驱动未知——网关直接拒绝启动，绝不带病运行。
- **请求路径 fail-open。** 分类、eval、记忆、缓存——任何可选环节出岔子，都悄悄降级到 `balanced` lane 并记入日志。只有链上**所有**供应商都真的挂了，客户端才会拿到一个结构化错误。

还有两套绝不混淆的兜底：*分类兜底*（拿不准 → `balanced` lane）和*执行兜底*（供应商失败 → 链内下一个模型）。机制分开、决策记录字段分开——永远分得清是哪一个触发了。

## 架构

四种客户端协议进入同一套稳定接口；一个不依赖框架的内核干所有活；配置驱动每一个阶段。

```text
CLIENT ── OpenAI · Anthropic · OpenAI Responses · Google Gemini
          一个 base_url + 一把 Helm key · 发 model:"auto"
             │
             ▼
GATEWAY   apps/gateway（Hono）· 薄薄一层 HTTP 外壳 —— 顺带托管 /admin 面板 + /docs
             │   把任意协议归一  ──▶  一个 InternalRequest（IR）
             ▼
CORE      packages/core · 路由大脑（不 import 任何 Web 框架）
             │
             ├─ auth        校验 sha256 key、加载按 key 限额        · fail-closed
             ├─ gate        限流（默认关）· 用量预算（默认关）       · fail-closed
             ├─ memory      把记忆注入上下文（默认开）               · fail-open
             ├─ classify    L1 规则 ─不确定→ L2 eval（默认关）─→ balanced · fail-open
             ├─ resolve     首条命中策略 → lane → 限额 → 兜底链
             ├─ execute     能力过滤 → 熔断器 → provider
             │                  └── 失败时：切到链内下一个模型
             └─ translate   provider 原生  ⇄  IR  ⇄  客户端协议（流式 SSE）
             │
             ▼
RESULT ── 按客户端自己的协议，流式 / JSON 返回
             │
             ├─▶ telemetry   脱敏决策记录 + 正文逐字捕获
             ├─▶ memory      把这一轮写回记忆
             └─▶ upstream    静态 API key + OAuth 订阅（组池 · 热重载）

config/*.yaml 驱动每一个阶段 · 经 Zod 校验 · 非法配置拒绝启动（fail-closed）
```

内核**契约级无头**：路由、分类、provider 执行、协议互译、存储全在 `packages/core` 里，不 import 任何 Web 框架——有架构测试盯着这条线。Hono 和 SvelteKit 只是薄薄一层、可选的外壳。

```text
helm-api/
├─ apps/
│  ├─ gateway/   # Hono API + 托管面板 + /healthz、/version
│  └─ admin/     # SvelteKit + Tailwind 面板（静态 SPA）
├─ packages/
│  ├─ core/      # 路由、分类、provider、协议互译、存储端口（不依赖框架）
│  └─ shared/    # Zod schema + 共享类型（类型唯一来源）
├─ config/       # 默认 lanes / policies / classifier / providers / … YAML
├─ docs/         # 文档（按 01 → 12 顺序读）
└─ scripts/      # sync:catalog 等构建期工具
```

## 调用网关

任何 OpenAI 兼容客户端都能用。指向 Helm，带上一把 Helm key：

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $HELM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "用两句话解释一致性哈希。"}],
    "stream": true
  }'
```

| 端点 | 协议 | 流式 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | ✅ |
| `POST /v1/messages` | Anthropic Messages | ✅ |
| `POST /v1/responses` | OpenAI Responses | ✅ |
| `POST /v1beta/models/{model}:generateContent` | Google Gemini | ✅（走 `:streamGenerateContent?alt=sse`；用 `x-goog-api-key` 鉴权） |

**`model` 字段填什么：**

| 取值 | Helm 的行为 |
|---|---|
| `auto`（推荐） | 对请求做分类，路由到最合适的 lane。 |
| 模型别名，如 `deepseek/deepseek-v4-pro` | 精确使用该模型、跳过路由——仅对有「自定义模型」权限的 key 生效。 |

> 用普通 key 时，路由永远是自动的——直接填 `auto`。Lane 由运维方配置（`lanes.yaml` + 面板），客户端不在单次调用里挑 lane。

**其余端点**（交互式文档在 `/docs`，原始规格在 `/openapi.json`）：

| 端点 | 鉴权 | 用途 |
|---|---|---|
| `GET /` · `GET /healthz` · `GET /version` | — | 落地页 · 就绪探针 · 构建信息 |
| `GET /v1/models` · `GET /v1/models/{id}` | API key | 列出该 key 能路由到的模型（lane + `auto`；自定义模型 key 还会看到带能力与定价的具体别名） |
| `/admin` · `/admin/api/*` | Basic auth | 面板 + 其 JSON 后端（仅在设置了面板凭证时才挂载） |

## 配置

一切都在 `config/*.yaml` 里，加载时经 Zod 校验。**非法配置直接让网关无法启动。** Lane、策略、分类器和系统设置还能在面板里实时编辑——改动会写回 YAML 文件（注释原样保留），下一个请求即生效。

| 文件 | 控制什么 | 可实时改 |
|---|---|---|
| `server.yaml` | 主机 / 端口 / base path | — |
| `auth.yaml` | 是否强制 API key + 首次启动的 root key | — |
| `runtime.yaml` | 请求限额、限流默认值、存储驱动 | 部分 |
| `providers.yaml` | 上游供应商 + 模型别名（凭证只引用环境变量**名**） | — |
| `lanes.yaml` | 每条 lane 的主模型 + 兜底链 | ✅ 持久化 |
| `policies.yaml` | 首条命中、用来挑选或封顶 lane 的规则 | ✅ 持久化 |
| `classifier.yaml` | 内置规则 + 可选的 eval 模型 | ✅ 持久化 |
| `memory.yaml` | 遗忘/分层旋钮（出厂配置即开启）。压缩是全自动的、不提供配置项；旧版遗留的 `observer:` 配置块会导致启动失败 | ✅ |
| `capabilities.yaml` / `pricing.yaml` | 对模型目录的手动覆盖项（含 prompt 缓存读/写价格） | — |

最常用的环境变量（env 优先于 YAML；完整列表见 [`.env.example`](.env.example)）：

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | 主供应商凭证（**必填**） |
| `ZENMUX_API_KEY`、`OPENROUTER_API_KEY` | 可选供应商凭证（缺失则跳过该供应商） |
| `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` | 面板登录（Basic auth） |
| `HELM_HOST` / `HELM_PORT` | 服务绑定（默认 `0.0.0.0:8080`） |
| `HELM_STORE_DRIVER` | `sqlite`（默认）或 `supabase` |
| `HELM_STORE_URL_ENV` | 用 `supabase` 时：存放 Postgres DSN 的环境变量**名** |
| `HELM_RATE_LIMIT_ENABLED` | 打开限流（默认关闭） |
| `HELM_OAUTH_ENC_KEY` | 加密所存 OAuth token 的 32 字节密钥（配了订阅类供应商时**必填**） |

> **存储。** 默认 SQLite（`better-sqlite3`，`./data` 下的 `helm.db` 文件）。要用 Postgres/Supabase：`HELM_STORE_DRIVER=supabase`，再让 `HELM_STORE_URL_ENV` 指向存放 DSN 的环境变量。未知驱动在启动时 fail-closed。
>
> **凭证。** 供应商 key 在 `providers.yaml` 里只按环境变量*名*引用——明文绝不进仓库、不进镜像。

### OAuth 订阅类供应商（Claude Pro/Max、ChatGPT Codex、GitHub Copilot）

供应商除了静态 key，还能用 **OAuth 订阅**鉴权：在面板里登录（**提供商 → 连接**）。Claude Pro/Max 和 ChatGPT Codex 走「粘贴授权码」，GitHub Copilot 走设备码。Helm 把会轮换的 refresh token **加密存盘**，并自动刷新短时的 access token。

先设 **`HELM_OAUTH_ENC_KEY`**（32 字节：base64 或 64 位十六进制）——配置了订阅类供应商却没设这把密钥，Helm 拒绝启动。然后给供应商加一个 `oauth: { provider: anthropic | github-copilot | openai-codex }` 块（`config/providers.yaml` 里有注释掉的示例；Claude 用 `type: anthropic`）。

同一供应商可以**接入多个账号**组成池。每个账号（**提供商 → 管理**）各有：

- **模型** —— 一份实时白名单，不是显示层过滤：移除的模型立刻停止路由，未策展的模型直接被拒（fail-closed）。
- **代理** —— 按账号设 HTTP/HTTPS/SOCKS5 出口，整条订阅链路都走它，让同机的多个账号从不同 IP 出去。
- **调度** —— `priority`（越小越优先）+ `schedulable` 开关；同优先级内按 LRU 轮询。「停泊」一个账号即保持连接但退出轮换。

这里的一切都热重载——连接、断开、策展、代理、调度——下一个请求即生效，无需重启。Helm 还会照搬官方客户端的身份头，并发送**稳定的按账号设备标识**（绝不中途轮换），以降低被关联封号的风险。

> ⚠️ **服务条款。** 把 Claude/ChatGPT/Copilot 的**订阅**通过第三方网关路由，可能违反供应商 ToS，并可能导致账号被封。这是面向自托管、个人使用的可选功能——**合规责任在你自己**。拿不准时，用普通 API key（`api_key_env`）。

## 开发

需要 **Node ≥ 22** 和 **pnpm 10**。

```bash
pnpm install
pnpm dev          # 管理面板开发服务器（Vite）—— 见下方说明
pnpm test         # Vitest 单元测试
pnpm test:e2e     # Playwright 端到端测试
pnpm typecheck    # 全仓库 tsc --noEmit
pnpm lint         # Biome
pnpm build        # 构建网关 + 面板
pnpm sync:catalog # 刷新生成的模型目录（能力 + 定价）
```

> `pnpm dev` 只起 admin SPA。网关没有 watch 脚本——构建后运行（`pnpm build` 再 `node apps/gateway/dist/index.js`），或用 Docker。
>
> 文档目前仅有英文版。

测试先行：core 用 Vitest，完整链路用 Playwright。设计决策记录在 [`implementation-notes.md`](implementation-notes.md)。开 PR 前：

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
```

## 文档

从 [`docs/README.md`](docs/README.md) 开始，按顺序读：

[01 概览](docs/01-overview.md) ·
[02 架构](docs/02-architecture.md) ·
[03 分类](docs/03-classification.md) ·
[04 路由与 Lane](docs/04-routing-and-lanes.md) ·
[05 协议互译](docs/05-protocol-translation.md) ·
[06 鉴权与限流](docs/06-auth-and-rate-limits.md) ·
[07 可观测性](docs/07-observability.md) ·
[08 Memory 中间件](docs/08-memory-middleware.md) ·
[09 路线图](docs/09-roadmap.md) ·
[10 部署](docs/10-deployment.md) ·
[11 管理界面](docs/11-admin-ui.md) ·
[12 记忆的遗忘与分层](docs/12-memory-forgetting-and-tiering.md) ·
[协议兼容性](docs/protocol-compatibility.md)

## 项目状态

Helm API 当前版本 **0.8.6**——一套端到端的真实实现，不是空架子。完整链路（配置 → 鉴权 → 分类 → 路由 → 执行（含熔断与兜底）→ 协议互译 → 遥测）已全部打通，背后是一套相当完整的 Vitest 单测加 Playwright e2e 用例。

## 许可

[MIT](LICENSE) © 2026 EasyMeta AU
