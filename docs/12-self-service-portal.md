# 12 — 个人门户（Self-Service Portal）规划

> 状态：**规划（未实现）**。本文档由一次三专家评审（PM / UX / 安全架构师）汇总而成，基于对现有代码的真实探查。开始实现前请通读，并遵守 CLAUDE.md 的 TDD 强制流程（红→绿→重构，安全关键路径测试先行）。
>
> 一句话定位：**门户不是 admin 的缩小版，而是「key 持有者的接入 + 自查」工具。** admin = 运维全知全能（可写、全局、过程视角）；门户 = 只读为主、仅自己数据、结果视角。

---

## 0. 背景与问题

现状：Helm 只有一个**管理后台（admin）**，用 HTTP Basic Auth 全局登录，管理员能看所有 key 的所有数据。拿到 API key 的**个人终端用户**没有任何自助界面——看不到自己的用量/统计/请求详情，不能管理自己的 memory，也没有接入教程。

目标：新建一个**独立的个人门户**，让 key 持有者**只能看/管自己那把 key** 的数据。核心闭环：**接入 → 观测用量 → 自查请求 → 管理 memory**。

---

## 1. 已确认的代码现状（探查事实，非臆想）

### 后端已具备

| 能力 | 位置 | 说明 |
|---|---|---|
| API key 鉴权 | `apps/gateway/src/middleware/auth.ts`（`authMiddleware`） | `Bearer`/`x-api-key` → sha256 → `keyStore.getByHash` → 把 `AuthIdentity` 挂 `c.get("identity")`。含 `keyId`/`keyPrefix`/`accountId`/`role`/`caps`（allowedLanes、rateLimit、budget、memory:{mode,projectId,threadSource}）。**请求内随处可拿 `identity.keyId`**。 |
| 用量自助端点 | `apps/gateway/src/routes/usage.ts`（`registerUsageStatsRoute`） | `GET /v1/usage/stats`，bearer 鉴权，**强制用 `identity.keyId` 聚合，不接受伪造 key_id**。这是正确的作用域范式模板。**注意**：路由层目前只透 `totals`，底层 `aggregate()` 已算好 `series`（时间序列）+ `byModel`（按模型分解）却被丢弃——透出它们即得趋势图/模型分布，**零数据管道改动，MVP 性价比最高的一处后端改动**。 |
| telemetry 按 key 过滤 | `packages/core/src/store/ports.ts`（`TelemetryStore`） | `queryPage({apiKeyId})` 精确等值过滤（请求列表）；`aggregate(start,end,bucket,tz?,keyId?)` 聚合。**底层已支持 key scope，做请求列表/趋势无需新 store 方法。** |
| 按 traceId 取详情/正文 | 同上 | `getByRequestId(traceId)`、`getPayload/getPayloadMeta/getPayloadPart(traceId)` — **store 层零归属校验，只吃 traceId**（头号红线，见 §4.2）。`getApiKeyId(traceId)` 返回该请求属于哪个 key_id，**可用于 ownership 校验**。 |
| memory 强隔离 | `packages/core/src/store/ports.ts`（`MemoryStore`）、`packages/shared/src/key/schema.ts`（`effectiveMemoryProjectId`） | 硬边界 = `accountId`(=owner_id)，跨 account 绝不可见；account 内子 scope = projectId(=`memory_project_id ?? key_id`)/resourceId/threadId。`effectiveMemoryProjectId` 已在 auth.ts 算好挂 `identity.caps.memory.projectId`。id 寻址工具 store 层强制 accountId 谓词，跨租户 id 返 null/false。 |
| memory 持有者通道 | `apps/gateway/src/routes/mcp/{index,tools}.ts` | `POST /mcp`（JSON-RPC）：`memory_add/search/recall/list/get/update/delete`。`accountId` 只从鉴权取、绝不从参数覆盖。**需 `config.memory.mcp.enabled`**。 |
| 模型发现 | `apps/gateway/src/routes/models.ts` | `GET /v1/models` 已按 key caps 过滤。 |

### 前端已具备（可复用）

