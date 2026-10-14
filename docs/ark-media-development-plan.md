# Helm 方舟多媒体开发计划

- 计划版本：v1，2026-10-14（Asia/Shanghai）。
- 总状态：**T01–T12 离线集成验收通过（T03 不适用）；T13 受阻，未发布**。
- 批准版参考基线：`8ddc30d253afeda43e8930347a9d8b63bab9b62d`；实际执行基线：`f0d962692f97b18fb8ed118c3c1991fbfe0d1770`（2026-10-14 fetch origin/main）。
- 目标：在 Helm 中接入 Seedream 5.0 Flash、Seedream 5.0 Pro、Seedance 2.5、Seed3D 2.0，保留已有 Grok 和其他 provider 行为。
- 最新选型：优先 OpenAI 兼容 API / SDK 扩展请求；确实无法覆盖的能力，下载并固定方舟官方 SDK 源码作为参考，只用 TypeScript 实现缺失部分。**不引入 Python/Go 运行时服务。** 这取代前份研究报告中的 Python 适配进程备选。
- 确认本计划表示可以开始这里的本地开发和离线验证；用户随后已授权提交代码与集成验收；推送、生产部署及新增付费调用尚未授权。

## 1. 技术路线与边界

按以下顺序选择实现，不能一开始就重写 SDK：

1. **已有兼容接口**：Seedream 使用 `/images/generations`，优先复用 Helm 图片入口和兼容客户端。
2. **SDK 扩展接口**：对 Seedance / Seed3D 的 `/contents/generations/tasks`，优先使用 OpenAI Node SDK 文档支持的 `client.post/get`，复用 Helm 受控传输。这是方舟原生任务协议，不宣称它等同于 OpenAI Videos API。
3. **条件性 TypeScript 适配**：只有定向测试证明前两层无法正确表达某项语义，才参考方舟官方 SDK 补齐。先记录失败证据、源版本与方法，再编写最小适配，遵守许可证；不复制整套 SDK，不再实现通用 HTTP 库。

OpenAI SDK 使用候选固定版本 `7.33.0`，最终由任务 T02 验证 Node 22+、依赖、超时与传输边界后确定。官方 Python `arkruntime 0.12.0` 与 Go 官方仓库仅作为协议参考。此前的离线 SDK 探针通过，不代替 Helm 集成验收。

### 交付能力

| 模型 | 精确上游 ID | 本期基础能力 |
|---|---|---|
| Seedream Flash | `doubao-seedream-5-0-flash-260915` | 文生图、单图编辑、多图参考、图层拆分 |
| Seedream Pro | `doubao-seedream-5-0-pro-260628` | 文生图、单图编辑、多图参考、图层拆分 |
| Seedance 2.5 | `doubao-seedance-2-5-260628` | 文生视频、首帧/首尾帧、图/视频/音频组合参考，包括用户提供的组合示例 |
| Seed3D 2.0 | `doubao-seed3d-2-0-260328` | 单图生成带纹理/PBR 的 GLB、任务查询 |

接口方案：图片复用 `/v1/images/generations`；视频复用 `/v1/videos/generations` 与 `/v1/videos/{id}`；3D 新增 `/v1/3d/generations` 与 `/v1/3d/{id}`。这些新增/扩展契约在 T01 冻结，当前正在联合验证。

本期不包含 Seedance 编辑/延长、Draft、webhook、全账户任务列表/删除、资产存储服务或可视化编辑器。Seedream Flash/Pro 官方不支持的流式、组图和搜索明确拒绝。高级功能以后独立排期，不能用静默忽略参数表示支持。

## 2. 状态与完成规则

每个 task 都有独立编号、依赖、交付物和验收证据。独立表示可以单独判断是否完成，不表示相互没有依赖或应同时改动相同文件。

状态仅使用：

- **待确认**：计划尚未批准。
- **待开始**：已批准，尚未执行；依赖未完成时记录等待依赖。
- **进行中**：记录执行人、分支/工作目录、当前步骤。
- **待验收**：实现和自检结束，等待该任务的验收证据。
- **已完成**：全部验收条件通过，附可追溯证据。
- **受阻**：明确外部阻挡、已做工作与恢复条件。
- **不适用**：条件任务不需要触发，附判断证据，不能伪装成已实现。

