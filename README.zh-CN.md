<div align="center">

<img src="docs/assets/logo.svg" width="84" height="84" alt="Helm logo">

# Helm API

[English](README.md) · **简体中文**

### 把 LLM 流量集中管起来：文本、图片、订阅账号、兜底、记忆，一处配置。

开源 · 自托管 · MIT

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/package-json/v/EasyMetaAu/helm-api)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![Built with Hono](https://img.shields.io/badge/gateway-Hono-ff5e00.svg)](https://hono.dev)
[![Admin: SvelteKit](https://img.shields.io/badge/admin-SvelteKit-ff3e00.svg)](https://kit.svelte.dev)

</div>

很多 LLM 应用越做越重：客户端里塞着兜底列表、供应商兼容补丁、写死的模型名、临时成本控制；出了问题还很难回答一句最基本的话：这个请求为什么走到了那个模型？

Helm API 把这些事收回到一个地方：一个开源、自托管的 **LLM 路由网关**——*LLM 世界的 nginx*。你的应用照常发 OpenAI、Anthropic、Gemini 或图片生成请求；Helm 负责分类、选 lane、挑供应商账号、上游故障时兜底、必要时做协议互译，并把完整决策链路记录下来。多数客户端只需要改 `base_url` 和 API key。

> **把流量当配置来管，而不是当代码来改。**

```python
# 你的应用：还是那个 OpenAI 客户端，只换 base_url 和 key。
client = OpenAI(base_url="http://localhost:8080/v1", api_key="<helm-key>")
client.chat.completions.create(model="auto", messages=[...])   # Helm 负责分类与路由
```

要换 lane 背后的模型？改一行 YAML，或在面板里点一下。应用毫无感知。

<div align="center">

[![Helm 管理面板 —— 实时流量、按模型的 token 用量、花费与最近的路由决策](docs/assets/screenshots/01-dashboard.png)](docs/assets/screenshots/01-dashboard.png)

<sub>管理面板 —— 实时流量、按模型的 token 用量、花费，以及最近的路由决策。</sub>

</div>

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
| 🔀 | **多协议文本路由** | OpenAI Chat、Anthropic Messages、OpenAI Responses、Google Gemini——流式和非流式都支持。文本请求共用同一个路由内核；当入站协议和上游协议一致时，还会优先走原生直通，减少协议损耗。 |
| 🖼️ | **图片生成也能兜底** | OpenAI Images（`/v1/images/generations`）、Gemini 图片模型的 `generateContent`、Gemini Interactions（`/v1beta/interactions`）。图片请求可以写具体图片模型，也可以写图片 lane，不走文本分类，但能像文本 lane 一样跨 provider 兜底。 |
| 🧭 | **三层分类** | 确定性规则（纯函数、零网络、有单测——常驻开启）→ 可选的小模型 eval（`temperature: 0`、带缓存、默认关闭——需要先配好 eval 模型）→ `balanced` lane 作为 fail-open 兜底口。 |
| 🛣️ | **Lane + 策略路由** | 请求走 lane（`economy`、`balanced`、`premium`，外加 `coding`、`json`、`vision`、`tool_use` 等任务 lane），从不直接面对供应商名。首条命中的策略可以强制 lane、在配置里限制可用 lane，或覆盖 reasoning effort。每条 lane = 一个主模型 + 一条有序兜底链。可选的 Agentic Signals 可以在不破坏显式钉选和 key 限制的前提下，把状态差的档位提升到更健康的档位。 |
| 🪪 | **固定模型的客户端也能即插即用** | 客户端写死的厂商模型 id（Claude Code 的 `claude-opus-4-8`、锁定 `gpt-5.5` 的 SDK）照样能用——不再吃 *400 unknown model*。**标准 key** 把它当 `auto` 分类；**自定义模型 key** 可通过 `model-aliases.yaml` 把每个厂商家族映射到一条 lane（受 lane 白名单收口）。 |
| 🛡️ | **稳健的执行层** | 熔断器（OPEN/HALF_OPEN + 单探针）、能力过滤（跳过候选时记下明确原因）、`:free` 档 429 跳过、按 key 并发排队。客户端断连永远不算供应商故障。 |
| 🔐 | **OAuth 订阅** | 把 Claude Pro/Max、ChatGPT Codex、GitHub Copilot 的**订阅**当后端来路由——多账号组池，逐账号做模型策展 / 出口代理 / 调度，全局账号使用策略、实时额度窗口，以及受保护的 Codex reset-credit 恢复。*（可选功能，先读 [ToS 警告](#oauth-订阅类供应商claude-promaxchatgpt-codexgithub-copilot)。）* |
| 🔑 | **带约束力的 key** | 强制鉴权；key 鉴权走 SHA-256 哈希，可额外保存加密恢复材料供管理后台查看/轮转。每把 key 可设：lane 白名单、自定义模型权限、RPM/TPM 限流、用量预算（降级或拒绝）、并发上限、记忆模式。可原地轮转，先软吊销，再永久删除。 |
| 🧠 | **Memory 中间件** | 默认开启：路由前把记忆作为一轮追加消息注入上下文；后台 worker 负责压缩与归并——压缩**全自动、零配置**（价格与上下文窗口取自模型目录；按体量 / 空闲 / 上下文压力三种时机触发）。摘要与归并默认走确定性的本地逻辑，另有**可选的 LLM 路径**（`config.memory.llm`，默认关闭）；遗忘/分层机制（衰减、强化、保留期）防止记忆膨胀。可按 key 或按请求关闭（`x-memory-mode: off`）。 |
| 📊 | **全程可观测** | 每个请求一条脱敏决策记录——分类、策略、lane、每次供应商尝试、延迟、兜底、成本。正文逐字捕获单独存表（默认开，保留 30 天）。正文检查器支持长字段全屏阅读、内联图片预览，可编辑的 **Retry** 按钮能按原协议重放任何已捕获的请求。 |
| 🖥️ | **管理面板** | 启用 admin 后，`/admin` 上会提供一个 HTTP Basic 保护的 SvelteKit SPA：概览、请求调试、key 增删改、lane / 策略 / 分类器编辑器、OAuth 提供商、记忆、系统设置。Lane / 策略 / 分类器会写回 YAML 并实时重绑；key、设置、provider、memory 则通过各自的 store/API 持久化。支持 5 种语言。 |
| 💾 | **存储** | 默认 SQLite（一个本地文件）。Postgres / Supabase 走同一套 Store 端口抽象——改一个环境变量即可切换。 |

**路线图：** 账户 / 客户级计费明确不在范围内。详见 [09 路线图](docs/09-roadmap.md)。

## 面板里都有什么

启用 admin 后，网关会在 `/admin` 提供一个 SvelteKit 控制台（HTTP Basic，5 种语言）。这里的操作都是实时生效：路由规则下一个请求就重绑，运行时设置无需重启，provider 账号池会立即重建，key 的启停和限制也会马上生效。

**每一个请求，都讲得清。** 点开任意请求，跟着完整链路走一遍：哪一层做的分类、命中了哪条策略、这条 lane 的完整候选链、实际尝试了哪些供应商，以及细到缓存 token 的成本拆分。

[![请求链路 —— 分类裁决、lane 候选链、供应商尝试与成本拆分](docs/assets/screenshots/03-request-trail.png)](docs/assets/screenshots/03-request-trail.png)

**一个为调试而生的正文检查器。** 开启逐字捕获后，同一页还会加载完整的请求 / 响应正文，以可折叠的树形（也可切「格式化」或「原始」）呈现：

- **再长的内容，一眼看全。** 把任意超长字段——庞大的 system prompt、工具 schema、跨会话续传的摘要——弹成全屏、可一键复制的阅读窗，不必在换行挤压的小格子里翻找。
- **多媒体直接看。** 页面顶部有一块媒体总览，把每张**发送**（请求）和**生成**（响应）的图片汇集成可点击的缩略图——无需在 JSON 树里翻找；内联的 base64 或远程图片仍会就地渲染，支持缩放、适应窗口、在新标签页打开。
- **改完即重放。** 点 **重试**、编辑正文，按它原本的协议（OpenAI Chat / Anthropic / Responses / Gemini）作为一次隔离、全新追踪的调试调用重新发出。

**把订阅组成池。** 把 Claude Pro/Max、ChatGPT Codex、GitHub Copilot 的登录当后端来路由——同一供应商接多个账号，每个账号各有模型策展、出口代理、优先级、实时配额、reset-credit 控制，以及一套全局账号使用策略。

[![订阅类供应商 —— 组池的 OAuth 账号，逐账号配额 / 代理 / 调度 / 状态](docs/assets/screenshots/06-providers.png)](docs/assets/screenshots/06-providers.png)

**路由就是配置。** 每条 lane 就是「一个主模型 + 一条有序兜底链」——可以在界面或 YAML 里重排、替换；策略和 key 限制负责把客户端约束在允许的 lane 内。

[![Lane 编辑器 —— 每条 lane 的主模型与有序兜底链](docs/assets/screenshots/04-lanes.png)](docs/assets/screenshots/04-lanes.png)

<details>
<summary><b>查看全部管理界面</b> —— 共 10 张截图（点击展开）</summary>

<br>

| | |
|:--:|:--:|
| [<img src="docs/assets/screenshots/01-dashboard.png" width="420">](docs/assets/screenshots/01-dashboard.png)<br>**仪表板** —— 流量、花费、token 用量、最近决策 | [<img src="docs/assets/screenshots/02-requests.png" width="420">](docs/assets/screenshots/02-requests.png)<br>**请求** —— 可筛选的请求日志 |
| [<img src="docs/assets/screenshots/03-request-trail.png" width="420">](docs/assets/screenshots/03-request-trail.png)<br>**请求链路** —— 单个请求的完整决策链 | [<img src="docs/assets/screenshots/04-lanes.png" width="420">](docs/assets/screenshots/04-lanes.png)<br>**Lane** —— 每条 lane 的主模型 + 有序兜底链 |
| [<img src="docs/assets/screenshots/05-classifier.png" width="420">](docs/assets/screenshots/05-classifier.png)<br>**分类器** —— eval 开关、置信阈值、规则权重 | [<img src="docs/assets/screenshots/06-providers.png" width="420">](docs/assets/screenshots/06-providers.png)<br>**提供商** —— 组池的 OAuth 订阅账号 |
| [<img src="docs/assets/screenshots/07-memory.png" width="420">](docs/assets/screenshots/07-memory.png)<br>**记忆** —— 按 scope 或 key 浏览事实与反思 | [<img src="docs/assets/screenshots/08-policies.png" width="420">](docs/assets/screenshots/08-policies.png)<br>**策略** —— 首条命中，强制 lane 或 reasoning effort |
| [<img src="docs/assets/screenshots/09-keys.png" width="420">](docs/assets/screenshots/09-keys.png)<br>**API 密钥** —— 逐 key 的上限、限流、预算、记忆模式 | [<img src="docs/assets/screenshots/10-settings.png" width="420">](docs/assets/screenshots/10-settings.png)<br>**系统设置** —— 正文捕获、限流、排队、数据库维护 |

每个界面的逐项说明见 **[11 管理界面](docs/11-admin-ui.md)**。

</details>

## 两套失败纪律

整个设计都挂在这条规则上：

- **配置与凭证 fail-closed。** YAML 非法、缺必填 key、存储驱动未知——网关直接拒绝启动，绝不带病运行。
- **请求路径 fail-open。** 分类、eval、记忆、缓存——任何可选环节出岔子，都悄悄降级到 `balanced` lane 并记入日志。只有链上**所有**供应商都真的挂了，客户端才会拿到一个结构化错误。

还有两套绝不混淆的兜底：*分类兜底*（拿不准 → `balanced` lane）和*执行兜底*（供应商失败 → 链内下一个模型）。机制分开、决策记录字段分开——永远分得清是哪一个触发了。

## 架构

文本协议、图片端点和可选的记忆工具都进入同一个受治理的网关；一个不依赖框架的内核负责路由；配置驱动每一个阶段。（想看同一条流水线的时序图、流程图与状态图，见 **[架构与数据流](docs/architecture.md)**。）

```text
CLIENT ── OpenAI · Anthropic · OpenAI Responses · Google Gemini · Images
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
             ├─ resolve     别名垫片 · 显式模型 · 首条命中策略
             │                  └─▶ lane → 限额（+ 信号）→ 兜底链
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
├─ config/       # 默认 lanes / policies / classifier / providers / model-aliases / … YAML
├─ docs/         # 文档（从 docs/README.md 开始读）
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
| `POST /v1beta/models/{model}:generateContent` | Google Gemini | ✅（走 `:streamGenerateContent`；用 `x-goog-api-key` 鉴权） |
| `POST /v1/images/generations` | OpenAI Images API（[图片生成](#图片生成)） | —（图片模型/lane，任意 key 可用） |
| `POST /v1beta/interactions` | Gemini Interactions API（[图片生成](#图片生成)） | —（图片模型/lane，任意 key 可用） |

**`model` 字段填什么：**

| 取值 | Helm 的行为 |
|---|---|
| `auto`（推荐） | 对请求做分类，路由到最合适的 lane。 |
| 标准 key 传任何 model/lane | 仍按 `auto` 做分类路由（绝不 400）——model 字段**不决定走哪条 lane**。但如果你写的这个模型恰好在选中 lane 的候选链里，Helm 会**优先服务它**。 |
| 写死的厂商 id，如 `claude-opus-4-8`——**自定义模型 key** | 兼容垫片把它映射到一条 lane（`config/model-aliases.yaml`），并受 key 的 lane 白名单收口。 |
| lane 名（`premium`）或具体别名（`deepseek/deepseek-v4-pro`）——**自定义模型 key** | 直接进入该 lane / 模型，跳过分类。 |

> 标准 key 永远只需 `auto`。model 字段不会改变选中的 lane——但当你写的模型已经在那条 lane 的候选链里时，Helm 会把它提到链首（于是 Claude Code 钉 `claude-sonnet-4-6` 拿到的就是 Sonnet，而非该 lane 的 primary；失败再沿链回退）。要钉某条 lane、某个厂商家族或链外的具体模型，需要**自定义模型** key（`allow_custom_model`）。Lane 由运维方配置（`lanes.yaml` + 面板）。

### 图片生成

图片请求可以写具体图片模型，也可以写图片 **lane**（见下方[跨 provider 故障转移](#图片跨-provider-故障转移)），不经文本分类，且**任意有效 key 都能用**（无需 `allow_custom_model`；成本由该 key 的预算 / 限流约束）。可配置的模型：`gpt-image-2`（OpenAI）、`gemini-3.1-flash-image` / `gemini-3-pro-image`（Google「Nano Banana」）。每次调用按图片计量（output tokens × 该模型的图片费率），并和其他请求一样进入面板。三个入口——按你的 SDK 说哪种协议来选：

**1. OpenAI Images API** —— `POST /v1/images/generations`（Bearer 鉴权），响应 `{ "created", "data": [{ "b64_json" }], "usage" }`：

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer $HELM_KEY" -H "Content-Type: application/json" \
  -d '{ "model": "gpt-image-2", "prompt": "纯白背景上的一颗红苹果", "size": "1024x1024" }'
```

**2. Gemini `generateContent`** —— Gemini SDK 的 `generate_content` 路径。写一个图片模型并要求图片输出；Helm 原生路由，响应携带 `candidates[].content.parts[].inlineData`：

```bash
curl "http://localhost:8080/v1beta/models/gemini-3.1-flash-image:generateContent" \
  -H "x-goog-api-key: $HELM_KEY" -H "Content-Type: application/json" \
  -d '{ "contents": [{ "parts": [{ "text": "纯白背景上的一颗红苹果" }] }],
        "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] } }'
```

**3. Gemini Interactions API** —— `POST /v1beta/interactions`（SDK 的 `client.interactions.create`）。响应是 `steps[]` 形状，图片在 `steps[].content[]`（`{ "type": "image", "data": … }`）；SDK 的 `interaction.output_image.data` 即从此读取：

```bash
curl http://localhost:8080/v1beta/interactions \
  -H "x-goog-api-key: $HELM_KEY" -H "Content-Type: application/json" \
  -d '{ "model": "gemini-3.1-flash-image", "input": "纯白背景上的一颗红苹果",
        "response_format": { "type": "image", "aspect_ratio": "1:1" } }'
```

> OpenAI Images 端点同时服务 OpenAI 和 Gemini 图片模型（Helm 把 Gemini 与 `generateContent` 双向互译）；两个 Gemini 原生入口只服务 Gemini 图片模型。在 `/v1beta/interactions` 上发 `gpt-image-2` 会返回 400 → 请改用 `/v1/images/generations`。

#### 图片跨 provider 故障转移

同一个图片模型常常有多个 provider 可选（官方直连、ZenMux、OpenRouter……）。内置配置已经把它们组成了图片 **lane**——把 **lane 名**当作 `model` 来请求，Helm 先打 primary，遇到 provider 故障（超时、5xx、熔断打开）就自动 fallback 到下一个，用的是和聊天路由**同一套熔断器**。而确定性的客户端错误（4xx invalid request，比如尺寸非法、图片过大）会原样返回，**不**触发 fallback。

```yaml
# config/lanes.yaml —— 内置的两条图片 lane 以官方上游为 primary，再回退到 ZenMux 中转。
# 成员必须是图片模型（capabilities.outputImage）且类型单一（要么全 gpt-image-*，要么全 gemini-*-image）。
gpt-image:                          # 请求填 `model: "gpt-image"`
  primary: openai/gpt-image-2       # OpenAI 官方 → ZenMux 中转
  fallback: [gpt-image-2]
gemini-image:                       # 请求填 `model: "gemini-image"`
  primary: google/gemini-3.1-flash-image   # Google 官方 → ZenMux flash → pro
  fallback: [gemini-3.1-flash-image, gemini-3-pro-image]
```

图片 lane 在两个专用端点（`/v1/images/generations`、`/v1beta/interactions`）上对**任意 key** 都生效。在 Gemini `:generateContent` 路径上按名字选 lane 遵循普通 lane 规则——需要 `allow_custom_model` key——所以想覆盖面最广，就让图片 SDK 指向这两个专用端点。

**其余端点**（交互式文档在 `/docs`，原始规格在 `/openapi.json`）：

| 端点 | 鉴权 | 用途 |
|---|---|---|
| `GET /` · `GET /healthz` · `GET /version` | — | 落地页 · 就绪探针 · 构建信息 |
| `GET /v1/models` · `GET /v1/models/{id}` | API key | 列出该 key 能路由到的模型（lane + `auto`；自定义模型 key 还会看到带能力与定价的具体别名） |
| `GET /v1/usage/stats` | API key | 查询当前 key 在指定时间窗口内的用量聚合 |
| `POST /v1/messages/count_tokens` | API key | Anthropic 形状的 token 计数辅助接口 |
| `/v1/responses/*` 生命周期辅助接口 | API key | `input_tokens`、`compact`、retrieve/delete/cancel/input-items，供 Responses 兼容客户端使用 |
| `POST /mcp` + OAuth discovery | API key 或可选 MCP OAuth | 开启 `memory.mcp.enabled` 后暴露的 Memory MCP 工具 |
| `/admin` · `/admin/api/*` | Basic auth | 面板 + 其 JSON 后端（仅在启用面板时才挂载） |

## 配置

启动配置都在 `config/*.yaml` 里，加载时经 Zod 校验。**非法配置直接让网关无法启动。** Lane、策略和分类器可以在面板里实时编辑，并写回 YAML 文件（注释原样保留、原子写入）。运行时设置、key、OAuth 账号、memory、请求正文等则走各自的 store/API，同样无需重启即可生效。

| 文件 | 控制什么 | 可实时改 |
|---|---|---|
| `server.yaml` | 主机 / 端口 / base path | — |
| `auth.yaml` | 是否强制 API key + 首次启动的 root key | — |
| `runtime.yaml` | 请求限额、限流默认值、存储驱动、可选信号反馈 | 部分 |
| `providers.yaml` | 上游供应商 + 模型别名（凭证只引用环境变量**名**） | — |
| `lanes.yaml` | 每条 lane 的主模型 + 兜底链（质量 lane、任务 lane、厂商家族 lane） | ✅ 持久化 |
| `policies.yaml` | 首条命中，用来强制 lane、限制可用 lane 或强制 reasoning effort 的规则 | ✅ 持久化 |
| `classifier.yaml` | 内置规则 + 可选的 eval 模型 | ✅ 持久化 |
| `model-aliases.yaml` | 把写死的厂商模型 id 映射到 lane / `auto`（兼容垫片，可选） | — |
| `memory.yaml` | 遗忘/分层旋钮（出厂配置即开启）· 可选的压缩触发覆盖（`compaction:`）· 可选的 LLM 摘要器（`llm:`，默认关闭）。旧版遗留的 `observer:` 配置块会导致启动失败 | 部分 |
| `capabilities.yaml` / `pricing.yaml` | 对模型目录的手动覆盖项（含 prompt 缓存读/写价格） | — |

最常用的环境变量（env 优先于 YAML；完整列表见 [`.env.example`](.env.example)）：

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | 主供应商凭证（**必填**） |
| `ZENMUX_API_KEY`、`OPENROUTER_API_KEY` | 可选供应商凭证（缺失则跳过该供应商） |
| `OPENAI_API_KEY`、`GEMINI_API_KEY` | 可选——官方 OpenAI / Google **图片**供应商；内置的 `gpt-image` / `gemini-image` lane 以它们为 primary，再回退到 ZenMux |
| `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` | 面板登录（Basic auth） |
| `HELM_HOST` / `HELM_PORT` | 服务绑定（默认 `0.0.0.0:8080`） |
| `HELM_STORE_DRIVER` | `sqlite`（默认）或 `supabase` |
| `HELM_STORE_URL_ENV` | 用 `supabase` 时：存放 Postgres DSN 的环境变量**名** |
| `HELM_RATE_LIMIT_ENABLED` | 打开限流（默认关闭） |
| `HELM_OAUTH_ENC_KEY` | 加密可恢复 API key 与 OAuth token 的 32 字节密钥（配了订阅类供应商时**必填**；管理后台后续查看完整 API key 也需要它） |

> **存储。** 默认 SQLite（`better-sqlite3`，`./data` 下的 `helm.db` 文件）。要用 Postgres/Supabase：`HELM_STORE_DRIVER=supabase`，再让 `HELM_STORE_URL_ENV` 指向存放 DSN 的环境变量。未知驱动在启动时 fail-closed。
>
> **凭证。** 供应商 key 在 `providers.yaml` 里只按环境变量*名*引用——明文绝不进仓库、不进镜像。

### OAuth 订阅类供应商（Claude Pro/Max、ChatGPT Codex、GitHub Copilot）

供应商除了静态 key，还能用 **OAuth 订阅**鉴权：在面板里登录（**提供商 → 连接**）。Claude Pro/Max 和 ChatGPT Codex 走「粘贴授权码」，GitHub Copilot 走设备码。Helm 把会轮换的 refresh token **加密存盘**，并自动刷新短时的 access token。

先设 **`HELM_OAUTH_ENC_KEY`**（32 字节：base64 或 64 位十六进制）——配置了订阅类供应商却没设这把密钥，Helm 拒绝启动。同一把密钥也用于加密管理后台查看/轮转 API key 所需的恢复材料。然后给供应商加一个 `oauth: { provider: anthropic | github-copilot | openai-codex }` 块（`config/providers.yaml` 里有注释掉的示例；Claude 用 `type: anthropic`）。

同一供应商可以**接入多个账号**组成池。每个账号（**提供商 → 管理**）各有：

- **模型** —— 一份实时白名单，不是显示层过滤：移除的模型立刻停止路由，未策展的模型直接被拒（fail-closed）。
- **代理** —— 按账号设 HTTP/HTTPS/SOCKS5 出口，整条订阅链路都走它，让同机的多个账号从不同 IP 出去。
- **调度** —— `priority`（越小越优先）+ `schedulable` 开关；「停泊」一个账号即保持连接但退出轮换。

账号池还有一个**全局使用策略**，在每个订阅 provider 的账号池内部生效：

- `balanced` —— 新会话尽量均摊，同时保持会话粘性。
- `manual_priority` —— 严格优先按账号 priority，用同一优先级内的轮换。
- `low_risk` —— 在最高优先级层里优先选额度压力更低的账号，降低 429 风险。
- `use_expiring` —— 优先使用短窗口或周窗口里快要重置、仍有余量的账号，并把 Codex reset credits 作为打折后的可恢复容量纳入评分。

额度只是软评分信号：额度缺失或过期时会回到 balanced 行为；手动停泊和硬 cooldown 仍会把账号排除在调度外。Codex reset credits **不会因为选择策略被自动消费**，只会在明确点击 **Reset limit** 或开启受保护的 auto-reset 后消费，并且必须满足 weekly quota 已足够饱和的门槛。

这里的一切都热重载——连接、断开、策展、代理、调度——下一个请求即生效，无需重启。Helm 还会照搬官方客户端的身份头，并发送**稳定的按账号设备标识**（绝不中途轮换），以降低被关联封号的风险。

> ⚠️ **服务条款。** 把 Claude/ChatGPT/Copilot 的**订阅**通过第三方网关路由，可能违反供应商 ToS，并可能导致账号被封。这是面向自托管、个人使用的可选功能——**合规责任在你自己**。拿不准时，用普通 API key（`api_key_env`）。

## 开发

需要 **Node ≥ 22** 和 **pnpm 10**。

```bash
pnpm install
pnpm dev          # 管理面板开发服务器（Vite）—— 见下方说明
pnpm test         # Vitest 单元测试
pnpm exec vitest run --coverage # 单元测试覆盖率（只统计源码，并带阈值）
pnpm test:e2e     # Playwright 端到端测试
pnpm typecheck    # 全仓库 tsc --noEmit
pnpm lint         # Biome
pnpm build        # 构建网关 + 面板
pnpm sync:catalog # 刷新生成的模型目录（能力 + 定价）
```

> `pnpm dev` 只起 admin SPA。网关没有 watch 脚本——构建后运行（`pnpm build` 再 `node apps/gateway/dist/index.js`），或用 Docker。
>
> 规格文档目前仅有英文版。

测试先行：core 用 Vitest，完整链路用 Playwright。设计决策记录在 [`implementation-notes.md`](implementation-notes.md)。开 PR 前：

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
```

## 文档

从 [`docs/README.md`](docs/README.md) 开始。想先看流水线全貌，读 **[架构与数据流](docs/architecture.md)**。编号规格按顺序读：

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
[13 记忆管理与 MCP](docs/13-memory-admin-and-mcp.md) ·
[14 记忆深度召回](docs/14-memory-deep-recall.md) ·
[协议兼容性](docs/protocol-compatibility.md)

## 项目状态

Helm API 是一套端到端的真实实现，不是空架子。完整链路（配置 → 鉴权 → 分类 → 路由 → 执行（含熔断与兜底）→ 协议互译 → 遥测 → 记忆）已全部打通，背后是一套相当完整的 Vitest 单测加 Playwright e2e 用例。上方的版本徽章会跟踪当前发布版本。

## 许可

[MIT](LICENSE) © 2026 EasyMeta AU