- **设计系统**：`apps/admin/src/app.css`（Tailwind v4 `@theme` + recipe class：`.card`/`.btn-*`/`.input`/`.select`/`.badge-*`/`.progress-track,-bar`/`.cards-table`/`.table-*` 等）。配色语义：`--color-brand` indigo-600（仅 logo+激活导航）、`--color-action` slate-800（主按钮）、slate 墨阶、emerald/red/amber 状态、sky 链接。
- **关键蓝本**：admin `/keys/[keyId]`（`apps/admin/src/routes/keys/[keyId]/+page.svelte`）**本身就是一个「单-key 用量仪表盘」**——用量卡 + LayerChart 双图（`AreaChart` 用量趋势 + `PieChart` innerRadius donut + 自绘 `<ul>` 图例避开 donut 图例重叠坑）+ 该 key 的请求列表 + 深链到该 key memory。门户概览页≈它的「翻转视角」。
- **可复用组件**：`RequestsTable`（variant recent/key/full，`showKey=false` 自动去 Key/RequestId 列）、`RangeFilter`、`RefreshControl`（key 页目前没有，门户要补）、请求详情查看器（`Conversation`/`TokenUsage`/`CostBreakdown`/`ImagePreview`/`JsonViewer`/`StreamViewer`）、memory 对话框（`AddFactDialog`/`EditFactDialog`/`EditReflectionDialog`/`Modal`）、`ConnectClientDialog`/`ConnectMcpDialog`、`format.ts`（`formatUsd`/`formatTokens`/`formatTps`/`formatTimestamp`）、`i18n`/`LocaleSwitcher`、`paginationItems`。
- **不复用**：`DecisionChain`、上游 `StreamViewer`/上游 payload viewer、`StatusCluster`（版本/健康/star，运维信息）、admin 的 w-64 左侧栏外壳。

### 后端缺口

- ❌ 无 bearer-scoped 的「我的请求列表 / 详情 / payload」REST。
- ❌ 无 memory 的 REST（只有 MCP JSON-RPC）。
- ❌ 无「剩余预算/额度」查询端点。
- ❌ 无门户登录/鉴权（admin 的 Basic Auth 不可用于个人门户）。

---

## 2. 核心用户故事（按优先级）

| 优先级 | 用户故事 | 理由 |
|---|---|---|
| **P0** | 「我怎么把这把 key 接进 Claude Code / Codex / OpenAI SDK？别让我猜 base URL 有没有 `/v1`。」 | key 的唯一入口价值，接不进去其他全为零，且是最高频踩坑点。组件现成、零后端改动。 |
| **P0** | 「我用了多少、花了多少、还剩多少额度？会不会突然被限流/断供？」 | 自助门户的存在理由。`/v1/usage/stats` 安全模型天然就绪。 |
| **P1** | 「我这条请求为什么失败/为什么慢/路由去哪了？」 | 高价值但边界最危险，必须重度脱敏（§4.3）。需新建 bearer-scoped 只读端点。 |
| **P1** | 「Helm 记住了我什么？我能改吗？」 | 差异化能力。已按 key 硬隔离；优先前端直接打 `POST /mcp`，零新后端。 |
| **P2（砍）** | 「让我在门户里改自己的预算/限流/换模型。」 | **YAGNI，明确砍掉。** 账户治理是管理员职权；自助提额破坏信任模型。门户只**读**配额不**改**。Memory 的行为默认值属于 key 持有者自己的数据偏好，单独允许自助修改。 |

**同样砍掉**（YAGNI）：自助轮换/吊销自己的 key、团队/多成员视图、自建子 key、Retry/replay。

---

## 3. 页面清单 + 信息架构

导航（**顶部横向导航**，非 admin 的 w-64 左侧栏——门户仅 4-5 页、移动友好、消费级气质）：

```
⎈ Helm      概览  接入  请求  记忆              [key: helm_…3f9 ▾]
```

- 右上 key 胶囊只显示 `prefix + 末3位`，**永不显示完整 key**；下拉含语言切换 + 退出（清 sessionStorage）。
- 移动端（`<md`）折叠成汉堡下拉。