每次完成一项即更新任务表。证据条目必须包含：实际基线或工作副本 diff 摘要、文件路径、执行命令、结果、日志路径、剩余限制。提交后补 SHA；未提交时不得编造 SHA。付费实测另外记录任务 ID、最终状态、产物与 usage，不保存密钥。

“代码已完成”“离线验收已完成”“真实模型验收已完成”“已部署”分别记录。依赖失败时不将后续项标记为完成。

## 3. 任务总表

| Task | 优先级 | 独立交付物 | 依赖 | 当前状态 |
|---|---|---|---|---|
| T01 | P0 | 接口、能力与错误契约 | 用户已确认 | 已完成（已提交并合入集成分支，主控复测通过） |
| T02 | P0 | SDK 传输与安全边界适配 | T01（集成前置）；传输层可独立开发 | 已完成（已提交并合入集成分支，主控复测通过） |
| T03 | P0，条件任务 | 官方 SDK 缺口的 TypeScript 实现 | T02 证明存在缺口 | 不适用（OpenAI SDK 已覆盖本期传输） |
| T04 | P0 | Ark provider、模型配置与发现 | T01、T02，必要时 T03 | 已完成（离线；证据见集成验收记录） |
| T05 | P0 | Seedream Flash/Pro 单图生成端到端 | T04 | 已完成（离线；证据见集成验收记录） |
| T06 | P0 | Seedance 创建、查询与任务恢复端到端 | T04 | 已完成（离线；证据见集成验收记录） |
| T07 | P0 | Seed3D 创建、查询与 GLB 结果端到端 | T06 的任务基础 | 已完成（离线；证据见集成验收记录） |
| T08 | P0 | 计费、权限和防重复提交联合验收 | 规则从 T01 实施；最终验收依赖 T05–T07 | 已完成（离线；证据见集成验收记录） |
| T09 | P1 | Seedream 编辑、多图与图层拆分 | T05、T08 | 已完成（离线；证据见集成验收记录） |
| T10 | P1 | Seedance 首尾帧与全模态参考 | T06、T08 | 已完成（离线；证据见集成验收记录） |
| T11 | P1 | 模型展示、API 文档与调用示例 | T04–T10 | 已完成（离线；证据见集成验收记录） |
| T12 | P1 | 四模型 hermetic 集成与兼容回归 | T05–T11 | 已完成（离线；证据见集成验收记录） |
| T13 | P1 | 四模型真实调用验收记录 | T12、单独批准的测试范围/费用 | 受阻（没有新增实测授权；Seedance 账号额度受限） |

顺序：先 T01 → T02 → 必要时 T03 → T04 → T05 → T06 → T07 → T08，完成基础闭环和风险验证后再做 T09–T12。T13 依赖测试授权与上游条件。主 agent 负责集成与最终验收，不为每个 task 自动启动一个 agent。

## 4. 各任务验收卡

### T01：冻结接口与能力契约

- 状态：已完成（本地代码与离线验收；详见集成验收记录）；依赖：计划已批准。
- 交付：四模型字段/能力表、Helm 请求/响应样例、任务状态映射、错误分类、金额预算行为。
- 范围：检查当前官方文档与 SDK 类型；定义 Seedream 的可选 prompt 场景、图层元数据，Seedance 角色组合/画幅/时长限制，Seed3D 文件字段和 3D 能力标记。
- 验收：每个支持字段有来源与合法/非法例子；未知或暂不支持的字段有明确拒绝规则；Grok 原契约保留；公开模型名可解析到配置 alias，不暴露密钥。
- 验证：新增 shared schema 测试并先观察失败；文档中的四种示例进入离线 fixture。
- 预计路径：`packages/shared/src/request/`、`packages/shared/src/catalog/schema.ts`；实现决策才进入 `implementation-notes.md`。
- 完成证据：契约文档路径、fixture 清单、红灯测试命令与摘要。

### T02：SDK 与受控传输接通

