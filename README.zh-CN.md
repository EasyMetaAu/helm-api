<div align="center">

# Helm API

[English](README.md) · **简体中文**

### 一个网关，挡在你所有 LLM 供应商前面 —— 用配置而非代码来选模型。

开源 · 自托管 · MIT

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![Built with Hono](https://img.shields.io/badge/gateway-Hono-ff5e00.svg)](https://hono.dev)
[![Admin: SvelteKit](https://img.shields.io/badge/admin-SvelteKit-ff3e00.svg)](https://kit.svelte.dev)

</div>

Helm API 是一个开源、自托管的 **LLM 路由网关** —— 可以把它理解成 **“LLM 世界的 nginx”**。你的应用照常向 Helm 发一个 OpenAI、Anthropic 或 Gemini 请求，剩下的交给一份声明式 YAML 配置：由它决定该用哪个模型、调用对应供应商（失败就自动切到备用）、按需做协议互译，并把每一次决策都记录下来。客户端始终面对同一套接口和同一种输出格式，只需改 `base_url` 和 API key —— 所有路由逻辑都在你自己掌控的配置里。

> **把流量当配置来管，而不是当代码来改。**

```python
# 你的应用：还是那个 OpenAI 客户端，只换 base_url 和 key。
client = OpenAI(base_url="http://localhost:8080/v1", api_key="<helm-key>")
client.chat.completions.create(model="auto", messages=[...])   # Helm 负责分类与路由
```

---

## 为什么用 Helm

AI 应用开发者不想在每个客户端里维护成百上千个模型、各家供应商的怪癖、兜底逻辑、成本权衡和路由判断。他们要的是**一个接口：足够便宜、足够可靠、默认就够聪明，出问题时还查得清楚。** Helm 给的正是这些：

- **换模型不用改代码。** 在配置文件里把某条 lane 指向另一个模型即可，应用毫无感知。
- **两套失败纪律，各司其职。** 配置与凭证是 **fail-closed** —— 配置非法、或缺了必填的 key，就拒绝启动，绝不带病运行。请求路径是 **fail-open** —— 任何可选环节出岔子（分类、打分、记忆、缓存），都会悄悄降级到 `balanced` lane；只有**所有**供应商都真的挂了，你才会拿到一个结构化错误。
- **默认就安全。** API key 只存 SHA-256 哈希，明文绝不进日志或遥测；限流、用量预算、可选的打分模型和记忆，统统默认关闭，要用才开。
- **每个决策都可观测。** 每个请求都会落一条脱敏的决策记录 —— 走了哪条 lane、最终哪个模型应答、为什么、有没有兜底、花了多少 —— 都能在面板里翻查。完整的请求/响应正文会单独存到本地一张表（默认开启，保留 30 天），方便调试与审计。
- **跑在你自己的机器上。** MIT 许可、Docker 部署。没有 SaaS、没有多租户云，任何数据都不出你的服务器。

## 核心概念

- **Lane（车道）** —— 请求走的是可配置的 *lane*（质量/成本档位 `economy`、`balanced`、`premium`，或任务档位 `coding`、`json`、`vision`、`tool_use`），而不是裸的供应商名。每条 lane 如何映射到「一个主模型 + 一条兜底链」，由你在配置里定。供应商别名只是内部供应链细节，从不暴露给客户端。
- **分类级联** —— 三层挑 lane：**①** 确定性规则（纯函数、零网络、有单测，常驻开启）；**②** 可选的小模型「二次意见」eval（`temperature: 0`、带缓存、**默认关闭**），只在规则拿不准时才咨询；**③** 用 `balanced` lane 作为 fail-open 兜底口。
- **两套兜底，绝不混淆** —— *分类兜底*把没定下来的请求降级到 `balanced` lane；*执行兜底*在某个供应商失败时切到链里的下一个模型。它们记在决策记录的不同字段里，所以你永远分得清是哪一个触发了。
- **协议互译** —— 四种进站协议归一成一套 OpenAI-Chat 形态的内部表示（IR），于是一个客户端就能触达多种后端，并拿到一致的输出格式 —— 含流式 SSE。
- **配置即代码** —— 行为都写在 `config/*.yaml` 里，启动时用 Zod 校验；非法配置 fail-closed，网关拒绝启动。
- **无头内核** —— 整个路由大脑（分类、路由、provider 执行、协议互译、存储）都在 `packages/core` 里，不 import 任何 Web 框架 —— 有架构测试盯着这条线。Hono 网关和 SvelteKit 面板只是薄薄一层、可选的外壳。

## 架构

四种客户端协议进入同一套稳定接口；一个不依赖框架的内核干所有活；一切由配置驱动，并在出站时被记录下来。

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
             ├─ auth        校验 sha256 key、加载按 key 限额      · fail-closed
             ├─ gate        限流（默认关）· 用量预算（默认关）     · fail-closed
             ├─ memory      把记忆注入 prompt（可选，默认关）      · fail-open
             ├─ classify    L1 规则 ─不确定→ L2 eval（默认关）─→ balanced · fail-open
             ├─ resolve     首条命中策略 → lane → 限额 → 兜底链
             ├─ execute     能力过滤 → 熔断器 → provider
             │                  └── 失败时：切到链里的下一个模型
             └─ translate   provider 原生  ⇄  IR  ⇄  客户端协议（流式 SSE）
             │
             ▼
RESULT ── 按客户端自己的协议，流式 / JSON 返回
             │
             ├─▶ telemetry   脱敏决策记录 + 正文逐字捕获
             ├─▶ memory      把这轮对话写回（可选）
             └─▶ upstream    静态 API key + OAuth 订阅（组池 · 热重载）

config/*.yaml 驱动每一个阶段 · 经 Zod 校验 · 非法配置拒绝启动（fail-closed）
```

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

## 项目状态

Helm API 已到 **0.6**，是一套端到端的真实实现，而非空架子。完整链路（配置 → 鉴权 → 分类 → 路由 → 执行（含熔断与兜底）→ 协议互译 → 遥测）已打通，背后有一套相当完整的 Vitest 单测和 Playwright e2e 用例兜底。具体哪些已上线、哪些还只在路线图上，见 [功能](#功能)。

## 功能

**已上线：**

- **四种客户端协议** —— `POST /v1/chat/completions`（OpenAI Chat）、`POST /v1/messages`（Anthropic Messages）、`POST /v1/responses`（OpenAI Responses）、`POST /v1beta/models/{model}:generateContent`（Google Gemini）—— 四者均支持流式 + 非流式（Gemini 的流式即 `:streamGenerateContent?alt=sse`；Gemini 面用 `x-goog-api-key` 鉴权）。
- **跨协议互译** —— 归一到一套 OpenAI-Chat 形态的 IR；跨后端输出格式一致，四个面均支持 SSE。字段覆盖对齐 litellm：采样旋钮、usage 明细（reasoning / cache / 逐模态）、统一的 reasoning/thinking 桥、全量多模态 I/O，以及 `finish_reason` 两向映射。无法映射的旋钮**有据可查地降级**（如 Anthropic 把 `n>1` 钳到 1、对 `logprobs`/`modalities` 报 warning），而不是直接报错——见[协议兼容性](docs/protocol-compatibility.md)矩阵。
- **三层分类** —— 确定性规则常驻；不确定时走可选的小模型 eval（默认关闭）；最后用 `balanced` lane 作 fail-open 兜底口。
- **Lane + 策略路由** —— 首条命中的策略可以钉死或封顶 lane；内置 lane `economy`、`balanced`、`premium`，外加任务 lane `coding`、`json`、`vision`、`tool_use`（`balanced` 是必须存在、永远兜底的那条）。
- **带兜底的 provider 执行** —— 在多个 OpenAI 兼容上游之间走「主 + 兜底」链，配有熔断器（OPEN/HALF_OPEN + 单探针）、能力过滤（缺 JSON / 工具 / 视觉 / 某模态 / 上下文长度 / 流式的候选会被显式跳过并记原因）、以及 `:free` 档 429 跳过。客户端断连不算 provider 故障。
- **OAuth 订阅类供应商** —— 把你的 Claude Pro/Max、ChatGPT Codex、GitHub Copilot **订阅**当作后端来路由：在面板里登录，每个供应商可接入多个账号组成池，逐账号策展模型 / 设出口代理 / 设调度优先级 —— 这些改动全部**热重载**。详见[下文](#oauth-订阅类供应商claude-promaxchatgpt-codexgithub-copilot)。*（可选功能，可能违反供应商服务条款，务必阅读警告。）*
- **强制 API key 鉴权 + 按 key 限额** —— key 只存 SHA-256 哈希；首次启动生成并只打印一次 root key。每把 key 都带 `allowed_lanes` 白名单、是否允许自定义模型、可选的 RPM/TPM 限流、用量预算（请求数/token/花费，可降级或拒绝）、并发上限，以及一个记忆模式。
- **Memory 中间件（可选）** —— 按请求经 `x-memory-mode` 头开启（默认 `off`）：`observe` 写入这轮对话，`inject` 在路由前把记忆读回 prompt。后台 worker 负责压缩（observer）与归并（reflector）；可选的遗忘/分层（衰减、保留期、事实抽取）由 `config.memory.forgetting.enabled` 把守（默认关）。摘要目前是确定性桩 —— 接 LLM 的版本属路线图。
- **可观测性** —— 每个请求一条脱敏决策记录（分类、策略、lane、各次 provider 尝试、延迟、兜底次数、成本拆分、记忆计数），外加可选的正文逐字捕获（单独存表、按保留期清理）。
- **管理面板** —— 一个 SvelteKit + Tailwind 的 SPA，挂在 `/admin`、用 HTTP Basic 保护：实时概览、API key 增删改（含按 key 限额）、lane 与策略编辑器、分类器与系统设置、可下钻的请求日志。支持 5 种语言（英文、简繁中文、日文、韩文）。改动会重新绑定到运行中的配置，下一个请求即生效，无需重启。
- **存储** —— 默认 SQLite（本地文件）；可选 Postgres / Supabase，通过统一的 Store 端口抽象切换。

**路线图：**

- **接 LLM 的记忆** —— observer/reflector 的摘要与事实抽取目前是确定性桩；接小模型的真实版本属后续工作。
- 更细粒度的配额 / 账户级计费。

详见 [09 路线图](docs/09-roadmap.md)。

## 快速上手

**前置条件：** [Docker](https://docs.docker.com/get-docker/)（最快的起步方式），或 **Node ≥ 22** 加 **pnpm 10** 从源码构建。

```bash
# 1. 克隆并创建环境变量文件
git clone https://github.com/EasyMetaAu/helm-api.git && cd helm-api
cp .env.example .env
#    在 .env 里至少设好 HELM_ADMIN_PASSWORD 和 DEEPSEEK_API_KEY

# 2. 启动
docker compose up -d

# 3. 复制 root API key —— 首次启动时生成并只打印一次
docker compose logs helm | grep -i "root API key"
```

- **网关** → `http://localhost:8080`（`/` 有一个状态落地页）
- **面板** → `http://localhost:8080/admin`（用 `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` 登录）
- **API 文档** → `GET /docs`（交互式 Swagger UI）· `GET /openapi.json`（OpenAPI 3.1，由网关校验所用的同一套 Zod schema 生成）
- **健康 / 版本** → `GET /healthz`、`GET /version`

`docker-compose.yml` 挂载了 `./config` 和 `./data`，所以配置和数据库都能跨重启保留。凭证只通过环境变量注入，绝不打进镜像。

### 调用网关

任何 OpenAI 兼容客户端都能用。把它指向 Helm，再带上一把 Helm API key：

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
| `POST /v1beta/models/{model}:generateContent` | Google Gemini | ✅（走 `:streamGenerateContent?alt=sse`） |

**`model` 字段里填什么：**

| 取值 | Helm 的行为 |
|---|---|
| `auto`（推荐） | 对请求做分类，自动路由到最合适的 lane。 |
| 模型别名，如 `deepseek/deepseek-v4-pro` | 精确使用该模型、跳过路由 —— 仅对获授「自定义模型」权限的 key 有效。 |

> 用普通 key 时，无论你发什么，路由都是自动的 —— 直接用 `auto` 即可。Lane 由运维方在 `lanes.yaml` 和面板里配置，客户端不在单次调用里挑 lane。

### API 一览

每个端点都在 **`/docs`** 有交互式文档，原始规格在 **`/openapi.json`**。

| 端点 | 鉴权 | 用途 |
|---|---|---|
| `GET /` | — | 状态落地页 |
| `GET /healthz` · `GET /version` | — | 就绪探针 · 构建信息 |
| `GET /docs` · `GET /openapi.json` | — | 交互式文档 · OpenAPI 3.1 规格 |
| `GET /v1/models` · `GET /v1/models/{id}` | API key | 列出该 key 能路由到的模型（lane + `auto`；自定义模型 key 还会看到带能力与定价的具体别名） |
| `POST /v1/chat/completions` | API key | OpenAI Chat Completions |
| `POST /v1/messages` | API key | Anthropic Messages |
| `POST /v1/responses` | API key | OpenAI Responses |
| `POST /v1beta/models/{model}:generateContent` | API key | Google Gemini |
| `/admin` · `/admin/api/*` | Basic auth | 面板 + 其 JSON 后端（仅在设置了面板凭证时才挂载） |

## 配置

一切都配在 `config/*.yaml` 里。文件加载时经 Zod 校验，**非法配置会让网关无法启动（fail-closed）**。Lane、策略、分类器和系统设置还能在面板里实时编辑，下一个请求即生效。

| 文件 | 控制什么 | 可实时改 |
|---|---|---|
| `server.yaml` | 主机 / 端口 / base path | — |
| `auth.yaml` | 是否要求 API key + 首次的 root key | — |
| `runtime.yaml` | 请求限额、限流默认值、存储驱动 | 部分 |
| `providers.yaml` | 上游供应商 + 模型别名（凭证只引用环境变量**名**） | — |
| `lanes.yaml` | Lane —— 每条 lane 的主模型及其兜底链 | ✅ |
| `policies.yaml` | 首条命中、用来挑选或封顶 lane 的规则 | ✅ |
| `classifier.yaml` | 内置规则与可选的 eval 模型 | ✅ |
| `memory.yaml` | 记忆遗忘/分层的旋钮（整层默认关闭） | ✅ |
| `capabilities.yaml` / `pricing.yaml` | 对模型目录的手动覆盖项 | — |

最常用的环境变量（env 优先于 YAML；完整列表见 [`.env.example`](.env.example)）：

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | 主供应商凭证（**必填**） |
| `ZENMUX_API_KEY`、`OPENROUTER_API_KEY` | 可选供应商凭证（缺失则跳过该供应商） |
| `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` | 面板登录（Basic auth） |
| `HELM_HOST` / `HELM_PORT` | 服务绑定（默认 `0.0.0.0:8080`） |
| `HELM_STORE_DRIVER` | `sqlite`（默认）或 `supabase` |
| `HELM_STORE_URL_ENV` | 用 `supabase` 时：存放 Postgres DSN 的那个环境变量的**名字** |
| `HELM_RATE_LIMIT_ENABLED` | 打开限流（默认关闭） |
| `HELM_OAUTH_ENC_KEY` | 加密所存 OAuth token 的 32 字节密钥（配了订阅类供应商时**必填**） |

> **存储。** 默认 SQLite（`better-sqlite3`，`./data` 下的 `helm.db` 文件）。要用 Postgres/Supabase，把 `HELM_STORE_DRIVER` 设成 `supabase`，再让 `HELM_STORE_URL_ENV` 指向存放 DSN 的环境变量。未知驱动在启动时 fail-closed。
>
> **凭证。** 供应商 key 在 `providers.yaml` 里只按环境变量*名*引用 —— 绝不以明文写进仓库或镜像。

### OAuth 订阅类供应商（Claude Pro/Max、ChatGPT Codex、GitHub Copilot）

除了静态 API key，供应商还能用你在面板里登录的 **OAuth 订阅**来鉴权（**提供商 → 连接**）。Claude Pro/Max 和 ChatGPT Codex 走「粘贴授权码」；GitHub Copilot 走设备码。Helm 把（会轮换的）refresh token **加密存盘**，并自动刷新短时的 access token。

启用前需把 **`HELM_OAUTH_ENC_KEY`** 设成一把 32 字节的密钥（base64，或 64 位十六进制）—— Helm 用它加密存储的 token；若配置了订阅类供应商却没设这把 key，会**拒绝启动**。在供应商上配一个 `oauth: { provider: anthropic | github-copilot | openai-codex }` 块（参见 `config/providers.yaml` 里注释掉的示例）；Claude 用 `type: anthropic`。

同一个供应商可以**接入多个账号**，Helm 把它们组成池。每个账号在 **提供商 → 管理** 里都有各自的：

- **模型** —— 精确策展这个账号向你的 lane 暴露哪些模型。这份策展清单是权威的：移除某个模型后它会立刻不再被路由，未策展的模型会被拒（fail-closed）—— 是一份**实时白名单**，而不只是显示层的过滤。
- **代理** —— 让这个账号的上游流量走 HTTP/HTTPS/SOCKS5 代理，从不同的 IP 出口（多个账号共用一台主机时，避免被关联封号）。
- **调度** —— 一个 `priority`（越小越优先）和一个 `schedulable` 开关。Helm 选优先级最低的账号，同优先级内按 LRU 轮询；把账号「停泊」则保持连接但不参与轮换。

**这里的一切都热重载** —— 连接、断开、模型策展、代理、调度的改动都在下一个请求即生效，无需重启。另外，为了表现得像一方官方客户端，Helm 会照搬官方客户端的身份头，并发送一个**稳定的、按账号固定的设备标识**（绝不会在请求之间乱变），以降低被关联封号的风险。

> ⚠️ **服务条款。** 把 Claude/ChatGPT/Copilot **订阅**通过第三方网关来路由，可能违反供应商的服务条款，并可能成为账号被封的理由。这是面向自托管、个人使用的可选功能 —— **你需自行负责**确保用法符合你与供应商的协议。拿不准时，就改用普通的 API key（`api_key_env`）。

## 管理面板

挂在 `/admin`、由 HTTP Basic auth 把守：实时概览、API key（创建、吊销、设按 key 限额）、lane 与策略编辑器、分类器与系统设置，以及可下钻的请求日志 —— 点进去就能看每个请求是怎么被路由的。**仅当**设置了面板凭证时才挂载，否则 `/admin` 和 `/admin/api/*` 返回 `404`。详见 [11 管理界面](docs/11-admin-ui.md)。

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

> `pnpm dev` 只起 admin SPA。网关没有 watch 脚本；要么构建后运行（`pnpm build` 再 `node apps/gateway/dist/index.js`），要么用 Docker。
>
> 文档目前仅有英文版。

测试先行（core 用 Vitest，完整链路用 Playwright）。设计决策记录在 [`implementation-notes.md`](implementation-notes.md)。开 PR 前，先确认所有检查通过：

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

## 许可

[MIT](LICENSE) © 2026 EasyMeta AU