| 页面 | 路由 | 阶段 | 核心内容 |
|---|---|---|---|
| **概览 Overview** | `/portal`（首页） | **MVP** | 4 张 stat 卡（请求数/成功率/总token/花费，含环比 delta）+「我的额度」进度条区块（admin 无）+ LayerChart 双图（用量趋势 area + by-model donut）+ 最近请求（`RequestsTable` `showKey=false`）。**去掉一切管理动作**（编辑/轮换/吊销）。**智能空状态**：零请求时整页替换成接入引导卡（客户端快捷入口 → 直达接入页对应 tab）。 |
| **接入 Connect** | `/portal/connect` | **MVP（门户灵魂）** | 左侧客户端选择器 + 右侧分步指引 + 一键复制。见 §5。 |
| **请求 Requests** | `/portal/requests` `/portal/requests/:traceId` | 迭代 2 | 列表（`RequestsTable` full 变体，去 key/lane/decided-by 列）+ **脱敏详情**（§4.3）。 |
| **记忆 Memory** | `/portal/memory` | 迭代 3 | facts + reflections 浏览/增删改，复用 admin By-Key 布局但只显示「我的」、隐藏 scope 选择器。加「什么是记忆?」说明气泡 + 隐私文案。空状态引导。 |
| **账户 Account** | `/portal/account` | MVP + Memory settings | key prefix、只读 caps（lanes/预算/速率）以及可编辑的 Memory 开关、模式和项目名。退出、语言仍在账户菜单。 |

**IA 决策**：接入指南放导航第一/二位，不塞进设置角落。新用户第一眼看到「怎么接」，老用户日常看「概览」——这两个是门户双核心。

---

## 4. 关键决策

### 4.1 登录 / 会话模型（安全架构师主导，PM/UX 一致）

**决策：明文 key + `sessionStorage` + 每请求 `Authorization: Bearer` + 强 CSP。否决 server-side session token，否决 localStorage，否决 cookie。**

- 登录页单输入框（`type=password`）粘贴 `helm_...` → 前端调 `GET /portal/api/me`（或 `/v1/usage/stats`）验证 → 200 存 `sessionStorage`（关标签即清）→ 跳概览；失败提示「key 无效」。之后所有请求带 Bearer。
- **为什么否决 session token(b)**：需新建 session 表 + 签发/校验/吊销/过期清理 = 纯新增攻击面；并不真正降低「明文 key 落哪」（换 token 那次仍过一次浏览器内存+TLS）；引入的 session token 同样怕 XSS、要防落库；若把 keyId 塞 JWT 则成不可吊销 bearer，比 API key 更糟。**净负债，违反 principle 2。**
- **为什么收紧到 sessionStorage 而非 localStorage**：localStorage 对 XSS 完全不设防且持久化，任何 XSS 能偷走长期上游凭证且刷新仍在。sessionStorage 缩短窗口 + 去持久化（但仍怕 XSS——CSP 才是主防线）。
- **XSS 纵深防御**：门户 SPA 强 CSP（`default-src 'self'`、无 inline script、无第三方 CDN）、SRI、依赖最小化。
- **诚实边界（写进门户 UI）**：门户对 XSS 的防护上限 = CSP 强度；sessionStorage 不是 XSS 免疫。根治需「只读/受限 scope 的门户专用 key」——那是后续 key-scoping 特性，不在本次范围。
- **不做**账号密码/OAuth/邮箱注册/找回：helm 无 user 表、无 RBAC；key 本身就是身份凭证。门户没有「登录态」这个独立概念，只有「手里有没有一把有效 key」。
- **绝不复用 admin Basic Auth**：那是运维全权门禁，与门户是两个信任边界。

### 4.2 新增 bearer-scoped API 端点

**统一范式（照抄 `usage.ts`）**：`app.use("/portal/api/*", authMiddleware({keyStore,log}))` → 每 route 内 `const identity = c.get("identity")` → 所有 store 调用**写死 `identity.keyId`/`identity.accountId`，忽略调用方任何 key_id/account_id 入参**。

前缀决策：**`/portal/api/*`**（不污染 `/v1/*` 的 OpenAI 兼容契约命名空间；与 `/admin/api/*` 对称）。SPA 静态资源挂 **`/portal`**（公开可访问，鉴权只发生在运行时调 `/portal/api/*` 时带 Bearer——与 admin 静态资源全过 Basic 根本不同）。