- 状态：已完成（本地代码与离线验收；详见集成验收记录）；依赖：模型集成仍等待 T01。
- 交付：仅用于 Ark 的 TypeScript SDK 适配层，固定依赖版本，支持 images 和 content task create/get。
- 范围：注入 Helm 现有受控 fetch/连接策略，接通 AbortSignal、超时、响应体上限、错误处理和上游请求捕获；创建 `maxRetries=0`。
- 验收：请求仅发往配置的 Ark 目标；密钥不进日志；自定义字段和响应元数据保真；503/超时创建仅一次；中止和超大响应按现有边界处理；明确的上游拒绝与结果不明分开。
- 验证：mock fetch 验证 URL、HTTP 方法、脱敏、取消及调用次数；在 Helm 支持的 Node 22+ 环境验证。
- 预计新增测试：`packages/core/src/provider/ark.test.ts`，路径可随现有结构调整并回写。
- 完成证据：锁定的包版本、定向测试结果、缺口评估。没有缺口则 T03 标“不适用”。

### T03：参考官方 SDK 补齐 TypeScript 缺口（条件任务）

- 状态：不适用（SDK 覆盖本期所需传输）；触发条件：T02 给出不能用兼容方法或 SDK 扩展请求满足的具体失败用例。
- 交付：缺口说明、官方源版本/哈希/许可证、最小 TypeScript 适配及行为测试。
- 验收：只修复已证明的缺口；不引入 Python/Go 服务；Zod 为边界类型来源；官方 fixture 的关键行为匹配；已有 SDK 通过项不重复实现。
- 验证：先红后绿的缺口测试，与 T02 套件一起运行。
- 完成证据：源链接和方法、差异说明、测试结果。SDK 能覆盖时记录“不适用”，不开展重写。

### T04：Provider 配置、凭证与模型发现

- 状态：已完成（本地代码与离线验收；详见集成验收记录）；依赖：T01、T02；T03 如触发须完成。
- 交付：可选 Ark provider、四个模型映射、图片/视频/3D 能力标签和发现接口。
- 验收：凭证只引用环境变量；非法配置 fail-closed；未配置 Ark 的原部署行为不变；媒体模型不进入聊天分类/fallback；模型封禁和直接 alias 权限继续生效；聊天连通性测试不能调用媒体生成。
- 验证：配置 schema、provider 工厂与模型发现定向测试。
- 预计路径：`config/providers.yaml`、`config/capabilities.yaml`、shared config/catalog、`apps/gateway/src/server.ts`、models 路由。
- 完成证据：脱敏配置样例、四模型发现 fixture、权限拒绝用例。

### T05：Seedream Flash/Pro 单图生成

- 状态：已完成（本地代码与离线验收；详见集成验收记录）；依赖：T04。
- 交付：两个模型从 Helm 图片入口到 SDK 的文生图闭环。
- 验收：模型 ID/尺寸/格式正确转发；合法 URL/base64 输出按已冻结契约返回；错误被结构化传回；不丢 data/usage 元数据；不沿用聊天 token 单价；不发生不明结果重试。
- 验证：两种模型分别通过成功、明确拒绝、网络结果不明三个 fixture；原图片路由相关用例保持通过。
- 预计测试：`packages/core/src/provider/ark.test.ts`、`apps/gateway/src/routes/images.test.ts`。
- 完成证据：两模型 mock 请求/响应、定向测试摘要。这里只标离线闭环，真实出图由 T13 验收。

### T06：Seedance 异步视频基础闭环

- 状态：已完成（本地代码与离线验收；详见集成验收记录）；依赖：T04。
- 交付：文生视频 create/get、持久化任务归属、任务状态映射和重启恢复。
- 验收：`id → request_id`、`succeeded → done`、`content.video_url → video.url`；failed/cancelled 正确终结；未知状态不视作成功；任务只能由允许的 owner/key 查询，且固定创建时的 provider/凭证身份。
- 验收：任务映射保留期匹配上游 7 天窗口，视频链接 24 小时有效期单独说明；避免多 provider 任务 ID 冲突；创建 ID 持久化失败返回结果不明且不重发。
- 验证：创建成功后异步 `SetLimitExceeded`、跨 key、重启恢复、TTL、取消终态、网络超时和零重复 POST；保留 Grok 的 done/failed/expired 行为。
- 预计测试：`videos-schema.test.ts`、`routes/videos.test.ts`、responses registry 相关定向测试。
- 完成证据：状态转换 fixture、实际存储恢复证据、测试结果。

