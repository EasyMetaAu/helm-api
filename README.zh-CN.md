<div align="center">

<img src="docs/assets/logo.svg" width="84" height="84" alt="Helm logo">

# Helm API

[English](README.md) · **简体中文**

### 文本、图片、订阅账号、故障兜底与记忆，一套配置统一管理。

开源 · 自托管 · MIT

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/package-json/v/EasyMetaAu/helm-api)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![Built with Hono](https://img.shields.io/badge/gateway-Hono-ff5e00.svg)](https://hono.dev)
[![Admin: SvelteKit](https://img.shields.io/badge/admin-SvelteKit-ff3e00.svg)](https://kit.svelte.dev)

</div>

LLM 应用一旦接入多个供应商，路由逻辑很容易散落到各处：客户端内置一套兜底列表，为供应商差异打一个临时补丁，再写死几个模型名和成本限制。等到请求走错地方，却连「为什么选了这个模型」都很难说清楚。

Helm API 用一个开源、自托管的 **LLM 路由网关**统一承接这些工作——可以把它理解为 *LLM 世界的 nginx*。应用仍按 OpenAI、Anthropic、Gemini 或图片生成协议发请求；Helm 在中间完成分类、选择 lane、调度供应商账号、上游故障切换和必要的协议互译，同时记录完整的决策链路。大多数客户端只需更换 `base_url` 和 API key。

> **用配置管理流量，不把路由写死在代码里。**

```python
# 应用代码仍使用原来的 OpenAI 客户端，只需更换 base_url 和 key。
client = OpenAI(base_url="http://localhost:8080/v1", api_key="<helm-key>")
client.chat.completions.create(model="auto", messages=[...])   # Helm 负责分类与路由
```

需要更换某条 lane 使用的模型时，改一行 YAML，或在管理面板里调整即可；应用端无需改动。

<div align="center">

[![Helm 管理面板 —— 实时流量、按模型的 token 用量、花费与最近的路由决策](docs/assets/screenshots/01-dashboard.png)](docs/assets/screenshots/01-dashboard.png)

<sub>管理面板 —— 实时流量、按模型的 token 用量、花费，以及最近的路由决策。</sub>

</div>

> **截图说明：** 以下管理面板截图拍摄于 2026-07-05，对应 v0.25.2，仅用于展示当时的界面布局。本文文字已经按当前源码更新；截图里的字段名、统计窗口和版本号可能与现状不同。完整来源说明见 [11 管理界面](docs/11-admin-ui.md)。

## 快速上手

**前置条件：** [Docker](https://docs.docker.com/get-docker/)；或 **Node ≥ 22** + **pnpm 10** 从源码构建。

```bash
# 克隆仓库，启动 Docker，然后在浏览器完成初始化
git clone https://github.com/EasyMetaAu/helm-api.git && cd helm-api
./scripts/quickstart.sh
```

脚本会打印完整的 `/setup#token=...` 地址；保护令牌只留在浏览器 URL fragment
中，页面会自动读取，无需理解或手工粘贴。向导第一步直接设置管理账号，
随后可填写并测试可选的 Provider API key；也可以一把静态 key 都不填，
先完成初始化，
再到 **管理面板 → Providers** 连接 ChatGPT/Codex、Claude、Copilot 或 Grok
订阅。完成页会一次性显示自动创建的管理员 API Token，并给出 Claude Code、
Codex 和 SDK 的可复制接入配置；整个过程无需手动重启服务。

默认脚本只会在私有 `.env` 中保存端口和 Linux UID/GID。向导填写的凭据
保存在数据卷内的 `data/helm-managed-env.json`，权限为 `0600`；已有 `.env`
不会被覆盖。需要纯命令行或自动化安装时，可运行
`./scripts/quickstart.sh --cli`，也可以预先设置 `HELM_ADMIN_*` 与 Provider 环境变量。

| 入口 | 地址 |
|---|---|
| 网关 | 默认 `http://localhost:8080`（`/` 是状态落地页） |
| 首次初始化 | 初始化完成前使用 `http://localhost:8080/setup` |
| 管理面板 | 默认 `http://localhost:8080/admin`，使用向导中设置的账号密码 |
| API Key 自助门户 | 默认 `http://localhost:8080/portal`，使用 Helm API key 登录 |
| API 文档 | `GET /docs`（Swagger UI）· `GET /openapi.json`（OpenAPI 3.1，与网关校验所用为同一套 Zod schema） |
| 健康 / 版本 | `GET /healthz` · `GET /version` |

`docker-compose.yml` 会挂载 `./config` 和 `./data`，因此重启容器不会丢失
配置或数据库；它也会把 `.env` 注入容器，无需再为可选 provider 或运行时
覆盖修改 Compose。`HELM_PORT` 会统一控制宿主机端口、Gateway 监听端口和健康检查。

手动使用 Compose 时，Linux 用户应先创建 `./data`，并把 `HELM_UID`、
`HELM_GID` 设为 `id -u`、`id -g` 的输出，再执行
`docker compose up -d --wait`；`.env` 和静态 Provider key 都不是首次启动的
必需项。尚未接入任何 Provider 时，健康检查和管理面板仍可用，推理请求会
明确返回 `503 lane_unavailable` 并提示完成 Provider 配置。

## 你能得到什么

|  | 功能 | 说明 |
| :---: | :--- | :--- |
| 🔀 | **多协议文本路由** | 同时接收 OpenAI Chat、Anthropic Messages、OpenAI Responses 和 Google Gemini，流式与非流式请求都能处理。所有文本请求共用同一个路由内核；如果客户端协议与选定上游一致，Helm 会优先原样转发，尽量避免协议转换带来的信息损失。 |
| 🖼️ | **图片生成故障切换** | 支持 OpenAI Images（`/v1/images/generations`）、Gemini 图片模型的 `generateContent` 和 Gemini Interactions（`/v1beta/interactions`）。请求可指定具体图片模型，也可指定图片 lane；无需经过文本分类，仍能在多个 provider 之间自动切换。 |
| 🧭 | **三层分类** | 第一层是始终启用的确定性规则，采用纯函数实现，不访问网络，并有单元测试；第二层是可选的小模型 eval，固定 `temperature: 0`、带缓存、默认关闭，启用前必须配置 eval 模型；仍无法判断时，按 fail-open 原则进入 `runtime.default_lane`，出厂值为 `balanced`。 |
| 🛣️ | **Lane 与策略路由** | 请求只接触 lane，不直接暴露供应商名。既有 `economy`、`balanced`、`premium` 等质量 lane，也有 `coding`、`json`、`vision`、`tool_use` 等任务 lane。策略按顺序匹配，第一条命中项可以指定 lane、限制配置中允许使用的 lane，或覆盖 reasoning effort。每条 lane 由一个主模型和一条有序兜底链组成。可选的 Agentic Signals 会在 `economy` 或 `balanced` 健康指标下降时，将其提升到整体成功率更高的更强 lane，但不会越过显式指定项或 key 权限上限。 |
| 🪪 | **兼容写死模型名的客户端** | 即使 Claude Code 写死 `claude-opus-4-8`，或某个 SDK 固定使用 `gpt-5.5`，也不会再遇到 *400 unknown model*。对**标准 key**，Helm 会按 `auto` 处理并重新分类；对**自定义模型 key**，可在 `model-aliases.yaml` 中把各供应商的模型家族映射到 lane，最终仍受该 key 的 lane 白名单限制。 |
| 🛡️ | **可靠的执行层** | 内置 OPEN/HALF_OPEN 熔断器和单探针机制；能力过滤会记录每个候选被跳过的具体原因；`:free` 档遇到 429 会继续尝试其他候选；并发请求按 key 排队。客户端主动断开连接不会被记作供应商故障。 |
| 🔐 | **OAuth 订阅账号池** | Claude Pro/Max、ChatGPT Codex、GitHub Copilot，以及实验性的 xAI/SuperGrok 订阅都可作为上游。Helm 支持同一供应商接入多个账号，并分别管理可用模型、出口代理和调度；账号池还提供全局使用策略、实时额度窗口，以及受保护的 Codex reset-credit 恢复机制。*（此功能需主动启用；使用前请阅读 [ToS 警告](#oauth-订阅类供应商claude-promaxchatgpt-codexgithub-copilot)。）* |
| 🔑 | **可精细约束的 API Key** | 所有请求必须鉴权，API key 仅以 SHA-256 哈希参与验证；如需在管理面板中查看或轮转，可额外保存加密后的恢复材料。每把 key 都能独立设置名称、lane 白名单、自定义模型/禁用模型/Fast 模型权限、RPM/TPM 限流、用量预算（降级或拒绝）、并发上限和 Memory 默认值。支持原地轮转、软吊销和永久删除。 |
| 🧠 | **Memory 中间件** | Memory 需按 key 主动开启，可选 `observe` 或 `inject`，新 key 默认为 `off`。启用后，Helm 会在路由前把相关记忆追加为末尾消息，并由后台 worker 自动压缩、归并；压缩策略会随内容自动调整。摘要默认采用确定性的本地实现，也可改用 LLM。遗忘/分层和 MCP `memory_recall` 均受配置开关控制，混合召回不会在每轮请求中自动注入。请求显式携带的 `x-memory-*` 头优先于 key 默认值。 |
| 📊 | **完整的可观测链路** | 每个请求都会留下脱敏的决策记录，包括分类结果、命中策略、lane、历次供应商尝试、延迟、兜底和成本。完整请求/响应正文单独存表，默认开启并保留 30 天。正文查看器可全屏阅读长字段、预览内联图片；还可编辑正文后点击 **Retry**，按原协议重新发起已捕获的请求。 |
| 🖥️ | **管理面板** | 启用 admin 后，`/admin` 会提供一个受 HTTP Basic 保护的 SvelteKit SPA，涵盖总览、请求调试、key 管理、lane / 策略 / 分类器编辑、OAuth provider、Memory 和系统设置。Lane、策略与分类器会写回 YAML 并立即重新绑定；key、设置、provider 和 Memory 则通过各自的 store/API 持久化。界面支持 7 种语言。 |
| 👤 | **API Key 自助门户** | `/portal` 直接使用持有者的 key 鉴权，只展示该 key 自己的用量与预算、接入指南、所属请求及正文，以及限定作用域内的 Memory 管理。每个 trace 都先校验归属关系，响应也只返回白名单字段，因此不会泄露其他 key、provider 拓扑或 eval 内部信息。界面支持 7 种语言。 |
| 💾 | **存储** | 默认使用单文件 SQLite。Postgres / Supabase 实现同一套 Store 端口；只需修改一个环境变量即可切换。 |

**路线图：** 账户 / 客户级计费明确不在范围内。详见 [09 路线图](docs/09-roadmap.md)。

## 管理面板一览

启用 admin 后，网关会在 `/admin` 提供一个受 HTTP Basic 保护、支持 7 种语言的 SvelteKit 控制台。面板中的变更会直接作用于运行中的网关：路由规则从下一个请求开始重新绑定，运行时设置无需重启，provider 账号池会为下一个请求重建，key 的启停与权限限制也会立即生效。

**每一个请求都有据可查。** 打开任意请求，即可看到完整决策过程：由哪一层完成分类、命中了哪条策略、该 lane 有哪些候选、实际尝试过哪些供应商，以及细分到缓存 token 的成本。

[![请求链路 —— 分类裁决、lane 候选链、供应商尝试与成本拆分](docs/assets/screenshots/03-request-trail.png)](docs/assets/screenshots/03-request-trail.png)

**为调试准备的正文查看器。** 开启完整正文捕获后，同一页面会加载请求和响应的全部内容。默认以可折叠树形展示，也可切换到「格式化」或「原始」视图：

- **长内容也容易读。** system prompt、工具 schema、跨会话续传摘要等超长字段，可在全屏窗口中查看并一键复制，不必挤在自动换行的小单元格里滚动。
- **图片集中预览。** 页面顶部会汇总请求中**发送**的图片和响应中**生成**的图片，以可点击缩略图展示，无需逐层翻查 JSON。内联 base64 与远程图片也会原位渲染，并支持缩放、适应窗口和在新标签页打开。
- **编辑后直接重放。** 点击 **Retry**，修改正文后即可按原协议（OpenAI Chat / Anthropic / Responses / Gemini）重新发送；这次调试调用彼此隔离，并会生成新的追踪记录。

**统一调度订阅账号。** Claude Pro/Max、ChatGPT Codex 和 GitHub Copilot 的登录账号都可作为上游。同一供应商能接入多个账号；每个账号分别配置可用模型、出口代理、优先级、实时配额和 reset-credit，账号池再统一应用一套使用策略。

[![订阅类供应商 —— OAuth 账号池，以及各账号的配额、代理、调度与状态](docs/assets/screenshots/06-providers.png)](docs/assets/screenshots/06-providers.png)

**路由规则都在配置里。** 每条 lane 都由一个主模型和一条有序兜底链组成，可在面板或 YAML 中调整顺序、替换模型；策略与 key 权限共同保证客户端只能进入允许的 lane。

[![Lane 编辑器 —— 每条 lane 的主模型与有序兜底链](docs/assets/screenshots/04-lanes.png)](docs/assets/screenshots/04-lanes.png)

<details>
<summary><b>查看全部管理界面</b> —— 共 10 张截图（点击展开）</summary>

<br>

| | |
|:--:|:--:|
| [<img src="docs/assets/screenshots/01-dashboard.png" width="420">](docs/assets/screenshots/01-dashboard.png)<br>**仪表板** —— 流量、花费、token 用量、最近决策 | [<img src="docs/assets/screenshots/02-requests.png" width="420">](docs/assets/screenshots/02-requests.png)<br>**请求** —— 可筛选的请求日志 |
| [<img src="docs/assets/screenshots/03-request-trail.png" width="420">](docs/assets/screenshots/03-request-trail.png)<br>**请求链路** —— 单个请求的完整决策链 | [<img src="docs/assets/screenshots/04-lanes.png" width="420">](docs/assets/screenshots/04-lanes.png)<br>**Lane** —— 每条 lane 的主模型 + 有序兜底链 |
| [<img src="docs/assets/screenshots/05-classifier.png" width="420">](docs/assets/screenshots/05-classifier.png)<br>**分类器** —— eval 开关、置信阈值、规则权重 | [<img src="docs/assets/screenshots/06-providers.png" width="420">](docs/assets/screenshots/06-providers.png)<br>**提供商** —— OAuth 订阅账号池 |
| [<img src="docs/assets/screenshots/07-memory.png" width="420">](docs/assets/screenshots/07-memory.png)<br>**记忆** —— 按 scope 或 key 浏览事实与反思 | [<img src="docs/assets/screenshots/08-policies.png" width="420">](docs/assets/screenshots/08-policies.png)<br>**策略** —— 首条命中，强制 lane 或 reasoning effort |
| [<img src="docs/assets/screenshots/09-keys.png" width="420">](docs/assets/screenshots/09-keys.png)<br>**API 密钥** —— 逐 key 的上限、限流、预算、记忆模式 | [<img src="docs/assets/screenshots/10-settings.png" width="420">](docs/assets/screenshots/10-settings.png)<br>**系统设置** —— 正文捕获、限流、排队、数据库维护 |

每个界面的逐项说明见 **[11 管理界面](docs/11-admin-ui.md)**。

</details>

## 两类失败处理原则

Helm 对失败的处理取决于它发生在哪一条边界：

- **配置和信任边界一律 fail-closed。** YAML 非法、主供应商凭证缺失、存储驱动未知、鉴权失败、触及硬限制或请求本身不合法时，Helm 会明确拒绝，不会擅自放宽权限或臆测路由状态。
- **可选辅助环节只在自身边界内 fail-open。** 分类或 eval 失败时进入配置的默认 lane，出厂值为 `balanced`；Memory 失败时原请求保持不变；信号、配额和缓存则按各自契约降级并记录日志。执行层会依次尝试候选链；遇到确定性的客户端错误，或整条链都不可用时，返回符合客户端协议格式的结构化错误。

另外，*分类兜底*和*执行兜底*是两套独立机制：前者在无法确定分类时进入默认 lane，后者在供应商失败后尝试链内下一个模型。两者使用不同的决策记录字段，因此可以准确判断本次请求触发了哪一种兜底。

## 架构

文本协议、图片端点和可选的 Memory 工具都由同一个网关统一治理。路由工作由不依赖 Web 框架的内核完成，整个处理过程由配置驱动。时序图、流程图和状态图见 **[架构与数据流](docs/architecture.md)**。

```text
CLIENT ── OpenAI · Anthropic · OpenAI Responses · Google Gemini · Images
          一个 base_url + 一把 Helm key · 发 model:"auto"
             │
             ▼
GATEWAY   apps/gateway（Hono）· HTTP 外壳 —— 托管 /admin、/portal、/docs、可选 /mcp
             │   把任意协议归一  ──▶  一个 InternalRequest（IR）
             ▼
CORE      packages/core · 路由大脑（不 import 任何 Web 框架）
             │
             ├─ auth        校验 sha256 key、加载按 key 限额        · fail-closed
             ├─ gate        限流（默认关）· 用量预算（默认关）       · fail-closed
             ├─ memory      按 key 选择 observe / inject              · fail-open
             ├─ classify    L1 规则 ─不确定→ L2 eval（默认关）─→ default_lane · fail-open
             ├─ resolve     alias 兼容层 · 显式模型 · 首条命中策略
             │                  └─▶ lane → 限额（+ 信号）→ 兜底链
             ├─ execute     能力过滤 → 熔断器 → provider
             │                  └── 失败时：切到链内下一个模型
             └─ translate   provider 原生  ⇄  IR  ⇄  客户端协议（流式 SSE）
             │
             ▼
RESULT ── 按客户端自己的协议，流式 / JSON 返回
             │
             ├─▶ telemetry   脱敏决策记录 + 完整正文捕获
             ├─▶ memory      把这一轮写回记忆
             └─▶ upstream    静态 API key + OAuth 订阅（账号池 · 热重载）

config/*.yaml 驱动每一个阶段 · 经 Zod 校验 · 非法配置拒绝启动（fail-closed）
```

内核从契约上保证**脱离界面也能独立运行**：路由、分类、provider 执行、协议互译和存储全部位于 `packages/core`，且不得 import 任何 Web 框架；架构测试会持续检查这条边界。Hono 与 SvelteKit 只是可选的轻量外壳。

```text
helm-api/
├─ apps/
│  ├─ gateway/   # Hono API + 托管面板 + /healthz、/version
│  ├─ admin/     # SvelteKit + Tailwind 运维面板（静态 SPA）
│  └─ portal/    # SvelteKit API Key 自助门户（静态 SPA）
├─ packages/
│  ├─ core/      # 路由、分类、provider、协议互译、存储端口（不依赖框架）
│  └─ shared/    # Zod schema + 共享类型（类型唯一来源）
├─ config/       # 默认 lanes / policies / classifier / providers / model-aliases / … YAML
├─ docs/         # 文档（从 docs/README.md 开始读）
└─ scripts/      # sync:catalog 等构建期工具
```

## 调用网关

任何兼容 OpenAI 的客户端都可以接入。把服务地址改为 Helm，并使用一把 Helm key：

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

**如何填写 `model`：**

| 取值 | Helm 的行为 |
|---|---|
| `auto`（推荐） | 对请求做分类，路由到最合适的 lane。 |
| **标准 key** 传入任意模型或 lane | Helm 通常仍按 `auto` 完成分类和路由，`model` 字段**不会决定 lane**。如果指定模型本就在所选 lane 的候选链中，Helm 会优先尝试它；如果该精确 id 命中这把 key 的 `blocked_models`，则在分类前直接拒绝。 |
| 写死的供应商模型 id，如 `claude-opus-4-8`——**自定义模型 key** | 兼容层会根据 `config/model-aliases.yaml` 将它映射到一条 lane，且不得超出该 key 允许的 lane。 |
| lane 名（`premium`）或具体别名（`deepseek/deepseek-v4-pro`）——**自定义模型 key** | 直接进入该 lane / 模型，跳过分类。 |

> 标准 key 只需要传 `auto`。除 `blocked_models` 这条硬性检查和精确指定图片模型外，`model` 字段不会改变文本请求选中的 lane；如果该模型已经位于候选链中，Helm 只会把它移到链首。若要固定使用某条 lane、某个供应商家族或候选链外的文本模型，必须使用开启 `allow_custom_model` 的**自定义模型 key**。Lane 由运维方通过 `lanes.yaml` 或管理面板配置。

### 图片生成

图片请求既可以指定具体模型，也可以指定图片 **lane**（见下方[图片 Provider Lane](#图片-provider-lane)）。它们不会进入文本分类流程，而且**任意有效 key 都能调用**，无需开启 `allow_custom_model`；费用仍受该 key 的预算和限流约束。运维方可配置 `gpt-image-2`（OpenAI），以及 `gemini-3.1-flash-image` / `gemini-3-pro-image`（Google「Nano Banana」）。每次调用按图片计量，计算方式为 output tokens × 该模型的图片费率，并会像其他请求一样显示在管理面板中。请根据 SDK 使用的协议选择下面三个入口之一：

**1. OpenAI Images API** —— `POST /v1/images/generations`（Bearer 鉴权），响应 `{ "created", "data": [{ "b64_json" }], "usage" }`：

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer $HELM_KEY" -H "Content-Type: application/json" \
  -d '{ "model": "gpt-image-2", "prompt": "纯白背景上的一颗红苹果", "size": "1024x1024" }'
```

**2. Gemini `generateContent`** —— 对应 Gemini SDK 的 `generate_content` 调用。指定图片模型并要求返回图片后，Helm 会按 Gemini 原生协议路由，响应中的图片位于 `candidates[].content.parts[].inlineData`：

```bash
curl "http://localhost:8080/v1beta/models/gemini-3.1-flash-image:generateContent" \
  -H "x-goog-api-key: $HELM_KEY" -H "Content-Type: application/json" \
  -d '{ "contents": [{ "parts": [{ "text": "纯白背景上的一颗红苹果" }] }],
        "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] } }'
```

**3. Gemini Interactions API** —— `POST /v1beta/interactions`，对应 SDK 的 `client.interactions.create`。响应采用 `steps[]` 结构，图片位于 `steps[].content[]`（`{ "type": "image", "data": … }`）；SDK 会从这里读取 `interaction.output_image.data`：

```bash
curl http://localhost:8080/v1beta/interactions \
  -H "x-goog-api-key: $HELM_KEY" -H "Content-Type: application/json" \
  -d '{ "model": "gemini-3.1-flash-image", "input": "纯白背景上的一颗红苹果",
        "response_format": { "type": "image", "aspect_ratio": "1:1" } }'
```

> OpenAI Images 端点可调用 OpenAI 和 Gemini 图片模型，Helm 会在内部与 Gemini `generateContent` 做双向转换；两个 Gemini 原生入口则只接受 Gemini 图片模型。在 `/v1beta/interactions` 请求 `gpt-image-2` 会返回 400，请改用 `/v1/images/generations`。

#### 图片 Provider Lane

内置配置会把图片模型组织成图片 **lane**。GPT 图片 lane 只经过 ZenMux relay，以避开成本更高的 OpenAI 官方 API；但任意有效 key 仍可精确指定官方图片模型 alias，直接调用官方接口。Gemini 图片 lane 保留跨 provider 的故障切换。若请求本身确定无效，例如尺寸不支持或图片过大，Helm 会原样返回对应的 4xx invalid request，**不会**继续尝试其他 provider。

```yaml
# config/lanes.yaml —— GPT 图片只走 ZenMux；Gemini 先走 Google 官方，再回退到 ZenMux。
# 成员必须具备 capabilities.outputImage，且同一 lane 中只能有一种图片模型家族：
# 要么全部为 gpt-image-*，要么全部为 gemini-*-image。
gpt-image:                          # 请求填 `model: "gpt-image"`
  primary: gpt-image-2              # ZenMux relay；因成本排除 OpenAI 官方 API
  fallback: []
gemini-image:                       # 请求填 `model: "gemini-image"`
  primary: google/gemini-3.1-flash-image   # Google 官方 → ZenMux flash → pro
  fallback: [gemini-3.1-flash-image, gemini-3-pro-image]
```

在两个图片专用端点（`/v1/images/generations`、`/v1beta/interactions`）上，**任意 key** 都可以使用图片 lane。Gemini `:generateContent` 则沿用普通 lane 规则：按名称指定 lane 时，key 必须开启 `allow_custom_model`。因此，如果希望所有有效 key 都能调用，请让图片 SDK 使用前述两个专用端点。

**其他端点**：`/docs` 与 `/openapi.json` 只覆盖主要公共 API；兼容性接口和辅助接口的完整清单见下表及 [05 协议互译](docs/05-protocol-translation.md)。

| 端点 | 鉴权 | 用途 |
|---|---|---|
| `GET /` · `GET /healthz` · `GET /version` | — | 落地页 · 就绪探针 · 构建信息 |
| `GET /v1/models` · `GET /v1/models/{id}` | API key | 列出该 key 可以路由到的模型：所有可用 lane 和 `auto`；自定义模型 key 还会看到带能力与定价信息的具体 alias |
| `GET /v1/usage/stats` | API key | 按指定时间窗口查询当前 key 的聚合用量 |
| `POST /v1/messages/count_tokens` | API key | 按 Anthropic 响应结构返回 token 计数 |
| `/v1/responses/*` 生命周期辅助接口 | API key | `input_tokens`、`compact`、retrieve/delete/cancel/input-items，供 Responses 兼容客户端使用 |
| `POST /mcp` + OAuth discovery | API key 或可选 MCP OAuth | 开启 `memory.mcp.enabled` 后暴露的 Memory MCP 工具 |
| `/portal` · `/portal/api/*` | 数据 API 使用 Helm key | 当前 key 的用量、预算、所属请求与正文、接入指南，以及限定作用域的 Memory |
| `/admin` · `/admin/api/*` | Basic auth | 管理面板及其 JSON 后端；只有启用 admin 时才会挂载 |

## 配置

启动时使用的配置都位于 `config/*.yaml`，加载过程由 Zod 校验。**只要配置不合法，网关就会拒绝启动。** Lane、策略和分类器规则可在管理面板中实时编辑，并以原子方式写回 YAML，同时保留原有注释。运行时设置、key、OAuth provider 账号和 Memory 通过各自的 Store/API 管理，修改后无需重启；已捕获的请求数据则写入独立存储，供调试和审计查询。

| 文件 | 控制什么 | 可实时改 |
|---|---|---|
| `server.yaml` | 主机 / 端口；`base_path` 已解析但当前必须保持 `/` | — |
| `auth.yaml` | API key 必须鉴权这一固定边界，以及首次启动时 root key 的恢复设置 | — |
| `runtime.yaml` | 请求限额、限流默认值、存储驱动、可选信号反馈 | 部分 |
| `providers.yaml` | 上游供应商 + 模型别名（凭证只引用环境变量**名**） | — |
| `lanes.yaml` | 每条 lane 的主模型 + 兜底链（质量 lane、任务 lane、厂商家族 lane） | ✅ 持久化 |
| `policies.yaml` | 按顺序匹配的策略，可指定 lane、限制允许使用的 lane，或强制设置 reasoning effort | ✅ 持久化 |
| `classifier.yaml` | 内置规则 + 可选的 eval 模型 | ✅ 持久化 |
| `model-aliases.yaml` | 把写死的供应商模型 id 映射到 lane / `auto`（可选的兼容映射层） | — |
| `memory.yaml` | 后台记忆形成、遗忘/分层、MCP/OAuth、eager facts 和混合召回。出厂配置已启用遗忘，但新 key 的 Memory 模式仍默认为 `off`；可选的 LLM 摘要默认关闭；配置中出现旧版 `observer:` 块会导致启动失败 | 部分 |
| `capabilities.yaml` / `pricing.yaml` | 手动覆盖模型目录中的能力与价格，包括 prompt 缓存读写价格 | — |

最常用的环境变量（env 优先于 YAML；完整列表见 [`.env.example`](.env.example)）：

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | 可选的 DeepSeek 官方凭证；未提供时会跳过该 provider |
| `ZENMUX_API_KEY`、`OPENROUTER_API_KEY` | 可选供应商凭证（缺失则跳过该供应商） |
| `OPENAI_API_KEY`、`GEMINI_API_KEY` | 可选的官方 provider 凭证。内置 lane 不会直接调用 OpenAI；但任意有效 key 仍可精确指定 OpenAI 官方图片 alias。`gemini-image` 会优先使用 Google 官方接口，失败后切换到 ZenMux。 |
| `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` | 可选的预配置面板账号；未提供时由 `/setup` 收集 |
| `HELM_HOST` / `HELM_PORT` | 服务绑定（默认 `0.0.0.0:8080`） |
| `HELM_STORE_DRIVER` | `sqlite`（默认）或 `supabase` |
| `HELM_STORE_URL_ENV` | 用 `supabase` 时：存放 Postgres DSN 的环境变量**名** |
| `HELM_RATE_LIMIT_ENABLED` | 打开限流（默认关闭） |
| `HELM_OAUTH_ENC_KEY` | 用于加密可恢复 API key 和 OAuth token 的 32 字节密钥；未提供时由 `/setup` 自动生成 |
| `HELM_OPENAI_CODEX_CLIENT_VERSION` | 可选的 Codex `x.y.z` 紧急兼容版本，用于覆盖订阅模型发现和客户端身份；通常不要设置 |
| `HELM_XAI_GROK_CLIENT_VERSION` | 可选的 xAI Grok CLI proxy 协议版本。仅在确认上游因最低版本提高而返回 HTTP 426 时临时设置，随后必须使用真实账号做 smoke 验证 |

> **存储。** 默认使用 SQLite：底层为 `better-sqlite3`，数据库文件是 `./data/helm.db`。如需切换到 Postgres/Supabase，请设置 `HELM_STORE_DRIVER=supabase`，并让 `HELM_STORE_URL_ENV` 指向保存 DSN 的环境变量。遇到未知驱动时，网关会在启动阶段 fail-closed。
>
> **凭证。** `providers.yaml` 只记录供应商 key 对应的环境变量*名称*，明文凭证不会进入仓库或镜像。

### OAuth 订阅类供应商（Claude Pro/Max、ChatGPT Codex、GitHub Copilot）

除了静态 API key，provider 也可以通过 **OAuth 订阅**接入。在管理面板中打开 **提供商 → 连接**：Claude Pro/Max 和 ChatGPT Codex 需要粘贴授权码，GitHub Copilot 使用设备码。Helm 会加密保存持续轮换的 refresh token，并自动刷新短期 access token。

使用前必须设置 **`HELM_OAUTH_ENC_KEY`**：长度为 32 字节，可使用 base64 或 64 位十六进制。管理面板查看或轮转 API key 所需的恢复材料也由这把密钥加密。内置的 Claude、Copilot、Codex 和 xAI 账号池可直接从面板连接，运行时会自动生成 alias，无需编写 YAML。只有自定义 provider/alias 才需要静态 `oauth: { provider: ... }` 配置；如果这类配置存在却未提供加密密钥，网关会 fail-closed 并拒绝启动。

同一供应商可以**接入多个账号**组成池。每个账号（**提供商 → 管理**）各有：

- **模型** —— 真正参与路由的实时白名单，而不是只影响界面显示的筛选。移除模型后会立即停止路由；未加入白名单的模型一律拒绝（fail-closed）。
- **代理** —— 每个账号可分别设置 HTTP/HTTPS/SOCKS5 出口，整条订阅链路都经过该代理，让同一台机器上的不同账号从不同 IP 访问上游。
- **调度** —— `priority` 数字越小，优先级越高；`schedulable` 控制账号是否参与轮换。暂停调度不会断开账号连接。

每个订阅 provider 的账号池还会应用一项**全局使用策略**：

- `balanced` —— 新会话尽量均摊，同时保持会话粘性。
- `manual_priority` —— 先严格按账号 priority 选择，只在同一优先级内轮换。
- `low_risk` —— 在最高优先级层里优先选额度压力更低的账号，降低 429 风险。
- `use_expiring` —— 优先使用短期或周额度即将重置、当前仍有余量的账号；Codex reset credits 会按折扣后的可恢复容量参与评分。

额度仅用于软性评分：数据缺失或过期时会退回 `balanced` 行为；处于硬 cooldown 或被手动暂停调度的账号仍会被排除。选择策略**绝不会自动消耗** Codex reset credits。只有明确点击 **Reset limit**，或触发受保护的 auto-reset 流程，并且周额度窗口达到规定的饱和门槛时，才会使用 reset credits。

账号连接与断开、可用模型、代理和调度设置都支持热重载，从下一个请求开始生效，无需重启。Helm 还会沿用官方客户端的身份请求头，并为每个账号发送**稳定的设备标识**；该标识不会在运行途中轮换，以降低账号被关联封禁的风险。

#### 实验性 SuperGrok / X Premium OAuth

Helm 默认提供 xAI 自家 Grok CLI 使用的设备码登录。设置 `HELM_OAUTH_ENC_KEY` 后，在 **提供商 → 连接** 中选择 **xAI (SuperGrok/X Premium) · Experimental** 即可。Helm 会从 `https://auth.x.ai` 发现 OAuth 端点，加密保存持续轮换的 token，再从 `https://cli-chat-proxy.grok.com/v1/models` 获取当前账号有权使用的模型，并通过该订阅 proxy 的通用 Responses transport 执行请求。无需在 `providers.yaml` 中添加静态配置，也无需开启 feature flag。

xAI 只公开说明了 Grok CLI 自己的 OAuth/设备码登录方式，并未为第三方发布 OAuth client 注册机制，也没有承诺 CLI client ID 与订阅 proxy 是稳定的第三方接口。SuperGrok 订阅与预付费 xAI API credits 也不是同一种产品。因此，该 provider 虽然默认可用，但会始终明确标记为 **Experimental**。它只适合使用本人账号做个人、自托管评估；不要共享、转售或开放给无关租户。正式生产环境应使用 `XAI_API_KEY` 接入 `https://api.x.ai/v1`，或先取得 xAI 的书面许可和 Helm 专用 OAuth client。

SuperGrok 没有公开的额度 API 合约。Helm 现在严格跟随官方 [`xai-org/grok-build`](https://github.com/xai-org/grok-build) 的实现，使用当前账号的 xAI OAuth bearer、账号身份、Grok 客户端请求头和出口代理，读取 `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`。只有处于有效期内的周度 `config.currentPeriod` 及其 `creditUsagePercent` 会转换为管理面板中的额度窗口；预付余额、按需计费、月度周期和历史记录都会被明确忽略。对于格式错误、过期、体积异常、发生重定向或读取失败的响应，Helm 只会短暂缓存，并按 fail-open 原则回退到最后一次有效快照或 `—`。公开 `api.x.ai` 的 credits 不会被拿来冒充消费订阅的周额度。该端点仍属于第一方客户端协议，并非 xAI 承诺支持的第三方接口，因此每次改动协议后都必须使用真实账号做额度 smoke 验证。

Helm 会上报仓库中固定、且已经 live smoke 验证的 Grok CLI 协议版本。如果 proxy 将来返回 HTTP 426 并要求更高版本，可暂时把 `HELM_XAI_GROK_CLIENT_VERSION` 设为已经验证的 semver，然后重新执行模型发现，以及流式、非流式和工具调用 smoke；待新版 Helm 更新默认值后应移除该覆盖。已鉴权的模型目录会保留官方定义的账号侧 `id` 与推理侧 `model` slug 的区别，排除上游标记为 hidden 的条目，并且只路由 Helm 已实现的 `responses` 后端；其他后端按 fail-closed 处理。能力声明仍以真实账号验证为准：Grok 4.5 支持工具、流式、reasoning effort 和已验证的图片输入；Composer 支持工具与流式，但拒绝显式 `reasoning_effort` 和图片输入。未经验证的 JSON 与其他媒体能力按 fail-closed 处理。两者都没有可靠的订阅输出上限，因此 `maxOutputTokens` 保持 `null`。

SuperGrok 订阅没有逐 token 账单。Grok 4.5 的 telemetry 和 key budget 会明确采用 xAI 公布的 API 费率，作为 `api-equivalent` 估算；Composer 没有可靠的公开价格，因此 `cost_usd` 保持 `null`，不会用 0 制造「免费」的错觉。

> ⚠️ **服务条款。** 通过第三方网关路由 Claude/ChatGPT/Copilot **订阅账号**，可能违反对应供应商的 ToS，并导致账号被停用。这是一项面向个人自托管场景、需要主动启用的功能；**你必须自行确保用法符合供应商协议**。如果无法确认，请改用普通 API key（`api_key_env`）。

## 开发

需要 **Node ≥ 22** 和 **pnpm 10**。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start        # 启动后打开 /setup；如有 .env 会自动读取
pnpm dev          # 启动管理面板开发服务器（Vite），见下方说明
pnpm --filter @helm/portal dev # 启动 Portal 开发服务器
CI=true pnpm exec vitest run path/to/relevant.test.ts # 运行指定 Vitest 用例
CI=true pnpm test:e2e     # Playwright 端到端套件（也是 CI 门禁）
pnpm typecheck    # 全仓库 tsc --noEmit
pnpm lint         # Biome
pnpm build        # 构建网关 + admin + portal + ops bundle
pnpm sync:catalog # 刷新生成的模型目录（能力 + 定价）
```

> `pnpm dev` 只会启动 admin SPA。需要启动已构建的 Gateway 时请运行
> `pnpm start`；它使用 Node 22 原生能力读取可选的 `.env`，没有现成配置时
> 会进入与 Docker 相同的浏览器初始化流程。
>
> 规格文档目前仅有英文版。

开发遵循测试先行：局部逻辑和路由使用 Vitest，完整链路使用 Playwright。设计决策记录在 [`implementation-notes.md`](implementation-notes.md)。仓库 CI 会执行 typecheck、lint、build、单元测试、Playwright 和 Docker smoke；在开发机运行 Vitest 时，必须带 `CI=true`，并且只跑相关用例。

```bash
CI=true pnpm typecheck
CI=true pnpm lint
CI=true pnpm exec vitest run path/to/relevant.test.ts
```

## 文档

建议从 [`docs/README.md`](docs/README.md) 开始。如果想先了解完整处理链路，请阅读 **[架构与数据流](docs/architecture.md)**。编号规格的阅读顺序如下：

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
[自助门户](docs/12-self-service-portal.md) ·
[12 记忆的遗忘与分层](docs/12-memory-forgetting-and-tiering.md) ·
[13 记忆管理与 MCP](docs/13-memory-admin-and-mcp.md) ·
[14 记忆深度召回](docs/14-memory-deep-recall.md) ·
[协议兼容性](docs/protocol-compatibility.md)

## 项目状态

Helm API 已具备可运行的端到端实现，并非只搭好了项目框架。配置 → 鉴权 → 分类 → 路由 → 执行（含熔断与兜底）→ 协议互译 → 遥测 → Memory 的完整链路均已接通，并由大量 Vitest 单元测试和 Playwright e2e 用例覆盖。页面顶部的版本徽章会跟随当前发布版本更新。

## 许可

[MIT](LICENSE) © 2026 EasyMeta AU