| # | 方法 + 路径 | scope 强制 | 复用 store 方法 | 阶段 |
|---|---|---|---|---|
| 1 | `GET /portal/api/me` | 回显 `identity` 安全子集（keyPrefix/role/allowedLanes/budget caps/memory mode），**绝不回 secret** | 纯 identity 投影 | MVP |
| 2 | `GET /portal/api/usage/stats` | `aggregate(..., identity.keyId)`，**透出 series+byModel+budget**（复用/alias 现有 `/v1/usage/stats`，补透被丢弃的字段） | `TelemetryStore.aggregate` + `identity.caps.budget` | MVP |
| 3 | `GET /portal/api/requests` | `queryPage({...filters, apiKeyId: identity.keyId})`，apiKeyId 写死 | `TelemetryStore.queryPage` | 迭代 2 |
| 4 | `GET /portal/api/requests/:traceId` | **先 ownership 校验**（§4.4）→ `getByRequestId` → **白名单脱敏投影**（§4.3） | `getApiKeyId` + `getByRequestId` | 迭代 2 |
| 5 | `GET /portal/api/requests/:traceId/payload` | **先 ownership 校验** → 取正文，**白名单 `part ∈ {request,response}`，拒 upstream** | `getApiKeyId` + `getPayloadMeta/getPayloadPart` | 迭代 2 |
| 6 | memory CRUD | **优先前端直接打 `POST /mcp`（零新后端）**；若必须 REST，则 `accountId: identity.accountId` + `projectId: identity.caps.memory.projectId` 全写死，逐字复用 MCP 隔离不变量，**绝不照搬 `/admin/api/memory/*`**（query 参数寻址 = 破隔离） | MCP tools / `MemoryStore` | 迭代 3 |
| 7 | `PATCH /portal/api/memory-settings` | 严格只收 `memory_mode` / `memory_project_id`；更新目标写死 `identity.keyId`；root key 拒绝 | `KeyStore.updateKey` | 迭代 4 |

memory REST（仅当 MCP 未启用/需 REST 语义时）：`GET /portal/api/memory/facts`、`GET/PATCH/DELETE .../facts/:id`、reflections 同构。

### 4.3 数据暴露边界（脱敏，principle 6：暴露 lane 抽象，不暴露模型市场/供应链）

**请求详情——门户只给「lane 视角/结果视角」，不给「供应链/过程视角」。** 新增 `toPortalDecisionView(record): PortalDecisionView` **白名单式**纯函数（放 core/shared，框架无关；白名单默认不泄漏，黑名单漏一个就泄漏；**必须单测：provider 别名/内部 model id 绝不出现在输出**）。

| admin 详情信息 | 门户 | 理由 |
|---|---|---|
| 本人请求/响应正文（prompt/messages/completion） | ✅ 给 | 他自己的数据，capture_payloads 开着就能给；正文无明文 key（bearer 在头里） |
| served model、lane、状态、延迟、token、cost、错误消息 | ✅ 给 | 「我的请求发生了什么」的合法自查范围 |
| `upstream_request`（翻译/注入后发给 provider 的 body） | ❌ 砍 | 暴露协议翻译细节 + 注入的 memory 上下文 |
| provider 尝试链 / 服务账号 / wire model / 上游原始错误 / provider 别名 | ❌ 砍 | **泄露路由拓扑 + 订阅账号身份，商业敏感** |
| 分类/eval 决策链（task_type、置信度、eval 裁决、rules→eval 因果）、熔断状态、skip reason | ❌ 砍 | 网关内部推理，helm 核心 IP |
| Retry/replay | ❌ 砍 | 特权写操作 |

- 折中：可给一行**脱敏「路由结果」**——「已路由至 `<served model>`（lane: balanced），耗时 1.2s」（served model 用户本就能从响应看到）。**不复用整个 `DecisionChain.svelte`**，只复用正文/token/cost 查看器。
- **payload 端点**：默认只暴露 `request`+`response` 两段，**过滤 `upstream` 段**（供应链细节，admin 才看）。

**用量成本**：**显示 `$` 花费**（自托管场景成本透明是信任基石，是给自己人看真实消耗）。**不显示** provider 成本明细/内部计价/markup（principle 6）。额度用**进度条 + 剩余量 + 超支行为 + 重置时间**呈现；无预算上限显示「无限制」。

### 4.4 Ownership 校验（防跨 key 泄漏核心）

traceId 寻址（端点 4/5）——store 层零校验，**必须在路由层、取数据之前**挡。共享 helper：

```ts
// apps/gateway/src/routes/portal/ownership.ts（新增）
async function assertOwnsTrace(c, telemetry, traceId): Promise<"ok"|"not_found"> {
  const identity = c.get("identity");
  const owner = await telemetry.getApiKeyId(traceId);   // string | null
  if (owner === null || owner !== identity.keyId) return "not_found"; // miss 与"属于别人"同一分支，防枚举
  return "ok";
}
```