### T07：Seed3D 基础闭环

- 状态：已完成（本地代码与离线验收；详见集成验收记录）；依赖：T06 的任务基础完成。
- 交付：独立 3D schema、能力标记、创建/查询路由及 GLB 结果。
- 验收：一张图输入、`file_format=glb`、合法 subdivision 参数正确转发；读取 `content.file_url`；创建/查询元数据字段差异被处理；3D 任务不能通过视频资源入口读取。
- 验证：成功 GLB、异步失败、缺少 file_url、错误任务类型、跨 key 和重启恢复；远程文件本身有效性留给 T13。
- 预计新增测试：`packages/shared/src/request/ark-media-schema.test.ts`、`apps/gateway/src/routes/three-d.test.ts`。
- 完成证据：完整离线 create/get 请求与响应、定向测试结果。

### T08：费用、权限与重复提交验收

- 状态：已完成（本地代码与离线验收；详见集成验收记录）；依赖：T05–T07；本任务规则在前置实现中持续执行，不能等到这里才添加安全控制。
- 交付：三类媒体的计价/未知成本规则、权限与重复提交测试记录。
- 本期预算策略：仅在费用可准确计算且硬预算边界可证明时支持金额限额；其余请求在上游调用前明确拒绝，保留 `media_pricing_unavailable` 等可识别错误。未知费用不是 0 元。
- 验收：Flash/Pro 按图片、像素档位和输入数量处理；图层按实际返回层分别处理；视频/3D 的异步 usage 不被当作创建时已结算；CNY 不直接写进 USD 字段；轮询不重复计数/扣费。
- 验收：请求/并发限额、blockedModels、allowCustomModel、owner/key 隔离均生效；创建不发生 SDK+Helm 双层重试；明确拒绝与不明结果分类正确。
- 验证：预算上限、未知价格、重复 GET、异步失败、脱敏和零重复写的定向测试。
- 范围说明：本期不承诺为视频/3D 新建完整异步金额预算预占系统；如业务必须支持这类 spend-capped key，应另加明确任务后再开放，不能放松校验。
- 完成证据：每种计价/拒绝行为的 fixture 与测试结果；所有 P0 项通过后进入 P1。

### T09：Seedream 编辑、多图与图层拆分

- 状态：已完成（本地代码与离线验收；详见集成验收记录）；依赖：T05、T08。
- 交付：单图编辑、2–10 图参考、图层拆分及透明通道等本期支持字段。
- 验收：image 字符串/数组走 Ark images/generations；自动拆分允许官方支持的省略 prompt；完整保留层级、坐标、名称和说明；不接受 Flash/Pro 不支持的组图/stream/search。
- 验证：两个模型各有合法请求、数量边界、字段互斥和多层输出 fixture；预算不按单张产物错误结算。
- 完成证据：schema 与图片路由测试、客户端可直接使用的图层响应样例。

### T10：Seedance 首尾帧和全模态参考

- 状态：已完成（本地代码与离线验收；详见集成验收记录）；依赖：T06、T08。
- 交付：首帧/首尾帧及图片+视频+音频参考的请求分支。
- 验收：4–30 秒和 -1、专属 ratio 枚举、30 图/10 视频/10 音频限制正确；首尾帧要求 adaptive；reference 模式保持素材顺序和 role；用户原始组合示例除密钥与约定入口外可表达完整意图。
- 验收：URL 输入先做严格校验，不为读元数据自动下载用户远程素材；媒体实际尺寸/时长由上游验证，错误可追踪；不把参考图宣称为严格首尾帧。
- 验证：数量和角色边界、TaskTypeConstraint/TaskTypeMismatch、合法混合内容保真；编辑/延长等未交付模式明确拒绝。
- 完成证据：不含密钥的用户示例 fixture、定向 schema/provider/route 测试。