- 校验**先于** `getByRequestId`/`getPayload` 调用（不先取再判）。
- 失败一律 **404 not_found（非 403）**——403 会泄漏「此 traceId 存在但不是你的」，让持有者枚举全站请求/探测他人 traceId。
- memory id 寻址：store 层已强制 accountId 谓词（跨租户 id → null/false → 404），门户不必路由层查 owner，只需保证 `accountId` 来自 `identity.accountId`。

### 4.5 隔离粒度错配（memory 特有陷阱）

- telemetry 隔离粒度 = **keyId**（key 级）；memory 隔离粒度 = **accountId**（账户级），key 级只是 projectId 软 scope。
- 若 account 下多 key 且 `memory_project_id` 皆 null → `effectiveMemoryProjectId` 各落 key_id → 天然 key 级隔离，门户始终传 `projectId: identity.caps.memory.projectId` 即可。
- 若运营方给多 key 设同一显式 `memory_project_id`（共享池）→ 同 project 的 key 互见 memory，**这是配置决定的预期共享，非 bug**，但门户 UI 须诚实标注「此 memory 池为 project xxx，可能与同 project 的其他 key 共享」。
- 门户自助修改 project 只切换默认池，**不迁移**旧池里的 facts/reflections；UI 必须在输入框旁明示。`/portal/api/me` 同时返回 effective `project_id` 与原始 `project_name`，避免把 null→keyId 的私有回落误标成显式共享。

### 4.6 fail-open / 错误信封

- principle 3 的 fail-open（分类/eval/缓存失败→降级 balanced）是**网关请求路径**语义，**门户只读查询不适用**——查不到就如实报错，绝不「降级返回空/别人的数据」。
- 鉴权 fail-closed（401 auth_error，复用现成）；ownership 失败 fail-closed（404）；store 出错结构化 500。
- **数据隔离维度永远 fail-closed**：门户 helper 必须断言 `identity.keyId` 存在（`if (!identity?.keyId) return 500`），**宁可 500 也绝不 fail-open 成无 scope 查询**（否则 keyId=undefined 传入可选过滤 → 泄漏全租户）。
- 错误信封复用 helm 现有结构化模型 `{error:{type,message,code}}`，全程透传 `trace_id`。

---

## 5. 接入页（门户独有价值，重点打磨）

**模式：左侧客户端选择器 + 右侧分步指引 + 一键复制。** base_url 从 origin/`/version` 自动推导；key 字段默认脱敏 `helm_…3f9` + 「显示完整 key」临时开关（点击短暂显示明文供复制，不常驻明文）；每代码块右上角 📋 复用 `navigator.clipboard`。

| Tab | 要点（含血泪坑位，前置为 ⚠️ 提示） | 复用 |
|---|---|---|
| **Claude Code** | `ANTHROPIC_BASE_URL`（⚠️ **不带 `/v1`**，否则 404）+ `ANTHROPIC_API_KEY` | `ConnectClientDialog` 逻辑 |
| **Codex** | `config.toml` base_url（⚠️ **必须带 `/v1`**，与 Claude Code 相反）+ `wire_api=responses` | 同上 |
| **通用 OpenAI SDK** | Python/Node：`OpenAI(base_url=..., api_key=...)`，默认 `model:"auto"` | 新写 |
| **Cline / Roo / Cursor** | 本质 = OpenAI 兼容 base_url + key，可并入 OpenAI SDK tab 一行文案（YAGNI 不必单列） | — |
| **MCP 记忆** | `POST /mcp` URL + key；ChatGPT connector(OAuth) / `claude mcp add` / `.mcp.json` / Codex mcp-remote 桥 / curl 连通测试。**仅当 `memory.mcp.enabled` 显示** | `ConnectMcpDialog` |

- 每 tab 统一结构：① 复制 base_url → ② 填 key（回填当前 key 前缀）→ ③ 可直接跑的示例 → ④ 可选「测试连接」（打一发 `/v1/models` 验证连通）。
- 移动端：左选择器折叠成顶部 chips/下拉，右指引全宽。

---

## 6. 和 admin 的边界（绝不进门户）