### T11：模型展示与文档

- 状态：已完成（本地代码与离线验收；详见集成验收记录）；依赖：T04–T10。
- 交付：OpenAPI、中文/英文调用说明、环境变量配置、后台能力标记、故障处理与当前限制；实现决策写入 implementation-notes，遵守最近 10 条规则。
- 验收：四模型各有完整调用示例；视频和 3D 含查询到终态示例；图片区分普通单图和图层模式；说明 Key 权限、费用不可用时的拒绝、产物有效期及 SetLimitExceeded。
- 验证：OpenAPI 定向测试；只有受影响的后台操作才用 Playwright 验证。文档示例必须通过 schema/fixture 检查。
- 完成证据：API 文档与界面入口路径、验证结果；媒体模型聊天连通性按钮禁用/拒绝证据。

### T12：离线集成与兼容回归

- 状态：已完成（本地代码与离线验收；详见集成验收记录）；依赖：T05–T11。
- 交付：四模型 hermetic 端到端结果、构建/类型/格式检查与未解决项清单。
- 验收：通过 Helm HTTP 入口完成图片请求、视频 create/get、3D create/get；覆盖拒绝与异步失败；Grok 图片/视频原行为保持；不访问真实付费端点。
- 验证：定向 Vitest 与受影响的 hermetic Playwright，必要的 typecheck/lint/build。若进入 PR 阶段，按仓库要求等待全部必需 CI（含 e2e/Docker smoke）通过。
- 完成证据：命令、退出码、日志路径、被测版本/diff；CI 尚未运行时明确写未运行，不能写“CI 全绿”。

### T13：真实模型验收

- 状态：受阻（无新增付费授权；Seedance 账号额度受限）；依赖：T12，以及用户单独批准的模型、任务数和费用范围。
- 已知外部阻挡：此前 Seedance 任务 `cgt-20261014140243-mgu53` 为 `failed / SetLimitExceeded`。恢复条件是用户解决额度限制；不能自动关闭安全体验模式或充值。
- 交付：每个模型独立的真实验收条目：Flash、Pro、Seedance、Seed3D。一个模型受阻不覆盖其他模型的状态。
- 验收：必须经 Helm 创建；图片可读取且格式有效，视频到成功终态并可读取且规格符合请求，3D 到成功终态且ZIP 内含有效 GLB/PBR 资源；记录模型 ID、任务 ID、usage 和费用依据，区分估算与账单。
- 执行约束：先给具体请求、任务数量和官方计价，再获得付费测试批准；不复用已经消耗的那一次测试授权；create 只发一次，结果不明先核对任务，不重发。
- 完成证据：脱敏响应、产物验证摘要、每模型通过/受阻/未测状态。不能仅凭 HTTP 200 或任务 ID 验收。
- 生产部署不是本任务默认范围；发布/部署获授权后另列任务并增加生产 readback。

## 5. 验证与执行约定

开工后建立隔离分支/工作目录，保留主 checkout。任务台账迁入该工作目录的 `docs/ark-media-development-plan.md`，成为唯一执行状态来源；本文件保留为批准版。路径与任务拆分若发生实质变化，记录原因，不静默扩大范围。

代码任务遵守红 → 绿 → 必要重构。每项只运行相关测试，带 `CI=true`。单次定向测试预算默认 10 分钟；同一失败调查不超过 20 分钟，没有新证据不重复尝试。

以下是命令模板；标注“新增”的文件在实现时创建，不表示当前已存在：

```bash
CI=true pnpm exec vitest run packages/core/src/provider/ark.test.ts
CI=true pnpm exec vitest run packages/shared/src/request/videos-schema.test.ts apps/gateway/src/routes/videos.test.ts
CI=true pnpm exec vitest run apps/gateway/src/routes/images.test.ts
CI=true pnpm exec vitest run packages/shared/src/request/ark-media-schema.test.ts apps/gateway/src/routes/three-d.test.ts
CI=true pnpm --filter @helm/gateway exec playwright test e2e/videos.spec.ts
```