| 只属于 admin | 原因 |
|---|---|
| 看别的 key / 全局枚举（请求列表 key 下拉、memory By-Scope/By-Key 全枚举、`keyStore.list()`） | 跨租户越权 = 数据泄露 |
| 决策链内幕（provider 身份/订阅账号/eval 推理/upstream payload/provider 别名） | 泄露路由拓扑与核心 IP |
| 改配额/限流/lane/预算/blockedModels | 账户治理是管理员职权 |
| Retry/replay | 特权写操作 |
| memory 运维面（队列/lag/jobs/全局统计/跨 account scope） | 运维视角 |
| 系统设置（capture_payloads 开关/retention/VACUUM/provider 凭证） | 纯运维 |
| 创建/禁用/轮转 key、看密文 | 身份签发是管理员职权 |
| Basic Auth 凭证 / admin 登录 | 两个信任边界 |

**边界一句话**：admin 回答「整个网关和所有用户怎么样」；门户只回答「**我这把 key** 怎么样、怎么用」。凡需看到「我」以外任何东西的能力都归 admin。

---

## 7. MVP 范围（三页）

**Overview + Connect + 登录页**（PM 与 UX 都推 Connect + Overview 为双核心；Requests/Memory 留迭代）。

理由：
1. **Connect** 让 key 能用起来——不解决接入门户无意义，且**零后端改动**（组件现成，登录靠粘贴 key）。
2. **Overview/Usage** 让用户看清花了多少/还剩多少——自助门户的存在理由；后端**只需在 `usage.ts` 透出已算好的 series/byModel/budget**（全项目性价比最高的小改）+ 复用 admin 图表组件。
3. **登录页**极简单页（粘贴 key → 验证 → sessionStorage）。

**迭代 2**：Requests（列表 + 脱敏详情）——需新建 `/portal/api/requests*` bearer-scoped 端点 + `toPortalDecisionView` 白名单脱敏 + `assertOwnsTrace`（**这三处必须 TDD，红线测试先行**）。
**迭代 3**：Memory（优先前端直连 `POST /mcp`，零新后端）。

前端脚手架：新建 `apps/portal`（独立 SvelteKit SPA，`paths.base:'/portal'`，`ssr=false`），复用 admin `app.css` + LayerChart 配置 + `format.ts` + `i18n` + 上述组件。共享组件抽包或 copy（视 admin/portal 耦合容忍度）。

---

## 8. 红线速查（不做 = 跨 key 泄漏）

| # | 红线 | 后果 |
|---|---|---|
| R1 | traceId 详情/payload 先 `getApiKeyId==identity.keyId` 再取数据 | 拿到任意 traceId → 读任意 key 完整决策链 + 未脱敏正文 |
| R2 | ownership 失败返 **404**（非 403） | 枚举全站请求、探测他人 traceId |
| R3 | memory scope 只从 `identity` 派生，绝不从 query/body 取 accountId/projectId | 填别人 accountId → 读全站 memory |
| R4 | memory list 始终带 `projectId: identity.caps.memory.projectId` | 只传 accountId → 泄漏同账户其他 key 私有 fact |
| R5 | 隔离维度（keyId/accountId 过滤）永不 fail-open，缺失则 500 | keyId=undefined 传入可选过滤 → 返回全租户数据 |
| R6 | 门户端点绝不接收明文 key 作 query/body，只走 Authorization 头 | 明文 key 落 access log/`request_payloads`/浏览器历史（违反 principle 7） |
| R7 | DecisionChain 白名单投影 + payload 剔除 upstream 段 | 泄漏 provider 别名/内部 model id/fallback 链（违反 principle 6） |

---

## 9. 实现成本（从省到贵）

1. **近零**：`/portal/api/usage/stats`（复用 `/v1/usage/stats` + 透出被丢字段）、`/portal/api/me`（identity 投影）、memory 走 `/mcp`。
2. **低**：`/portal/api/requests`（queryPage 加 apiKeyId）、budget（caps + aggregate）。
3. **中（核心安全代码，TDD 先行）**：`assertOwnsTrace` + 端点 4/5 ownership 校验 + `toPortalDecisionView` 白名单脱敏。
4. **最贵**：门户 SPA（新 `apps/portal` + `paths.base:/portal` + CSP + sessionStorage 鉴权流）——但只是消费者壳，隔离全落后端。