每个任务报告采用统一格式：

```text
Task：Txx / 标题
状态：待开始 → 进行中 → 待验收 → 已完成（或受阻/不适用）
执行人 / 分支 / 工作目录：
依赖与基线：
交付文件：
验证命令 / 结果 / 证据路径：
真实调用：未进行 / 单独列证据
剩余限制与恢复条件：
更新时间：Asia/Shanghai
```

## 6. 批准与最终完成条件

- [x] 用户确认本开发计划，并授权主控创建 Codex App 对话并行开发。
- [ ] T01–T12 验收完成；T03 可凭证据标为不适用。
- [ ] T13 四模型分别有真实通过证据，或明确列为受阻/未测。
- [ ] 最终报告区分源码、自检、CI、真实验收及部署状态。

**当前完成情况：计划已批准；T01/T02 已派发，两个对话均已回读为 active。其余任务按依赖待开始。** Seedance 已有的那次真实失败是研究证据，不计为本计划的成功验收。

## 7. 主控执行记录

- 2026-10-14：用户批准计划并明确要求创建新的 Codex App 对话并行开发。第一批仅开 T01/T02，独立托管工作区；主控独占总台账、共享导出、网关装配及后续集成。T02 先执行不依赖模型 schema 的传输契约测试；模型集成仍等待 T01 验收。
- 主控工作区：`/Users/lukin/Projects/.worktrees/ark-media-integration/helm-api`，分支 `codex/ark-media-integration`。
- 提交/推送、生产部署、额外付费测试均不包含在本轮开发授权内。
- 当前最新基线新增的客户端模型限制和 Grok pinned 首尾帧契约必须纳入兼容验收。

### 第一批开发对话

| Task | Codex 对话 | Thread ID | 当前派发状态 |
|---|---|---|---|
| T01 | Helm Ark T01：媒体契约与 Schema | `01a13924-8490-78e2-989f-09906c5c7733` | 交付完成，独立工作区已核对 |
| T02 | Helm Ark T02：OpenAI SDK 传输适配 | `01a13924-895a-7263-a02f-3c25803a74d9` | 交付完成，独立工作区已核对 |

主控通过 wait_threads 读取交付与阻挡，必要时向已有对话继续派发，不为同一问题重复新建对话。以上状态仅表示开发已启动，不表示测试或验收通过。

### 2026-10-14 15:11 主控状态核验

- T01 对话已完成并 idle，工作区 `/Users/lukin/Projects/.worktrees/ark-media-t01-contract/helm-api`。独立核对3个新增文件与证据哈希；使用其记录的独立 Vitest 配置复测，126个新增用例+34个既有用例，160/160通过。默认仓库配置因该隔离依赖环境缺少Svelte插件无法启动；独立配置仅跳过无关管理界面配置，不等于完整workspace验证。
- T02 对话已完成并 idle，工作区 `/Users/lukin/Projects/.worktrees/ark-media-transport/helm-api`。核对3个新增文件、core/package.json和锁文件；使用默认Vitest配置定向复测37/37通过。
- 主控复测日志：`/Users/lukin/Documents/Codex/2026-10-14/helm-seedance-research/controller-t01-check.log`、`controller-t02-check.log`。
- 两任务均为独立交付完成，状态转待验收：共享导出、gateway集成和联合安全验收尚未进行。T02认为T03无需触发，待主控集成后确认。
- T01补充官方证据：Seed3D的file_url返回ZIP（内含GLB），后续产物验收按ZIP及GLB检查；不是直接假定响应文件为GLB。
- 没有提交、推送、部署或新增付费调用。

## 6. 本轮集成结论（2026-10-14）

代码提交 `e7ac6a14150165edf8e53d13d03cf1ad3ebc6003`。主控 20 个定向测试文件 677/677、Shared/Core/Gateway typecheck、Admin check、相关包构建全部通过。两子任务的原始 SHA、集成 SHA、命令、日志哈希与真实调用限制见 [集成验收记录](ark-media-integration-evidence.md)。用户调用指南见 [Ark media](ark-media.md)。T13 单独受阻，未推送、未运行远端 CI、未部署。
