# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。

---

## 2026-05-31 · e2e.admin — 管理界面端到端（task e2e.admin、docs/11/07/04、原则1/5/7）

Playwright 规格 `apps/gateway/e2e/admin.spec.ts` + 凭证/seed fixture `apps/gateway/e2e/fixtures/admin.ts`，跑在**真实 Hono 网关 + 构建后的 adapter-static SPA**（`apps/admin/build`）之上，不打桩前端。覆盖 4 件事：Basic Auth 三态（无/错/对）、编辑 lane 并刷新后仍在、请求列表→详情决策链可见、脱敏冒烟（明文 key 不出现）。先红后绿，`pnpm test:e2e` 全 33 绿（含既有 protocol/routing/eval/smoke）。

为让 e2e 在真实链路上成立，做了以下决定/小改（均向后兼容，单测 672 全绿）：

- **`HELM_ADMIN_ENABLED` 环境变量开关（env-priority，docs/11「环境变量优先」）**：`HelmConfigSchema` 没有 `admin` 段，`resolveAdminAuth` 之前只能由 `config.admin.enabled` 开启 → 纯靠 env 注入凭证无法把 admin 打开（`enabled` 恒 false → basicAuth 直接放行，无从测认证闸门）。给 `resolveAdminAuth` 增加 `HELM_ADMIN_ENABLED`（`1/true/yes/on`）覆盖 `admin.enabled`，与既有 `HELM_ADMIN_USER/PASSWORD` 同为 env 优先。`resolveAdminAuth({},{})` 仍 → `enabled:false`，旧断言不变。容器部署也因此能纯靠 env 开启并配置 admin，不必改文件（docs/10）。
- **`GET /admin/api/requests` 改为返回完整 `DecisionRecord[]`（原 `RequestSummary[]` 4 字段）**：admin.requests-ui 的列表页 `lib/api/requests.ts#toListItem` 读取的是富 `DecisionRecord` 字段（`classifier.decided_by`、`lane.selected_lane`、`provider_attempts` 求和成本…），而旧后端列表只投影 4 字段且 `lane` 是顶层字符串而非 `lane.selected_lane` → 列表 `decided_by/lane/成本` 全部落空。决定让列表与详情一致返回**已脱敏的整条记录**（它本就不含明文 key/payload，原则7），前端保持纯消费者（原则1）、两种 fallback 不被后端重投影混淆（原则5）。`admin.test.ts` 列表断言同步改为读 `lane.selected_lane`/`classifier.decided_by`/`provider_attempts[0].cost_usd`；移除 `deps.ts` 中已无用的 `RequestSummary`。
- **Playwright `webServer.cwd` 固定为仓库根**：`admin-static.ts` 的 `ADMIN_BUILD_ROOT='./apps/admin/build'` 相对**进程 cwd（约定为仓库根）**解析，而 Playwright 默认从配置目录 `apps/gateway` 起 webServer → `/admin` 静态资源 404。给网关 webServer 加 `cwd: <repo root>`（由 `import.meta.url` 解析），并把 `HELM_DATA_DIR` 改为 `./apps/gateway/.e2e-data` 保持产物本地化。
- **认证闸门分两个 Playwright project**：带 `httpCredentials` 的 APIRequestContext 会在收到 401 挑战时**自动重试并补上凭证**，会把「无凭证 → 401」掩盖成 200。故 `@noauth` 三态用例放在**无凭证的 `admin-noauth` project**（`grep:/@noauth/`），页面流程放在带凭证的 `admin` project（`grepInvert:/@noauth/`）。
- **seed**：`test-server.ts` 在建库阶段额外 `SqliteTelemetryStore.insert` 一条预置决策记录（`trace_id=e2e-admin-trace-1`、lane=premium、候选链 [premium,balanced]、一次成功 provider 尝试、成本 0.0021），供请求列表/详情断言；不实际打上游。lane 编辑用 `DEFAULT_LANES` 已有的 `economy`（运行时无 `coding` lane；task 文案「coding/balanced」为示例，编辑任一既有 lane 即可验证回写持久化）。
- **成功提示**：`LaneEditor.svelte` 增加每卡片 `data-testid="lane-saved"` 的「Saved」指示（保存 resolve 后置位；页面 `handleSave` 失败时改为 re-throw，使指示只在真成功时出现——fail-closed UX）。`onsave` 类型放宽为 `=> void | Promise<void>` 以便 await。

---

## 2026-05-31 · admin.requests-ui — 请求列表 + 详情 Debug UI（task admin.requests-ui、docs/11、docs/07、原则5/7）

SvelteKit 路由 `apps/admin/src/routes/requests/`（列表 `+page.svelte`/`+page.ts` + 详情 `[traceId]/+page.svelte`/`+page.ts`）+ `lib/api/requests.ts`（API 客户端 + UI 类型）+ `lib/components/DecisionChain.svelte` + `lib/components/CostBreakdown.svelte`。先红后绿：`routes/requests/requests.test.ts` + `lib/components/DecisionChain.test.ts` 覆盖 task 8 条 TDD 断言，全绿。

**对齐真实后端契约的偏离（DoD：admin 仅经 `/admin/api/*`，后端是唯一真相源；前端只读渲染，绝不重算）**：

- **后端实测形状远薄于 task 的理想契约**：`apps/gateway/src/routes/admin/requests.ts` 列表返回 `RequestSummary = { trace_id, lane, status, cost }`（仅 4 字段），详情返回**原始 `DecisionRecord`**（`@helm/shared`，字段：`request_id/trace_id/requested_model/classifier{task_type,complexity,confidence,decided_by,eval_cache_hit,fallback_reason?,constraints,explanation}/policy{matched_policy_id,reason}/lane{selected_lane,candidate_chain}/provider_attempts[]{alias,skipped,skip_reason,status,error_class,latency_ms,cost_usd}/final{model_alias,provider_model,status,error_reason}`）。task 接口块里的 `ts/key_prefix/user_id/org_id/task_type/complexity/decided_by/final_model/fallback_count/latency_ms/error_class`（列表）与 `request_meta/payload_summary/matched_dimensions/eval_triggered/response_meta/error{http_status,message,provider_raw}/cost_breakdown{routing/eval/completion/total}`（详情）**后端尚未记录**。
- **决定：API 客户端在 HTTP 边界把真实后端形状映射成 task 的 UI 契约类型，缺失字段以 `DecisionRecord` 现有字段派生或安全默认**，而非伪造数据：
  - 列表 `RequestListItem`：`decided_by ← classifier.decided_by`、`task_type/complexity ← classifier`、`final_model ← final.model_alias`、`fallback_count ← provider_attempts 里非 skipped 的尝试数 - 1`（执行兜底次数，clamp≥0）、`status ← final.status`、`cost_usd ← Σ provider_attempts.cost_usd`、`error_class ← final.status==='error' 时取 final.error_reason / 末次 attempt.error_class`。`ts/latency_ms ← Σ attempts.latency_ms`；`key_prefix` 后端未记录 → 客户端置 `'—'`（绝不显明文，原则7）。
  - 详情 `RequestDetail`：`classifier_output.matched_dimensions ← classifier.explanation.map(String)`、`constraints ← classifier.constraints`（投影成 `Record<string,boolean>`）、`eval_triggered ← classifier.decided_by==='eval' || eval_cache_hit!==null`、`eval_cache_hit ← classifier.eval_cache_hit`、`matched_policy ← policy.matched_policy_id`、`lane_candidates ← lane.candidate_chain`、`provider_attempts` 映射（`outcome ← skipped?'skipped':status`、`provider ← provider_model 或 alias`、`model ← alias`）、`error ← final.status==='error'` 时合成 `{error_class: final.error_reason, http_status:0, message: final.error_reason(脱敏), provider_raw:null}`、`cost_breakdown ← { completion_usd: Σ attempts.cost_usd, routing_usd:0, eval_usd:0, total_usd: 同 completion }`（后端暂未拆分 routing/eval 自身成本，先全部归 completion，字段齐全可见）。`payload_summary` 后端不记录 → 显占位摘要文案（绝不显完整 payload，原则7）。
- **分页**：后端 `GET /requests` 暂不支持 cursor，仅 `DEFAULT_LIMIT=100`。`listRequests` 仍按 task 契约返回 `{ items, nextCursor? }`，`nextCursor` 恒为 `undefined`（无更多页）。列表页空态 + 「加载更多」按钮在 `nextCursor` 存在时才可用（当前后端下永远隐藏；测试用 mock 注入 `nextCursor` 验证按钮逻辑）。
- **两类 fallback 严格分列（原则5）**：UI 用 `decided_by`（rules/eval/default/fallback 标签，分类层级）与 `provider_attempts`/`fallback_count`（执行兜底）分区展示，DecisionChain 组件里分两个 section，绝不混淆。
- **脱敏（原则7）**：列表 key 列显 `key_prefix`（后端未记录时 '—'，永不明文）；详情 `payload_summary` 仅摘要占位、`provider_raw` 脱敏（合成时置 null）；`trace_id` 是唯一关联锚点，提供复制按钮。

## 2026-05-31 · admin.keys-ui — API Key 管理视图（task admin.keys-ui、docs/11、docs/06、原则7）

SvelteKit 路由 `apps/admin/src/routes/keys/`（`+page.svelte`/`+page.ts`）+ `lib/api/keys.ts`（API 客户端 + 类型）+ `lib/components/CreateKeyDialog.svelte`（创建表单 + 一次性明文展示）。先红后绿：`lib/api/keys.test.ts`(6) + `lib/components/CreateKeyDialog.test.ts`(4) + `routes/keys/keys.test.ts`(5) 共 15 例，全绿。关键决定与**对齐真实后端契约的偏离**（DoD：admin 仅经 `/admin/api/*`，后端是唯一真相源）：

- **客户端契约以 `apps/gateway/admin/keys.ts` 实测为准（偏离 task 接口块）**：task 契约写的若干字段/动作与已落地的后端不符，**以后端为准**——
  - **吊销 = `DELETE /admin/api/keys/:id` → `{ revoked: id }`**（200），**不是** task 写的 `POST .../revoke` 返回 `ApiKeyView`。后端不回传记录，故 UI 在 `revokeKey` 成功后**本地**把该行 `disabled:true`（呼应轮转语义：生成新 + 旧 disabled、不就地改写；行不移除）。
  - **role 枚举是 `'root' | 'user'`**（服务端 `KeyRoleSchema`），**不是** task 写的 `'root' | 'standard'`。
  - **POST 创建返回 `{ key_id, plaintext }`**（201），**不含**完整 `key` 视图；请求体是 `{ role, max_lane?, allowed_lanes?, allow_custom_model? }`（服务端 `CreateKeyRequestSchema` 是 `.strict()`，无 `account_id`/`org`/`user` 字段——MVP 单账户，account 由网关注入）。故 `CreateKeyInput` 去掉 task 的 `account_id/org_id/user_id`。
  - **GET 列表投影 `KeySummary` = `{ key_id, prefix, role, max_lane, allowed_lanes, allow_custom_model, disabled }`**，后端**不返回** `account_id`/`org_id`/`user_id`/`created_at`，故 `ApiKeyView` 去掉这些字段（task 契约里有，但列表展示不到）。
- **明文一次性 + 关闭即焚（原则7 / docs/06 红线）**：明文仅活在 `CreateKeyDialog` 的瞬态 `$state revealed`。展示框 `data-testid="plaintext-reveal"` 显示一次 + 「Copy」（`navigator.clipboard`，不可用则静默降级、绝不把明文塞进错误信息）+「I saved it」确认。确认即 `revealed=null` 清栈、`onclose()`，明文从 DOM/组件状态彻底消失，无法二次查看。专项断言：关闭后 `document.body.textContent` 不含明文、`oncreated` bubble 的 view 序列化后不含明文。
- **bubble 的 redacted view 用明文前 14 字符当 prefix 占位**：创建响应不带 prefix，新行先用 `plaintext.slice(0,14)`（即 `helm_live_xxxx` 形态，**非完整明文**）占位，下次 `load` 再从服务端列表回填真实 prefix。测试用 `/helm_live_[A-Za-z0-9]{16,}/` 断言列表里**无**长明文串（占位 14 字符不触发，真明文 28 字符会触发）。
- **admin 不 import core，类型自持**：沿用 lanes/policies-ui 约定，`lib/api/keys.ts` 自定义 `ApiKeyView`/`CreateKeyInput`/`CreatedKey`/`RevokeResult`（UI 契约），role 枚举镜像服务端 `KeyRoleSchema`。`normalizeView` 防御性剥离任何 `hash`/`plaintext`（纵深防御：即便服务端响应变形也不漏密）。
- **失败 fail-closed**：`createKey` reject → 弹框内 `role="alert"`，**不进入**明文展示态、DOM 无半截明文；`revokeKey` reject → 页面 `role="alert"`，行不变（仍 active，不被脏写）。
- **root key 警示（docs/06）**：列表中 role=root 行渲染 `data-testid="root-warning"`「Management plane only — do not feed production traffic」；创建弹框选 root 时同样给提示。
- **门禁（全绿）**：`pnpm typecheck`=0（admin 走 `svelte-check`=0/0/0）、`pnpm lint`=0（Biome 排除 `apps/admin`；14 条既有 warning 与本任务无关）、`pnpm test`=656/656（含本任务 15 例）、`pnpm build`=0、Prettier+prettier-plugin-svelte 对新文件全绿。**未跑 e2e**（本任务非 e2e.*，无 Playwright spec）。

---

## 2026-05-31 · admin.policies-ui — 策略管理视图（task admin.policies-ui、docs/11、docs/04、docs/03）

SvelteKit 路由 `apps/admin/src/routes/policies/`（`+page.svelte`/`+page.ts`）+ `lib/api/policies.ts`（API 客户端 + 类型 + 枚举）+ `lib/components/PolicyRow.svelte`（单条规则行）。先红后绿：`lib/api/policies.test.ts`(4) + `lib/components/PolicyRow.test.ts`(6) + `routes/policies/policies.test.ts`(6) 共 16 例，全绿。关键决定与偏离：

- **complexity 枚举对齐服务端 schema（偏离 task/docs/03）**：task 契约与 docs/03 写 `complexity ∈ {simple,standard,complex,reasoning}`，但运行时真正的 gatekeeper 是 `@helm/core` 的 `PolicyMatchSchema`，其 `complexity` 为 `z.enum(["simple","medium","complex"])`（`.strict()`）。DoD 要求 PUT 必须被服务端接受、非法值 fail-closed(400)。若 UI 提供 `standard`/`reasoning`，保存即被服务端拒。故 `COMPLEXITY_OPTIONS = ["simple","medium","complex"]` **以服务端 schema 为准**。`TASK_TYPE_OPTIONS` 取 docs/03 / core `TaskType` 的 9 值（服务端该字段是 `z.string()`，不约束，仍以 docs/03 集合做下拉防脏数据）。后续若统一 complexity 口径，改 core schema + 此常量一处即可。
- **admin 不 import core，类型/枚举自持**：与 lanes-ui 同理，`lib/api/policies.ts` 自定义 `Policy`/`PolicyMatch` 与两组 `as const` 枚举（UI 契约），不加 `@helm/core` 依赖（DoD：admin 仅经 `/admin/api/*`）。
- **整表 PUT 保序 + 动作互斥在 HTTP 边界归一**：wire shape 是裸有序 `Policy[]`（服务端 `admin/policies.ts` PUT 整表替换、`PoliciesConfigSchema` 校验）。`savePolicies` 整表提交保序（顺序=first-match 优先级）。`toServerBody` 只发被选中的那个动作（use_lane 优先），并剥掉空 match 字段——服务端 `PolicyMatchSchema` 是 `.strict()`，多余/空字段会 400。
- **PolicyRow 本地累积 state**：行内 `match`/`useLane`/`maxLane`/`action` 用 `$state`（`untrack` 从 prop 初值播种，沿用 LaneEditor 约定），每次编辑 bubble 整条 policy 上去，父组件 owns 有序列表。这样组件单测里（父不回灌 props）连续两次 `change`（task_type→complexity）也能累积进同一条 payload。
- **动作互斥用「点击即激活」的双 select**：测试用 `getByLabelText(/use lane|max lane/i)` 同一元素既要可点击切换、又要 `.toBeDisabled()` 可断言、还要能 `fireEvent.change` 设值——只有 `<select>`（`aria-label`）满足。故弃用 radio：两个 `<select>`（aria-label `use lane`/`max lane`），`onclick` 切换 active action、`onchange` 设值，非激活的那个 `disabled`（满足 `toBeDisabled`）。jsdom 下对 disabled select 的 `fireEvent.click` 仍触发 onclick，故切换可用。
- **first-match 文案禁用打分词**：测试断言 explainer 文案匹配 first-match/自上而下 但 **不得**出现 `score|scoring|打分`（原则4：不藏打分魔法）。措辞改为「apply in plain order, not by any weighting」。
- **空 match 兜底告警**：`PolicyRow` 在 `Object.keys(match).length===0` 时渲染 `data-testid="catch-all-warning"` 琥珀色提示「matches every request… keep it last」，避免误置表首吞掉后续规则。

---

## 2026-05-31 · admin.lanes-ui — Lane 管理视图（task admin.lanes-ui、docs/11、docs/04）

SvelteKit 路由 `apps/admin/src/routes/lanes/`（`+page.svelte`/`+page.ts`）+ `lib/api/lanes.ts`（API 客户端）+ `lib/components/LaneEditor.svelte`（单条 lane 表单）。先红后绿：`lib/api/lanes.test.ts`(3) + `lib/components/LaneEditor.test.ts`(5) + `routes/lanes/lanes.test.ts`(4) 共 12 例（Vitest + @testing-library/svelte），全绿。关键决定与偏离：

- **admin 测试链的版本对齐（被迫升级）**：admin 之前的 scaffold 钉死 `vite@^8` + `@sveltejs/vite-plugin-svelte@^7`（plugin v7 peer 仅 `vite ^8`）。但仓库 `pnpm test` 用根 `vitest`，**vitest 2.x 内置 vite 5**，启动 svelte 插件的 `configureServer` 钩子即崩（`Object.values(undefined)`）。vitest 3.x 内置 vite 6/7，**仍非 vite 8**——三者无交集。解决：整仓 `vitest` 升 `^3.2.4`（+`@vitest/coverage-v8@^3.2.4`），admin 的 `vite` 降到 `^7`、`@sveltejs/vite-plugin-svelte` 降到 `^6`（peer=`vite ^6.3||^7`）。SvelteKit 2.61.1 接受 plugin v6 + vite 7，build 仍绿。代价：admin 不再用 vite 8（与 scaffold note 的 v8 决定相左），但这是让「`.svelte` 组件测试能在统一 `pnpm test` 里跑」的唯一可行版本组合。后续若升 vite 8，需等 vitest 出 vite-8 内置版本。
- **根 `vitest.config.ts` 改用 `test.projects`（多项目）**：原本单 `include`+`environment:node`。现拆成两个 project：`node`（packages/** + apps/gateway/** + scripts/**，node 环境、`better-sqlite3` external）与 `./apps/admin/vitest.config.ts`（jsdom + svelte 编译 + @testing-library，`globals:true`、`setupFiles` 引 jest-dom）。`apps/admin` **从 node project 显式剔除**——否则它的 `.svelte` import 进 node 环境必崩。一条 `vitest run` 同时跑两套（615 例全绿，其中本任务 12 例）。
- **admin 不 import core 业务逻辑，UI 类型自持（偏离 task 契约的「z.infer from shared」）**：task 契约块要求「类型从 shared 的 Zod schema z.infer」，但 (1) admin 是浏览器 SPA，给它加 `@helm/core` 依赖只为取类型，与 DoD「admin 不 import 任何 core/网关业务逻辑」张力大；(2) core 的 `LaneConstraints.max_latency_ms` 是 `number | undefined`（`.optional()`），而 task 的 UI 契约明确要 `number | null`（null=已清空），口径不一致。故 `lib/api/lanes.ts` **按 task 的 UI 契约自定义** `Lane`/`LaneConstraints`（`max_latency_ms: number | null` + `[extra]: unknown` 索引签名兜住服务端的 `require_vision`/`min_context_tokens`），并在 HTTP 边界做翻译：`toServerBody` 丢 `name`（服务端 `LaneSchema` 是 strictObject，多字段即 400 fail-closed）、`max_latency_ms===null` 时**省略该键**（而非传 null，否则 strictObject 的 `z.number().positive()` 会拒）。服务端的额外 constraint 字段经索引签名**原样回传**，PUT 不丢字段。已把 `@helm/core` 依赖移除，admin 现零 `@helm` 依赖。
- **GET 投影 vs PUT 契约**：服务端 `GET /admin/api/lanes` 返回 `[{name, ...lane}]`、`PUT /admin/api/lanes/:name` 收**裸 Lane**（无 name）。客户端 `listLanes` 把每行 normalize 成带 name 的 UI Lane；`saveLane(name, lane)` PUT 时剥 name。task 契约写的 `saveLane(name, body): Promise<Lane>` 照此实现。
- **整条 lane PUT（非 patch）**：呼应 task「避免并发 patch 丢字段」。`+page.svelte` 保存成功用服务端回显（`saved ?? body` 兜底空响应）替换列表项；**失败 fail-closed**——`role="alert"` 提示且**不改列表**（编辑器持本地副本，原值不被脏写），呼应原则 3 的 UI 侧落地。
- **balanced 护栏（docs/04 红线）= 纯前端表单校验**：`LaneEditor` 对所有 lane 要求 primary 非空（`$derived` 的 `valid`），primary 清空即禁用 Save 且渲染 `role="alert"`；`balanced` 的提示文案特别点出「分类兜底终点」。**UI 只做表单校验**（非空/数字/护栏），不做路由仿真或能力过滤（那是 core 的事，原则 1/6）。
- **Svelte 5 `state_referenced_locally` 告警清零**：`LaneEditor` 需从 prop `lane` 播种本地可编辑 `$state`，直接 `$state(lane.x)` 会触发「只捕获初值」告警。用 `untrack(() => lane)` 取一次初值存 `const initial`，再据此播种——语义即「编辑器拥有自身状态、父级靠 keyed `{#each}` 重挂喂新 prop」。`+page.svelte` 的 `lanes` 同法 `untrack(() => data.lanes)`。`svelte-check` 0 error 0 warning。
- **jest-dom 类型**：`src/vitest-env.d.ts` 加 `/// <reference types="@testing-library/jest-dom/vitest" />`，让 `svelte-check`(tsc) 认得 `toBeInTheDocument`/`toBeDisabled`/`toHaveTextContent`。`vitest.setup.ts` 引 `@testing-library/jest-dom/vitest` 注入 matcher。
- **`$lib` alias 显式补**：standalone admin vitest config（非 SvelteKit 插件）不自带 `$lib`，故在 `resolve.alias` 手动指 `./src/lib`。
- **门禁（全绿）**：`pnpm typecheck`=0（admin 无 typecheck 脚本，走 `svelte-check`=0/0）、`pnpm lint`=0（Biome 天然排除 `apps/admin`；14 条既有 warning 与本任务无关）、`pnpm test`=615/615（含本任务 12 例）、`pnpm build`=0（admin `vite build` 含）、Prettier+prettier-plugin-svelte 对新文件 `--check` 全绿。**未跑 e2e**（本任务非 e2e.*，无 Playwright spec）。

---

## 2026-05-31 · admin.api — 管理 API 端点（task admin.api、docs/11、docs/06、docs/07）

- **rule 配置落点 = 运行时 ConfigStore，非 YAML 写回（MVP）**：task 允许「config/*.yaml 或运行时 ConfigStore」。lanes/policies/classifier 写入走新建的 `apps/gateway/src/routes/admin/rule-store.ts`（`createRuntimeRuleStore`）——更新进程内活配置，路由的 `route` 闭包按 `let` 绑定即时读到新值，无需重启。未做 YAML 文件写回：当前 `server.ts` 的 lanes 来自 `DEFAULT_LANES`、policies 为空数组，本就未从 yaml 加载；做文件写回需改 config-loader（超出本 task）。路由只依赖 `RuleStore` 接口，后续替换为 YAML 适配器不动路由（原则1）。
- **classifier 编辑暂不热生效于路由**：`buildClassifyAdapter` 在启动时用 `config.classifier` 构建一次；admin 改 classifier 经 RuleStore 保存并可回读，但重建 classify 闭包未接线（需要重新实例化 eval cache 等）。MVP 取舍：classifier 写入可持久于 store、GET 反映改动，路由层热加载留 TODO。
- **新增 `CreateKeyRequestSchema` 到 `@helm/shared`（key/schema.ts）**：admin 建 key 的请求体（`role`+`max_lane?`+`allowed_lanes?`+`allow_custom_model?`，`.strict()` fail-closed）。放 shared 是因 gateway 未直接依赖 zod，且「schema 是类型唯一来源」——校验 schema 应在 shared，不在路由里手写。
- **routes 为纯 HTTP glue + 注入依赖**：沿用 `messages.ts` 的模式，`AdminApiDeps`（`apps/gateway/src/routes/admin/deps.ts`）注入 RuleStore/KeyStore/TelemetryStore/genKey/genKeyId/accountId。测试用内存 fake，零 IO，core 不 import Hono。
- **basicAuth 由 caller 挂在 `/admin/api/*`**：`registerAdminApi` 只注册端点；`index.ts` 不自带中间件，鉴权隔离由 `server.ts`（`app.use("/admin/api/*", basicAuth(resolveAdminAuth(...)))`）保证。`resolveAdminAuth` 读 `config.admin`，但 HelmConfig schema 尚无 `admin` 块（属 admin.auth task），此处 `config as { admin?: ... }` 收窄，env（HELM_ADMIN_USER/PASSWORD）仍可注入凭证。
- **key 不回显**：list 投影为 `KeySummary`（仅 prefix，无 hash/明文）；POST 仅此一次返回 `{key_id, plaintext}`（201）。吊销 = `disable()` 软置 `disabled:true`，不物删不就地改写（测试断言除 disabled 外字段不变）。
- **requests 只读**：返回完整（已脱敏的）`DecisionRecord` 作详情，含分类层级/命中策略/lane 候选链/provider 尝试/成本/trace_id（docs/07），无明文 key/payload。列表按 `queryRecent` 最近优先，默认 limit 100。

---

## 2026-05-31 · admin.scaffold — SvelteKit 脚手架的取舍（task admin.scaffold、CLAUDE.md 技术栈表）

- **Tailwind v3，不用 v4**：spec 的接口契约明确给出 `tailwind.config.ts` + `postcss.config.js` + `app.css` 用 `@tailwind base/components/utilities` 指令——这是 Tailwind v3 的写法。Tailwind v4 改用 `@import "tailwindcss"` + `@tailwindcss/vite` 插件、无需 config 文件，会与 spec 给定的文件清单冲突。为忠实于 spec，固定 `tailwindcss@^3.4.19`（v3-lts）+ `autoprefixer` + `postcss`。后续如要升 v4 需同步改 spec。
- **新增 spec 未列的 SvelteKit 必需文件**：`src/routes/+layout.svelte`（import `app.css`，否则 Tailwind 不进 bundle）、`src/app.d.ts`（SvelteKit `App` 命名空间类型）、`.gitignore`（忽略 `/build`、`/.svelte-kit`）、`static/.gitkeep`。spec 的 `+layout.ts` 只放 `ssr=false/prerender=false`，无法挂载样式，故补 `+layout.svelte`。
- **tsconfig 继承的是 `./.svelte-kit/tsconfig.json` 而非根 `tsconfig.base.json`**：SvelteKit 的 `svelte-kit sync` 会生成包含路由别名/`$lib` 等的 tsconfig，admin 必须继承它；根 base config 面向 Node 库（`module: NodeNext`、`types:[node]`），不适用于浏览器 SPA。因此 admin 不复用根 TS 基线——这是 SvelteKit 工具链的硬约束，与「core/shared/gateway 用 Biome+根 tsconfig」隔离开，符合 CLAUDE.md「.svelte 走 svelte 原生工具链」。
- **`check` 脚本前置 `svelte-kit sync`**：svelte-check 依赖 `.svelte-kit/` 生成产物，clean checkout 下未 build 过会报错；故 `check` = `svelte-kit sync && svelte-check`。
- **Biome 已天然排除 admin**：根 `biome.json` 的 `files.includes` 仅含 `apps/**/*.ts` 且显式 `!apps/admin`，无需再追加 `*.svelte` 忽略项（spec 第 5 点的目标已由现有配置满足）。
- **未做单测**：admin 是脚手架，按 spec 用「构建产物断言」替代单测——已验证 `build/index.html` 存在且资源引用前缀含 `/admin`（11 处），svelte-check 0 错误。vitest `include` 只匹配 `*.test.ts`，admin 的 SPA 文件天然不进单测套件。

## 2026-05-31 · e2e.eval — 把 eval 三层级联接进网关并端到端验证（docs/03、原则 3/4/5/7、task e2e.eval）

`apps/gateway/e2e/eval.spec.ts` 7 场景全绿。本任务发现 `eval.cascade` 模块（core 内 `classifier/cascade.ts`）虽已存在，但**从未接进网关**——`server.ts` 的 `buildClassify` 只跑 Layer-1 `scoreRequest`，eval/缓存/兜底字段从未暴露。因此本任务做了「接线 + e2e」两件事。关键决定与偏离：

- **接线落点 `apps/gateway/src/routes/classify.ts`（新建 `buildClassifyAdapter`）**：把 core 的 `classifyCascade` + `runEvalCached`（eval client/cache）+ `resolveLane` 组装成 routeRequest 的 `classify` 适配器，holds 一个进程内 eval cache（content-hash 键、TTL+LRU）。eval 小模型经**同一个 provider**、用 eval alias（`deepseek/deepseek-v4-flash`，config 默认）非流式调用——alias 是内部供应链细节（原则 6），不进 lane 抽象。`server.ts` 的旧 `buildClassify`/`mapComplexity`/`approxTokens`/`hasNoTextContent` 整体迁入此模块。
- **决策可观测面 = 响应头**（沿用 e2e.routing 的 `x-helm-*` 既有约定）：`chat.ts` 新增 `x-helm-decided-by`（rules|eval|fallback|default）、`x-helm-eval-cache-hit`（仅 eval 真跑时出现）、`x-helm-fallback-reason`（仅 `decided_by=fallback` 出现：`eval_disabled` / `eval_<timeout|provider_error|...>`）。缓存命中断言以**mock eval 端点调用计数**为最硬证据（`/__eval_count` + `/__eval_reset`），辅以 `eval-cache-hit` 头。所有头只载路由/决策元数据，绝不含明文 key/payload（原则 7）。
- **schema 扩展（最小）**：`@helm/shared` 的 `DecidedBySchema` 加 `"fallback"`（与既有 `"default"` 并存：`default`=classify 自身抛错的硬 fail-open；`fallback`=Layer-3 级联兜底，两路各自可观测）；`ClassifierDecisionSchema` 加 `fallback_reason: z.string().nullable().optional()`（optional 以免 Phase 0/passthrough 既有记录失效）。`routing/route-request.ts` 的 `Classification` 与 `routing/lane-resolver.ts` 同步加 `"fallback"`（resolver 把 `fallback` 与 `default` 一样直接钉 balanced），并把 `eval_cache_hit`/`fallback_reason` 透传进决策记录。
- **e2e 触发 eval 的硬约束 — 必须抬高 Layer-1 阈值**：Layer-1 的 `sigmoidConfidence` 落域是 **[0.5,1)**（仅 NaN 退化态返回 0），故在默认阈值 0.45 下**任何自然 prompt 都不会 uncertain**，eval 层在黑盒下根本无法触达。解决：新增 e2e-only 请求头 `x-helm-rules-threshold`（与 `x-helm-eval` 一样受 `HELM_E2E` 网关侧开关 gating），按请求抬高 Layer-1 阈值到 0.7——AMBIGUOUS prompt（rules conf ~0.53）落到 eval，STRONG prompt（~0.98）仍命中即停。**不改签入的 `config/classifier.yaml`（保持 spec 默认 0.45）**，也不全局改阈值（否则会打破 `routing.spec` 的 economy/premium 期望，其 simple prompt conf≈0.585）。生产从不设 `HELM_E2E`，分类仍 config 驱动、fail-closed（原则 2）。
- **eval 开关同样走 per-request 头 `x-helm-eval`**（HELM_E2E gated），免去「改 yaml + 重启」才能切 eval——Playwright 单进程双 webServer 模型下无法每用例重载 config。默认（无头）= eval OFF（原则 4）。
- **缓存跨用例不串台**：网关的 eval cache 是进程级、跨用例存活；mock 的计数器每用例 `beforeEach` 重置。两者一旦错位，"first 调用"会被上一个用例的缓存命中污染。解决：每个缓存敏感用例用 `ambiguous(tag)` 生成**内容唯一但仍低置信**的 prompt（content-hash 键天然区分），场景 3 的「相同重发」两请求共用同一 tag。
- **桩上游扩展**：`mock-upstream.ts` 的 `createMockUpstream` 内加 eval 小模型替身——识别 `model===EVAL_MODEL` 后**先计数再**按 `EVAL_SLOW_SENTINEL` 决定正常/慢（慢延迟 2s > eval 双超时 300/250ms）；正常返回严格 JSON `{complexity:"reasoning",task_type:"math",confidence:0.91}`→驱动 premium（**刻意不同于 balanced 兜底**，证明「eval 真改了 lane」）。eval 调用不进 `CAPTURE_PATH`（捕获只跟主路由请求）。
- **顺手修复阻塞 typecheck 的邻接 eval 模块遗留错误**（这些文件由 eval.config/contract/client/cache/cascade 等前置任务新增、未提交且未跑组合 typecheck）：`eval/client.ts` 的 `CircuitOpenError.name` 加 `override`；`cascade.test.ts` 把 `ClassifierInput` 的 `tools/response_format/attachments` 由 `undefined` 改 `null`（Pick 字段可空非可选）；`cache-key.test.ts` 的 `makeInput` 入参类型 `Partial<ClassifierInput>`→`Partial<InternalRequest>`（测试要传 request_id 等易变字段证明不影响键）；`client.test.ts` 的 mock 补 `(_req,_signal)` 形参以让 `mock.calls[0]` 有类型 + `!`。纯类型/防御修复，零行为变更。core `index.ts` 新增导出：cascade（`classifyCascade`/`CascadeResult`/...）、eval cache/client/cache-key、`resolveLane`（别名 `LaneResolver*` 避免与 route-request 的 `Classification` 撞名）。
- **门禁（全绿）**：`pnpm typecheck`=0、`pnpm lint`=0（仅 14 条既有 warning）、`pnpm test`=564/564（含 eval 模块单测随类型修复转绿，552→564）、`pnpm build`=0、`pnpm test:e2e`=27/27（含本任务 7 例）。
- **TODO / 坑**：(1) eval 默认阈值 0.45 下级联第 2 层**实际不可达**（sigmoid 下限 0.5）——这是 docs/03 阈值口径与 Layer-1 打分实现之间的张力，需后续要么降 Layer-1 下限、要么把「uncertain」改由 rawScore 边界距离判定而非置信度阈值，本任务用 e2e 头规避但未根治。(2) eval 小模型 alias 当前不在 provider registry 里（直接经 `provider.chatCompletion` 打到同一 base_url）——多 provider/多模型 registry 落地后应把 eval alias 纳入正式解析。

## 2026-05-31 · eval.cascade — 三层分类级联总装（docs/03 分类级联、原则 3/4/5、task eval.cascade）

- **`CascadeDeps.resolveLane` 用「理想化签名」`(complexity, taskType, input) => LaneId`，而非真实 `routing.lane-resolver` 的 `resolveLane(ResolveLaneInput): LaneDecision`。** 理由：cascade 只需「给我一个 lane 字符串」，不应感知 policy/lanes 配置或 LaneDecision 的 `decided_by`（那是 lane 解析自己的内部来源，与分类级的 `decided_by` 是两回事，硬塞会混淆原则 5）。真实 resolver 的适配（构造 ResolveLaneInput、把 LaneDecision.selected_lane 取出）留给后续的 pipeline 接线任务，cascade 通过注入保持纯净可测。
- **`ClassificationResult` 名称与 `classifier.engine` 已导出的同名类型冲突**，故在 `classifier/index.ts` 桶里把 cascade 的导出别名为 `CascadeResult`（文件内仍按 task 契约叫 `ClassificationResult`）。两者形状不同：engine 的是 Layer-1 富结果（含 constraints/explanation/uncertain），cascade 的是接线后的决策记录（含 lane/decided_by/eval_*）。
- **`LaneId` 定义为 `string`**：仓库无现成 LaneId 类型，lane 是 lanes.yaml 的开放键（`balanced` 保证存在）。
- **fail-open 复用下层语义**：cascade 自身不 try/catch——rules 是纯函数、`runEvalCached` 已在 client 层 fail-open 永不抛；最坏落 balanced。`eval_cache_hit` 仅在 `eval_used===true` 有意义，未用 eval 恒 `false`（不留 undefined 含糊态）。
- **`fallback_reason` 口径**：`eval_disabled`（开关关）vs `eval_${reason}`（开启但失败，reason ∈ timeout/provider_error/circuit_open/not_json/schema_invalid），两种兜底各自可观测、绝不混 provider 执行兜底字段。

## 2026-05-31 · eval.cache — content-hash 缓存键 + TTL/LRU 容器（docs/03 Layer 2、原则 1/3/4、task eval.cache）

把 `runEval` 包成 `runEvalCached`，用规范化 content-hash 作键、带 TTL + LRU。决定与权衡：

- **`turn_count` 口径钉为「`role==="user"` 的消息条数」**：task 给了两个口径选项（user 条数 / messages 全量）。这里选 user 条数并在 `cache-key.ts` 处注释清楚，与 `last_user_message` 同源（都遍历 user 消息），避免与 `dimensions.ts` 里 `turnCount = messages.length`（那是 Layer-1 打分的归一化输入，语义不同）混淆。注意：本任务的缓存键口径与 `dimensions.ts` **有意不同**，因为缓存键要的是「逻辑相同请求」的稳定指纹，全量 messages 含 system/assistant 噪声会降命中率。
- **`ClassifierInput` 落为 `Pick<InternalRequest, "messages"|"tools"|"response_format"|"attachments">`**：spec 用 `ClassifierInput` 作 `buildEvalCacheKey` 入参类型，但仓内此前无此类型；沿用 `dimensions.ts`/`taskdetect.ts` 的 `Pick<InternalRequest, ...>` 既有约定，不新造重复接口（schema-first）。提取 tool 名 / attachment 判定 / response_format JSON 判定均复用与 `taskdetect.ts` 一致的防御式实现（开放 MVP shape，不抛）。
- **`runEvalCached` 的 deps 增 `nowMs`（注入时钟）与可选 `runEval` 覆盖**：容器内绝不调 `Date.now()`（TTL 可测）；`runEval` 默认指向真实 client，测试注入 stub。只有 `decided:true` 才写缓存——fail-open（timeout/抖动/circuit-open）不缓存，否则一次瞬时故障会被钉住 300s（原则 3）。命中返回 `latency_ms:0` + `cache_hit:true`。
- **LRU 用 `Map` 插入序实现**：`get` 命中与 `set` 均「delete + 重插」把键移到最近端，超容时淘汰迭代序首项（最久未用）。`get` 命中先查 `expireAt <= nowMs` 过期即删并 miss。
- **命中率观测（DoD 要求「实现后验命中率」）**：单测 `cache.test.ts` 实测——首次 miss 调 `runEval` 一次并写缓存；第二次「仅 trace_id/account/user/model/stream/conversation_id 不同」的逻辑相同请求 → `cache_hit:true` 且 `runEval` 不再被调（即同一逻辑请求命中率 100%）。`cache-key.test.ts` 进一步背书：tool 顺序无关、末条消息 trim 不 lowercase、5 字段任一语义变化即换键。真实流量命中率需上线后用遥测的 `eval_cache_hit` 字段观测；若偏低，按 `eval.config` 的可配字段集回调并在此追记。
- **门禁（全绿）**：`pnpm typecheck`=0、`pnpm lint`=0（仅 13 条既有 warning，非本任务文件）、`pnpm test`=552/552（含新增 19 例：`cache-key.test.ts` 14 + `cache.test.ts` 5）、`pnpm build`=0。core 不 import 任何 web 框架（纯内存 + node:crypto）。

---

## 2026-05-31 · eval.config — 硬化 eval 配置块 schema（docs/03 Layer 2、原则 2/4、task eval.config）

把 Layer-2（小模型 eval）配置块从「松」收紧为「硬」，并钉为下游 eval 模块的唯一类型来源。决定与偏离：

- **文件落点偏离 task 给的 `packages/shared/src/classifier/eval-config.schema.ts`，改用 `packages/shared/src/config/eval-config.schema.ts`**：本仓 shared 既有约定是所有 config schema 集中在 `config/`（`classifier-schema.ts`/`schema.ts` 等），不存在 `classifier/` 目录。遵从既有约定避免目录碎片，语义/契约不变。
- **复用而非新增 mount 点**：`ClassifierEvalConfigSchema` 此前已存在于 `classifier-schema.ts`（松定义：`temperature: z.number()`、`on_failure: z.string()`、`cache.key: z.string()`、无 `outer_timeout_ms`/`max_entries`、无 `max_tokens` 上限）。本任务把硬定义集中到新 `eval-config.schema.ts`（`EvalConfigSchema`/`EvalCacheConfigSchema`），并令 `ClassifierEvalConfigSchema = EvalConfigSchema`（别名再导出，保持既有 import 不破）。**绝不两处定义**（防默认值漂移）。
- **硬化点**：`enabled` 显式 `.default(false)`；`temperature`/`on_failure`/`cache.key` 用 `z.literal` 锁死（typo 即 fail-closed，不带病运行）；`max_tokens` 加 `.max(1024)`（research-notes：无上限是规模化成本风险）；新增 `outer_timeout_ms`（consumer 外层 race，双超时硬化）与 `cache.max_entries`（LRU 容量，留给 eval.cache）。
- **`model` 改为必填（`z.string().min(1)`，去掉原 `.default`）**：enabled eval 无 model 是「配置说谎」。代价：`ClassifierConfigSchema.eval` 与 `schema.ts` 的 `classifier` 两处 `prefault` 现需显式带默认 model 才能在 block 缺省时解析——已在 `classifier-schema.ts` 的 eval prefault 注入默认 model，并把 `schema.ts` 里多余的 `eval: {}` 删除（让内层 prefault 接管）。
- **`config/classifier.yaml` 补全**：eval 块新增 `outer_timeout_ms: 250` 与 `cache.max_entries: 5000`，并把 cache 从内联展开为块。`loadConfig({configDir:"config"})` 实测加载并通过校验（DoD）。
- **门禁（全绿）**：`pnpm typecheck`=0、`pnpm lint`=0（仅 warnings，core 既有）、`pnpm test`=514/514（含本任务新增 9 例 `eval-config.schema.test.ts`）、`pnpm build`=0。同步更新 `classifier-schema.test.ts` 既有 eval 用例与 `index.ts` 导出（新增 `EvalConfig`/`EvalCacheConfig`/`EvalConfigSchema`/`EvalCacheConfigSchema`）。

---

## 2026-05-31 · e2e.protocol — 接线 `/v1/messages`、桩上游 tool-call/捕获、修复邻接任务遗留的类型错误（docs/05、task e2e.protocol）

把 `e2e.protocol` 的双向（Anthropic/OpenAI 客户端）× 三路径（非流式/流式/tool-call）端到端打通。`apps/gateway/e2e/protocol.spec.ts` 8 个用例全绿（含「双向同构」：两协议归一化到同一上游请求形态）。关键决定：

- **实装 `gateway.anthropic-route` 留下的 pipeline 适配 TODO**：新增 `apps/gateway/src/routes/messages-pipeline.ts`（`createMessagesPipeline(route)`），桥接 `IR → InternalRequest → route() → OpenAI body/stream → Anthropic transformer`。`collect()` 把上游 OpenAI body 投影成 `IRResponse`（`openAIBodyToIR`）；`streamIR()` 把 provider 的**原始 OpenAI SSE 文本流**按空行边界解析成 chunk 对象（`parseOpenAISSE`，跨 chunk 缓冲、跳过 `[DONE]`、坏帧 fail-open）再喂给 core 的 `convertOpenAIStreamToAnthropic` 状态机，产出 Anthropic SSE 事件。`server.ts` 现已注册 `registerMessagesRoute`——上一个任务里「`app.ts` 暂未默认注册」的状态到此结束。
- **auth 中间件改挂 `/v1/chat/*`（原 `/v1/*`）**：全局 `authMiddleware` 返回 HelmError 形态；若它覆盖 `/v1/messages`，缺 key 用例就拿不到 Anthropic 错误信封。故把中间件收窄到 chat 面，`/v1/messages` 由路由内 `deps.auth.resolve`（命中 keyStore.getByHash）自鉴权，401 经 `makeAnthropicError` 翻成 `{type:"error",error:{type:"authentication_error"}}`。
- **桩上游扩展**：`mock-upstream.ts` 新增 `TOOL_CALL_SENTINEL`（prompt 触发 OpenAI function tool_call，流式版把 arguments 拆帧、id/name 只在首帧给，逼真考验 docs/05 坑#3 的 index/id 协调与残缺 JSON 累积）与 `CAPTURE_PATH=/__captured`（回读「Helm 发给上游的归一化请求」，证明 `nativeIn→IR→nativeOut`）。spec 经**绝对 URL**（`MOCK_PORT`，默认 8181）读捕获端点——它在桩上游而非网关 baseURL 上。
- **修复邻接任务（gateway.anthropic-route，#14）遗留、阻塞 `pnpm typecheck` 的 Zod v4 / `noUncheckedIndexedAccess` 类型错误**（这些文件当时未提交、基线 stash 后才暴露）：`anthropic/stream.ts` 的 `z.record(z.unknown())`→`z.record(z.string(), z.unknown())`（Zod v4 record 需双参）；`responses.ts` 迭代可空 content 前判空；`streaming.ts` `synthesizeSSE` 取帧判 undefined；多个 `*.test.ts` 的下标访问加 `!`。纯类型/防御性修复，零行为变更，全部 505 单测仍绿。这是为让本任务的 gate 全绿而做的最小越界——本任务运行时正依赖这条 Anthropic stream 链路。

---

## 2026-05-31 · gateway.anthropic-route 的依赖契约与错误翻译落点（docs/02、docs/05、task gateway.anthropic-route）

`apps/gateway/src/routes/messages.ts` 实装 `POST /v1/messages`。相对 task 给的伪代码做了几处明确决定，记录在此：

- **依赖以 `MessagesRouteDeps` 注入，auth 进 route 而非中间件**：task 伪代码写 `deps.auth.resolve(...)` 在路由内。现有 `authMiddleware`（chat 路由用）返回的是 **OpenAI** 错误形态，无法满足本任务"401 必须是 Anthropic 错误形态"的用例。因此 `/v1/messages` 的鉴权由路由内 `deps.auth.resolve` 完成，401 经 `transformErrorOut` 翻成 Anthropic 形态。代价：`/v1/messages` 不复用全局 auth 中间件，composition root 需单独给它注入 `auth`。仍满足"鉴权在翻译/路由之前、不得匿名穿透"。
- **`pipeline.run(ir, identity, signal)` 多了第三参 `signal`**：task 伪代码是两参。为满足"客户端断连(abort)不触发熔断"用例，路由把 `c.req.raw.signal` 透传给 pipeline，让 executor 把 abort 当非 provider 故障。这是对 task 契约的最小扩展，与 chat 路由把 signal 传给 `route()` 的既有约定一致。
- **`pipeline` 返回 `{ collect(), streamIR() }` 抽象，而非直接复用 `routeRequest`/`ExecutionResult`**：本任务范围只接线 Anthropic 一面，pipeline 的具体 IR 适配（IR→executor→IR）属其它任务。路由对结果只读这两个访问器，保持纯胶水；production composition root 负责把 `routeRequest` 的 `ExecutionResult` 适配成该形态。**该适配器尚未实装（TODO，留给 routing.pipeline 接线任务）**——故 `app.ts` 暂未默认注册该路由，`registerMessagesRoute` 已从 `@helm/gateway` 导出供 composition root 接线，gateway 仍可 headless 起。
- **Anthropic 错误翻译落在 core**：新增 `packages/core/src/protocol/anthropic/error.ts`（`transformErrorOut` / `makeAnthropicError`），`error_class → Anthropic error.type` 映射穷尽 `ErrorClass`，HTTP 状态复用 `ERROR_CLASS_HTTP_STATUS`。路由不手拼错误字符串（docs/05/07）。
- **新增 anthropic barrel** `packages/core/src/protocol/anthropic/index.ts`：导出已有的 `transformRequestOut`/`transformResponseIn`/`convert*Stream*`/`synthesizeSSEFromJSON` + 新错误函数，并组装 `anthropicTransformer`（`name:"anthropic"`、`endPoint:"/v1/messages"`、含 `transformRequestOut`/`transformResponseOut`）。注意 response 模块的 IR→native 函数沿用其原名 `transformResponseIn`（其文件头注释如此命名），在 barrel 里映射到 `Transformer.transformResponseOut`。

---

## 2026-05-31 · protocol.anthropic-stream：OpenAI-chunk → Anthropic SSE 流式状态机

所属：protocol.anthropic-stream、docs/05 流式互译、原则 1/8、research-notes 坑 #2/#3/#4

- **状态机产出 `AsyncIterable<AnthropicSSEEvent>` 事件对象，未耦合 Hono `streamSSE`**：契约要求纯逻辑（原则 1）。`convertOpenAIStreamToAnthropic(chunks)` 是 async generator，gateway 侧再把事件序列化上 SSE 线（接线不在本任务）。本任务**未复用** `streaming.ts` 现成的 `Controller`/`safeEnqueue`/`safeClose`（那套是 controller 推送模型）；generator 的"只 yield 一次"天然就是幂等关闭守卫，`openBlocks` 集合 + `delete` 保证每个 `content_block_stop` 只发一次、末事件只 yield 一次，等价覆盖 pit #4，无需 controller。
- **tool-block START 延迟到首个参数分片（偏离伪代码"首见即 start"）**：spec 伪代码在首次见到某 tool index 时立刻 `emit content_block_start`，但同时又要"临时 id 后补升级 / 已发出的用 message 修正"。为彻底规避"对外发出临时 id、客户端可能据其行动"的隐患，改为**首见只建 slot 不发 start**；待第一个 `arguments` 分片到达（或流结束兜底）时，id/name 已大概率落定，才发 `content_block_start`。这正是 task 测试 3 断言的"对外发出的 id 与最终真 id 一致"策略（settle-before-emit），比"先发临时再修正"更稳，且仍满足"delta 前必有同 index 的 start"（测试 6，无孤儿 delta）。代价：纯 name 无参数的 tool 调用，其 start 在流末兜底发出——可接受（Anthropic 客户端按 start→stop 配对即可）。
- **本地 `StreamState` 而非复用 `streaming.ts` 的共享 `StreamState`**：task「状态对象」给的字段（`nextBlockIndex`/`textBlockIndex`/`toolIndexToBlock` 带富 slot：blockIndex/id/name/argBuffer）比 `streaming.ts` 的通用 `StreamState`（`contentIndex`/`openaiIndexToBlockIndex`/`toolCallIdUpgrade`）更贴合 Anthropic 方向，故就近在 `stream.ts` 定义私有 state。通用 `streaming.ts` 仍是其它方向/字节层 splitter 的基础，两者不冲突。
- **`synthesizeSSEFromJSON` 复用主状态机**：把单个 IR 响应合成成"单 chunk feed"喂给 `convertOpenAIStreamToAnthropic`，从而与真流式**同构**（测试 7）——而非另写一套合成逻辑，杜绝两条路径漂移。
- **末事件 usage 复用 `response.ts` 的 `mapUsage`/`mapStopReason`**：`input = prompt − cached`（IR.prompt_tokens 已是非缓存输入），中途 chunk 的 usage 只 buffer 不发（测试 5），缓存读不双算（pit #2）；stop_reason 恒落合法 Anthropic enum。
- **门禁（全绿）**：`pnpm typecheck`=0、`pnpm lint`=0、`pnpm test`=481/481（含本任务 8 例）、`pnpm build`=0。

---

## 2026-05-31 · protocol.responses：OpenAI Responses 呈现面（item 展开）

所属：protocol.responses、docs/05 协议互译、原则 1/2/3

- **transformer 形态偏离 spec 的 `class`，改用对象字面量**：task 接口给的是 `class ResponsesTransformer implements Transformer`，但现行代码库（`openaiTransformer`、`anthropic`）一律用导出的对象字面量实现 `Transformer` 接口、`name`/`endPoint` 为只读字段。为保持一致与可注册性（`TransformerRegistry.register` 按 `name`/`endPoint` 索引），实现为 `export const responsesTransformer: Transformer`。语义等价，五方法契约不变。
- **`name = "openai-responses"`**：spec 未指定 transformer 名，仅给了 `endPoint=/v1/responses`。取 `openai-responses` 以与 `openai`（Chat）区分、且 registry 不冲突（endpoint 隔离用例覆盖）。
- **Zod schema 落在 core 而非 shared**：task「涉及文件」写 schema 落 `packages/shared`，但既有 anthropic transformer 把协议 native schema 全部 colocate 在 `packages/core/src/protocol/`（仅 IR/请求/错误等跨层模型进 shared）。Responses 的 native item schema 只服务于本 transformer，遵从既有约定就近放在 `responses.ts`，避免 shared 膨胀；IR 类型仍复用 `@helm/core` 的 `ir.ts`（z.infer，无重复手写类型）。
- **finish_reason → Responses `status` 映射**：Responses 终态合法值取 `completed`/`incomplete`；`length`/`max_tokens`/`content_filter` → `incomplete`（命中输出上限/截断），其余（`stop`/`tool_calls`/…）→ `completed`，未知值兜底 `completed`，**原值恒入 `provider_raw.stop_reason`**（pit #1，绝不丢原值）。
- **reasoning item `status` 剥离（litellm 已知坑）**：入站把 `reasoning` item 收成 IR thinking 块时**剔除 `status`**（OpenAI 报 `Unknown parameter: 'input[X].status'`），整条原始 item（含 status）存 `provider_raw.reasoning` 以便无损重建。
- **容错策略**：`function_call` 缺 `call_id` 时按 `id` → 合成 `call_<n>_<name>` 升级，绝不静默丢工具调用；未识别 item 类型进 `provider_raw.unknown_items`（fail-open，不崩请求）；`developer` 角色折叠为 `system`（IR 无 developer 角色）。
- **`transformRequestIn`（IR→Responses 请求）做了对称展开**而非恒等钳制：把 IR messages 摊回 `input[]` item 流（首条 system→`instructions`、tool→`function_call_output`、assistant.tool_calls→`function_call`），保持双向无损；MVP 上游多为 Chat，此向通常不走，但实现完整以备 Responses 上游。
- **门禁（全绿）**：`pnpm typecheck`=0、`pnpm lint`=0、`pnpm test`=473/473（含本任务 14 例）、`pnpm build`=0。

---

## 2026-05-31 · e2e.routing 收尾：修正 4 个陈旧 core 测试 fixture（typecheck 转绿）

所属：e2e.routing、原则 8（CI 全绿方可合并）、docs/07 error_class

- **诊断**：上一轮把 `pnpm typecheck` 的 RED 归因为「并发 core 重构、与本任务无关」。实查并非如此——是 `packages/core` 4 个 `*.test.ts` 的 fixture 没跟上现行 schema/编译选项，是**可直接修复**的真实类型错误，必须修而非搁置（CI 第 1 gate 要求整仓 typecheck 绿）。
- **`routing/route-request.test.ts`（232）**：「all providers failed」用例里手搓 `final.error` 字面量缺 `http_status`/`provider_raw`，不匹配现行 `HelmErrorSchema`（已增这两个必填字段）。改为调用工厂 `makeHelmError({...})`——既补齐字段又保证 `http_status` 与 error_class 映射一致（schema 单一真源），断言不变。
- **`telemetry/decision.test.ts`（269-271）**：`vi.fn(async () => ({id}))` 推断入参为 `[]`，导致 `insert.mock.calls[0][0]` 被收窄成 `never`。给 mock 显式签名 `vi.fn<TelemetryStore["insert"]>(...)`，恢复入参类型，断言不变。
- **`classifier/engine.test.ts`（298）、`classifier/momentum.test.ts`（227-231）**：`noUncheckedIndexedAccess:true` 下 `hist[0]` 是 `T | undefined`。改为 `const [entry] = hist` 解构 + 可选链 `entry?.x`（`Object.keys(entry ?? {})`），在已 `toHaveLength(1)` 的前提下语义不变，仅补类型收窄。
- **门禁现状（最终，全绿）**：`pnpm typecheck`=0、`pnpm lint`=0、`pnpm test`=390/390、`pnpm build`=0、`pnpm test:e2e`=12/12。注：`pnpm -r typecheck` 仅跑 4/5 包（admin 无 typecheck script，符合预期）。

---

## 2026-05-31 · e2e.routing：五场景端到端路由验证（Playwright）

所属：e2e.routing、docs/02 流水线/决策记录、docs/07 error_class、原则 3/5/7

- **路由信号经调试响应头暴露**：`chat.ts` 在 `c.json`/`streamSSE` 之前从 `result.decision` 打三个头——`x-helm-lane`（`lane.selected_lane`）、`x-helm-final-model`（`final.model_alias`）、`x-helm-provider-model`（`final.provider_model`）。只含路由别名，绝不含 key/payload（原则 7）。这是 spec「按 routing.pipeline 实际暴露」里给的备选方案；DecisionRecord 之前只进遥测，HTTP 侧不可观测，e2e 黑盒断言需要它。
- **`execute.ts` 修正：上游收到的 `model` 改为解析后的 `providerModel`**（原先发的是 `req.requested_model`）。网关既然把 alias 解析成 provider model，就该告诉上游跑哪个；这也让 mock 能回声出 final model、并按 model 注错触发执行兜底。`stripInternal`/`peekStream` 增加 `providerModel` 入参。既有 `execute.test.ts` 直接 mock provider、不校验所发 model，无回归。
- **mock 上游扩展**（`e2e/fixtures/mock-upstream.ts`）：① 回声模式——把收到的 `model` 原样回到响应体 `model`；② 注错模式——因网关只转发 `model`+`messages`（不转发任意 client header），故障经**提示词哨兵** `__HELM_FAIL_PRIMARY__` 引导：消息含该哨兵时只对 economy 头 `cheap_model`（首选候选）返 500，其余 model 正常 → 网关链内换到下一候选（执行兜底）。自洽、确定、可重复。
- **smoke 非流断言调整**：因 mock 现回声 model，原 `toEqual(NONSTREAM_RESPONSE)` 改为「除 `model` 外字段全等 + `model` 为字符串」（e2e key `allow_custom_model=false`，发上游的是路由出的 alias，非客户端请求的 id）。
- **场景 5（分类兜底→balanced）的确定性触发**：Layer-1 规则评分器被刻意硬化为永远 commit 一个 lane（`decided_by` 恒为 `"rules"`，`uncertain` 因 sigmoid 下限+边界几乎恒 false），eval 默认关——故**仅靠请求内容无法走到 `decided_by:"default"`→balanced**。在 `server.ts` 的 `buildClassify` 增加 `hasNoTextContent` 守卫：当所有消息都无非空白文本时，判定为「无法分类」并 throw，由 `routeRequest` 的 `classifySafe` 接住 → `defaultClassification`（decided_by=default）→ resolver 终点 `balanced`。这是真实失败模式（空/退化 prompt），确定可重复，且严格落在 fail-open（原则 3）+ 分类兜底（原则 5）路径上，不污染正常分类。e2e 用 `content:"   "` 触发。
- **场景 4 ≠ 场景 5 已分别校验**：场景 4 断言 lane 仍为 `economy`、final model 为链内下一候选 `default_good_model`（执行兜底，lane 不变）；场景 5 断言 lane 变 `balanced`（分类兜底）。互不混淆（原则 5）。
- **场景 3（json lane）按实际暴露收敛**：`DEFAULT_LANES` 只有 economy/balanced/premium，**无 `json` lane**，且无 `json`/`extraction` task lane；带 `response_format:json_object` 的请求经 extraction task → 按复杂度落 economy。故场景 3 不断言「进 json lane」，改断言**正确路由（落在合法 lane）+ 不 5xx + 响应为合法 chat.completion JSON 形态**（能力过滤目前空 catalog、fail-open 跳过）。待 json 专用 lane/catalog 接线后可加强。TODO。
- **并发 core API 迁移的对齐修正**：并发任务把 `InternalRequest` 从 `@helm/core` re-export 中移除（迁到 `@helm/shared`），并把 registry 的 `ProviderConfig` 重命名导出为 `ProviderRegistryConfig`。这破坏了 gateway 的 `chat.ts`/`execute.ts`/`server.ts` 及其 `*.test.ts`（`InternalRequest` 找不到、`ProviderConfig as RegistryProviderConfig` 取错类型）。在本任务编辑半径内做了机械对齐：上述文件 `InternalRequest` 改从 `@helm/shared` 导入；`server.ts` 的 `type ProviderConfig as RegistryProviderConfig` 改为 `type ProviderRegistryConfig as RegistryProviderConfig`。Vitest（不做类型检查、type-only import 运行时擦除）此前未暴露此问题，仅 `tsc` 捕获。
- **门禁现状（最终）**：`pnpm test:e2e`（5 路由场景 + 原 smoke 共 12 例）、`pnpm test`（390 单测）、`pnpm lint`、`pnpm build` **均全绿**。`pnpm typecheck` 仍**红（exit 2）**——剩余 9 处错误**全部**落在 `packages/core` 的 4 个 `*.test.ts`（`classifier/engine.test.ts`、`classifier/momentum.test.ts`、`routing/route-request.test.ts`、`telemetry/decision.test.ts`），系并发进行中的 classifier/telemetry 重构所致（`HelmError` schema 新增 `http_status`/`provider_raw` 等），**与本 e2e 任务文件无关**（`apps/gateway` 单独 typecheck 干净、build 通过）。`tsconfig.build.json` 排除测试文件，故 build 绿。待并发 core 任务落定后整仓 typecheck 自然恢复。

---

## 2026-05-31 · telemetry.decision-full：决策记录组装/持久化 + schema 增加 trace_id

所属：telemetry.decision-full、docs/02 决策记录、docs/07 可观测性、原则 3/7

- **`DecisionRecordSchema` 新增必填字段 `trace_id`（`z.string().min(1)`）**：原 schema 只有
  `request_id`，但本任务契约（测试 7）与 docs/07 Debug UI 的 Trace ID 列要求记录显式带
  `trace_id`。当前流水线把 `request_id` 当作 trace id 用（`route-request.ts`/`fallback.ts` 给
  `makeHelmError({ trace_id: req.request_id })`），故 `buildDecisionRecord` 设
  `trace_id = request.request_id`。同步更新了 `route-request.ts` 的记录组装与所有既有
  DecisionRecord 测试 fixture（schema/ports/sqlite-telemetry）。权衡：未在 `InternalRequest`
  另立 trace_id 字段——避免引入第二个相关 id；若将来需要独立链路 id，再扩 request schema。
- **`persistDecision(store, record, opts?)` 偏离纯 `(store, record)` 契约**：`InsertTelemetryInput`
  需要 `apiKeyId`，而 DecisionRecord 按原则 7 不携带 key。故签名加可选
  `opts.apiKeyId`（仅 key_id，绝非明文/hash），缺省回落到 `request_id` 作关联 id。
- **脱敏作为离开 core 前的最后一道闸**：`buildDecisionRecord` 整条记录过 `redact`，即使上游某段
  误带明文 key/私有 payload 也不会落库（原则 7）。
- **fail-open 持久化**：`store.insert` 抛错只发结构化 `telemetry.persist_failed` 告警（带
  trace_id），绝不上抛——最坏丢一条记录，不让请求 5xx（原则 3）。

---

## 2026-05-31 · routing.pipeline 实现：编排核心 + 网关接线取舍

所属：routing.pipeline、docs/02 架构概览、docs/04 Lane 路由、原则 1/3/5/8

- **`routeRequest` 放 `packages/core/src/routing/route-request.ts`，框架无关（原则 1）**：
  `classify`/`execute`/`policies`/`lanes`/`now`/`log` 全部依赖注入。`execute` 抽象成回调（能力过滤+熔断+按链执行），
  本任务 core 单测全 mock 它；真实 `execute` 适配器在网关侧 `apps/gateway/src/routes/execute.ts`，
  因为它要 import provider/registry/breaker/catalog，是组合根的职责，不属于框架无关 core 的纯编排。

- **classifier 复杂度词表与路由复杂度词表不一致，必须在 `classify` 适配器里映射（spec 未点明的接缝）**：
  `classifier/tiers.ts` 的 `Complexity = simple|standard|complex|reasoning`，而 `lane-resolver`/`policy-engine`
  契约的复杂度是 `simple|medium|complex`（docs/04）。我在网关 `buildClassify` 里映射：
  `standard→medium`、`reasoning→complex`、`simple→simple`、`complex→complex`。`task_type` 同理：classifier 的
  `chat` 等任务名直接透传给 policy/resolver（resolver 找不到同名 lane 时回落到 complexity，原则 3）。
  取舍：映射放适配器、不动两套既有纯函数的词表，范围最小且二者各自的测试不回归。

- **`stream:true` 的执行兜底 + 首个有效 chunk 语义（原则 8 + docs/02 熔断）**：`execute` 适配器对流式候选先
  `peek` 第一个 chunk——首个 chunk 前抛错 = pre-first-chunk 故障（记熔断失败、试下一个候选）；拿到首个 chunk =
  成功（healing 熔断），随后把「首个 chunk + 其余」原样重组成新生成器交还，**不缓冲整流**、SSE 边界/顺序字节级不变。
  客户端 abort 走 `recordAbort`（非 provider 故障、不触发熔断、终止全链、不算 all_providers_failed）。

- **Phase 0 直通测试被删除并替换**：`chat.nonstream.test.ts` / `chat.stream.test.ts` 测的是 Phase 0 常量直通
  （旧 `ChatRouteDeps{provider,...}`），本任务已用真实流水线替换，故删除，新增 `chat.route.test.ts`（经流水线，
  断言 classify/execute 被调用而非旁路常量）+ `execute.test.ts`（执行兜底/能力跳过/流式 peek/abort）。

- **网关默认 lanes/policies 接线（config loader 暂未加载 lanes.yaml/policies.yaml）**：`config/loader.ts` 目前只
  load server/auth/providers/runtime/classifier（其自身注释声明 lanes/policies 属各自模块任务，尚未并入
  `HelmConfigSchema`）。为让流水线在 e2e 跑通，`buildServer` 暂用 core 的 `DEFAULT_LANES` + 空 policies，并按
  默认 lane 别名建一个把它们全部解析到唯一配置 provider 的 registry（mock upstream 忽略 model）。catalog 暂传空
  Map → 能力过滤被跳过（fail-open）。**TODO**：等 `config.lanes`/`config.policies`/真实 catalog 接入 loader 后，
  把这段硬编码换成 config 驱动（原则 2）。

## 2026-05-31 · classifier.engine 实现：编排取舍（momentum 压过 short_message 捷径；sessionKey 来源；fail-open 包裹）

所属：classifier.engine、docs/03 §第 1 层「会话动量 / 硬覆盖与捷径」、原则 3/4/5

- **`momentum` 应用时抑制 `short_message` 捷径（spec 未明说的编排取舍，本任务定）**：
  docs/03 把「会话动量」与「硬覆盖与捷径」列为并列要点，没说同时命中谁赢。问题：一条短的后续消息（如
  "yes"）会**同时**触发 momentum（需要短消息才有高权重）和 `short_message` 捷径（< 50 字符且无复杂信号 → set→simple）。
  若按 overrides 既定的「set 即终」语义，`short_message` 会把 momentum 拉高的结果重新钉回 simple——
  而 momentum 的**全部存在意义**正是「避免单条短消息把分类带偏」（docs/03 原文）。二者目标直接冲突。
  我定：**engine 在 `momentumApplied===true` 时丢弃 `short_message` 这一条 override hit**，让 momentum 生效。
  高确定性的 `set` 信号（心跳精确 token、形式逻辑关键词）**仍然照常压过一切**——它们是精确信号，不是弱启发式，
  心跳/形式逻辑该赢就赢。取舍：只豁免 `short_message` 这条弱捷径，范围最小、最可解释。
  测试钉死：`engine.test.ts` 用例 5（注入 reasoning 历史 + "yes" → 被拉高且不被 simple 钉回；不注入 momentum 时不拉高）。
- **`sessionKey` 取自 `req.metadata.conversation_id`**：spec 契约写 momentum「若提供 deps.momentum 且有 sessionKey」，
  但没说 sessionKey 从哪来。第 1 层是纯函数、不读 header（header 解析在 gateway 层），engine 只能从已规范化的
  `InternalRequest` 取——`metadata.conversation_id` 是会话维度的稳定标识，正合「session-dimension key」语义
  （见 momentum.ts 的 cache-key 契约注释）。gateway 接线时需把 `x-session-key` 映射进 `metadata.conversation_id`。
  **TODO**：确认 protocol adapter 把会话标识落到 `conversation_id`；否则 momentum 在生产里恒不触发（fail-open 到无动量，安全但失能）。
- **每个子环节用 `safe(fn, fallback)` 包裹（原则 3 fail-open）**：dimensions/momentum/tiers/overrides/taskdetect/写回
  任一抛错都被吸收为安全默认（standard / chat / 低 confidence），绝不冒泡成 5xx。子函数本身已大多防御，这里是
  纵深防御的最后一道，确保「分类失败 → 上层降级 balanced」而非异常。
- **constraints 派生**：`needs_tools/json/vision` 直接读规范化请求；`long_context` 用 `approxTokens > overrides.long_context_token_threshold`
  （阈值复用 overrides cfg，避免再引一个阈值）；`low_latency`/`low_cost` 由心跳/短消息捷径命中推断，`low_cost` 另含 `complexity==="simple"`。
- **`decided_by` 恒 `"rules"`、`uncertain` 仅置标记**：engine **不**调用 eval、不查 catalog、不碰 provider（第 1 层零网络）。
  `eval_cache_hit` 由级联编排器在触发 eval 时写；本任务产出的 result 映射进 `ClassifierDecisionSchema` 时 `eval_cache_hit:null`（测试 6 验证 parse 通过）。
- **momentum 写回不破坏确定性**：`recordMomentum` 在定档后回写历史，但用注入的 `now()` 重新打戳；测试 7 用两个独立 store
  播同一快照连调两次，断言结果 `toEqual`——写回只影响**下一**条请求，不影响本条的确定性。

---

## 2026-05-31 · classifier.overrides 实现：set 压过 floor 的优先级取舍（spec 未明说，已拍板）

所属：classifier.overrides、docs/03 §第 1 层「硬覆盖与捷径」、docs/research-notes.md §Manifest、原则 4

- **`set` 绝对压过 `floor`（spec 未明说的取舍，本任务定）**：spec 列了两类覆盖但没说同时命中谁赢。
  我定：`applyOverrides` 中**任一 `set` 命中即终**，直接返回该 `set` 档，忽略所有 `floor`。理由——
  `set`（心跳 `HEARTBEAT_OK`、形式逻辑关键词）是**高确定性的精确信号**：心跳整条消息就是一个固定 token，
  形式逻辑是明确的领域标记；而 `floor`（带 tools→≥standard、超长→≥complex）只是「下限保护」，
  是弱得多的启发式。让强信号压过弱下限，符合「确定、可解释、不被噪声带偏」的 Manifest 意图。
  典型：心跳 + tools 同时存在 → simple 终胜（心跳确定是探活，不该因为请求恰好带了 tools 就抬到 standard）。
  测试钉死：`overrides.test.ts` 「set beats floor」用例。
  **取舍**：代价是带 tools 的心跳被判 simple——可接受，因为心跳本就不该消耗推理资源；若未来出现「探活也要走 tool」
  的真实场景，再引入「set 后仍取 floor 上限」的合并语义。当前 set 即终，最简单也最可解释。
- **多个 `floor` 取最高档**：tools(standard) + 超长(complex) 同时命中 → complex（`RANK` 取大）。`floor` 只抬不降。
- **心跳用「整条末条 user 消息 trim 后等于某 token」判定，而非子串**：避免 `"explain HEARTBEAT_OK protocol"`
  （实为 coding 问题）被误判 simple。形式逻辑关键词则用全对话子串匹配（关键词可能出现在任意一轮）。
- **短消息捷径的「无复杂信号」复用 `signals.ts` 的 `detectCodeBlock`/`detectStackTrace`**，不另写正则——
  与 dimensions/taskdetect 同一实现，避免漂移（与既有 signals 共享原则一致）。判定 = 末条 user 消息 trim 后
  `< short_message_max_chars` **且**无代码块/堆栈。长度上限本身就排除「超长」，故不再单测长度信号。
- **`approxTokens` 由 engine 注入**：本纯函数不做任何 token 编码/网络（保持零依赖、确定性，原则 4）。
  超长判定用严格 `>`（`approxTokens > threshold`），阈值由 cfg 驱动（测试：阈值调 10k、approxTokens=12k 即触发）。
- **空数组即 no-op**：无任何命中 → `[]`，`applyOverrides(base, [])===base` 原样返回，不抛错（fail-open 精神）。

---

## 2026-05-31 · classifier.tiers 实现：sigmoid 闸门与默认阈值 0.45 的内在矛盾（spec 不一致，已记录）

所属：classifier.tiers、docs/03 §第 1 层置信度闸门、docs/research-notes.md §Manifest、原则 4

- **公式与默认阈值矛盾（spec 自相矛盾，按字面公式实现）**：spec 三处给定
  `confidence = sigmoid(k=8 · 到最近边界的距离)`，且 task 测试 5 钉死 `sigmoidConfidence(0,8)===0.5`。
  因 distance≥0，故 `confidence ∈ [0.5, 1)`——**永远不会 < 0.5**。但 task 测试 4 / docs 又称
  「贴边界 → confidence < 0.45 → uncertain」。在该公式下 confidence 在边界处只能逼近 0.5（下确界），
  **不可能 < 0.45**，故默认阈值 `0.45` 实际上**永不触发** uncertain。这是 spec 内部矛盾。
  取舍：我**忠实字面公式**（测试 3/5/6 都依赖 sigmoid(0)=0.5 这一点），把 task 测试 4 改写为断言
  「贴边界时 confidence 收敛到下确界 0.5、且远小于远离边界时的 ~1」——保留其**意图**（贴边界=最不确定），
  但不再断言「< 0.45」这一与公式冲突的数值。uncertain 的真正触发由测试 6 证明：阈值调到 0.7 即翻 true。
  **TODO（待 engine/eval 任务拍板）**：若希望默认 0.45 能真正触发级联，需把置信度改成
  `2·sigmoid(k·d) − 1`（边界→0、远处→1），或把默认阈值上调到 (0.5, 1)。本任务只产纯函数标记，不擅自改公式语义，
  把抉择留给级联控制流的 engine 任务。
- **NaN/Inf 防御**：非法上游分数不抛错，归 `standard` 档、`confidence=0`、`uncertain=true`
  （原则 3 fail-open 精神；0 < 任何合法阈值，确保降级信号一致）。`nearestBoundaryDistance=0`。
- **最近边界距离**：对 simple/reasoning 单侧取唯一相邻边界；中间档取两侧较近者。三档边界
  `standard/-0.10、complex/0.08、reasoning/0.35`、`sigmoid_k=8`、`confidence_threshold=0.45` 全由 cfg 驱动，
  有「改 cfg 即改行为」测试佐证（边界改 complex=0.20、阈值改 0.7）。

---

## 2026-05-31 · provider.registry 实现：ProviderConfig 命名分歧 + 样例不入 schema

所属：provider.registry、docs/02、原则 6/7/2/1

- **registry 的 `ProviderConfig` ≠ `@helm/shared` 的 `ProviderConfig`（命名分歧，刻意保留）**：
  task 契约规定 registry 接收的配置形如 `{ name, base_url, api_key_env, models[{alias, provider_model}] }`，
  但 Phase-0 的 `@helm/shared` `ProviderConfigSchema` 形如 `{ alias, type, base_url?, api_key_env }`（无 models[]，
  描述的是 OpenAI 兼容直通 provider）。二者语义不同：shared 那个是直通客户端的最小配置，registry 这个是
  「别名→具体 model」的多 model 映射。为不破坏既有 Phase-0 加载/测试，registry 在 `packages/core/src/provider/registry.ts`
  **自带** task 指定的 `ProviderConfig` 接口（按契约逐字段），不复用 shared 那个、也不改 shared schema。
  待 lane/executor 任务接线时，再决定是否扩 `HelmConfigSchema` 引入 `models[]`（届时让 registry 消费 shared 类型）。
- **core index 导出改名避撞**：core 已从 `provider/openai.ts` 导出 `ProviderConfig`（直通客户端配置）。registry 的同名类型
  在 index 处 **aliased 为 `ProviderRegistryConfig`** 再 re-export，避免重复导出符号冲突。
- **`config/providers.yaml` 样例不动既有校验项**：把 registry 的多 provider/多 model 形态作为**注释样例**追加，
  不改动当前被 `HelmConfigSchema` 校验的 `providers[0]` 条目（否则可能破坏 `loadConfig` 测试）。真正把该 shape 入 schema
  归 lane/executor 任务。
- **错误形态**：未知别名走 Result `{ ok:false, error:{ kind:"unknown_alias" } }`，**不 throw**（fail-open 信号）；
  重复别名在 `createProviderRegistry` 构建期 **throw `RegistryBuildError`**（携带结构化 `{ kind:"duplicate_alias", alias }`），
  fail-closed（原则 2）。结果对象只含 `apiKeyEnv`（env 名），无任何明文凭证字段（原则 7）。

---

## 2026-05-30 · catalog.sync 实现 + ralph-dev 索引格式修复

所属：catalog.sync、CLAUDE.md 实现约定「能力与定价数据源」、docs/02 安全规则

- **ralph-dev `index.json` schema 不兼容（已修，关键阻塞）**：`.ralph-dev/tasks/index.json` 里 `tasks`
  是**数组**，但已安装的 ralph-dev CLI 0.5.0 期望 `tasks` 为**以 taskId 为键的对象**
  （`findById`/`updateIndex` 用 `index.tasks[id]`）。后果：`state set/update`、`tasks start/done`
  全部以 `FILE_SYSTEM_ERROR` 失败，`tasks get <id>` 报 TASK_NOT_FOUND，整个 implement 循环卡死，
  而 state 却被标成 `complete`（实际仅 26/79 完成）。修复：把 `tasks` 由数组转为对象，键 =
  `module + "." + basename(filePath, ".md")`（已校验 79 条全部与各 `.md` frontmatter `id` 一致）。
  备份留在 `.ralph-dev/tasks/index.json.array-backup`。**TODO**：上游 breakdown 产物与 CLI 版本须对齐，
  否则下次仍会卡。
- **catalog 数据流**：`scripts/sync-catalog.ts`（构建期，tsx 运行，**不属运行时**）读 LiteLLM 本地快照 →
  规范化 → 写**签入** `packages/core/src/catalog/generated/catalog.json`（带 `generatedAt`、按 modelKey
  稳定排序）。运行时 `packages/core/src/catalog/index.ts` 的 `loadCatalog()` 合并 generated +
  `capabilities.yaml`/`pricing.yaml` 手动覆盖，**手动逐字段 WIN** 且可新增全新 modelKey，命中覆盖的条目
  `source` 标 `"override"` 供调试 UI 解释来源。
- **定价单位**：上游是 per-token USD，规范化为 per-MTok USD（×1e6），并 `Math.round(...*1e6)/1e6`
  去除 IEEE-754 误差（否则 `0.0000008*1e6 = 0.7999999999999999` 进签入产物）。
- **被迫的工具链改动**：根 `package.json` 加 `sync:catalog` 脚本 + `tsx`/`@helm/shared` 到 devDeps；
  `vitest.config.ts` 的 `include` 增加 `scripts/**/*.test.ts`。`scripts/` 不是 workspace 包，故
  **不被 `pnpm -r typecheck` 覆盖**（仅 vitest 经 esbuild 跑，不类型检查）——**TODO**：后续若 scripts 变多，
  考虑给它独立 tsconfig 纳入 typecheck。
- **fixture**：`scripts/fixtures/model_prices_and_context_window.json` 是最小**示例**快照（6 条，1 条
  无 ctx 故被跳过 → 产出 5 条），非真实全量 LiteLLM 数据。**TODO**：接真实上游快照来源（手动下载/CI 拉取后签入）。

---

## 2026-05-30 · Phase 0 实现：e2e 冒烟 + auth 错误形态不一致（TODO）

所属：e2e.smoke、auth.middleware、docs/05、docs/07

- **e2e 用 Playwright `request` fixture（无浏览器）跑真实 gateway 进程 + mock 上游**：两个 webServer——
  `mock-upstream.ts`（OpenAI 兼容替身，含流/非流）+ `test-server.ts`（预种一把确定性 key 后 `buildServer` 监听）。
  覆盖 healthz/version、无 key/错 key 401、非流逐字直通、流式 SSE 顺序 + `[DONE]`、明文 key 不回显。7/7 通过。
  provider base_url 经新增 env `HELM_PROVIDER_BASE_URL` 指向 mock。
- **⚠️ TODO（spec 不一致，记录待修）**：`auth.middleware` 短路返回的是 `shared.error-schema` 的**裸 HelmError 形态**
  （`{error_class, http_status, ...}`），而 gateway `onError` 把其它错误翻成 **OpenAI 形态**（`{error:{type,code}}`）。
  对 OpenAI 客户端，401 鉴权错应也走 OpenAI 形态才一致（docs/07）。当前 auth.middleware 任务契约要求返回 HelmError
  schema body，故保持原样；建议后续让 auth 错误也经统一翻译。e2e 与 auth 单测都按"裸 HelmError body"断言。
- **e2e 未纳入 `pnpm test`（vitest 只跑 `*.test.ts`，e2e 是 `*.spec.ts`）**；`pnpm test:e2e` 单独跑。
  CI 第 5 gate（Playwright）现已就绪可增补（需 `playwright install` browsers，虽然 request fixture 不强依赖）。

---

## 2026-05-30 · Phase 0 实现：gateway 服务入口 + Docker

所属：docker.image、docker.compose、e2e.smoke、docs/10

- **新增真实服务入口 `apps/gateway/src/server.ts` + `index.ts main()`**：spec 把启动接线散在多个任务里，
  我把它收成一个 `buildServer()`：loadConfig → createSqliteDb → bootstrapRootKey（幂等、打印一次）→
  createOpenAIClient（凭证从 `providers[0].api_key_env` 指向的 env 取）→ createApp(limits/health) →
  authMiddleware(/v1/*) → registerChatRoutes。`index.ts` 用 `@hono/node-server` 的 `serve()` 监听，
  fail-closed：配置非法/缺凭证抛错 → `process.exit(1)`。已本地实跑验证：/healthz 200、root key 打印一次、
  no-key → 401、结构化日志带 trace_id。
- **⚠️ 本环境无 Docker**：`docker build`/`compose up` 无法在此跑，故 `Dockerfile`/`docker-compose.yml` 的
  契约用**静态断言测试**钉死（multi-stage、非 root uid 10001、EXPOSE 8080、HEALTHCHECK /healthz、
  `--frozen-lockfile`、无明文凭证、卷挂载点属主）。真正的 build/run 烟测需在有 Docker 的 CI 上跑。
- **Dockerfile builder 装了 `python3 make g++`**：better-sqlite3 原生编译所需；runtime 层用
  `pnpm deploy --prod` 拍平，不含工具链。

---

## 2026-05-30 · Phase 0 实现：config 样例对齐真实 schema（偏离 spec 草稿）

所属：config.samples、gateway.limits、docs/02、docs/06

- **样例 yaml 对齐我实际构建的 `HelmConfigSchema`，而非 task 草稿里的字段名**。草稿用
  `providers[].credentialEnv`、`runtime.port`、`runtime.dataDir`、`runtime.store.driver`、auth.yaml 顶层 `rate_limit`；
  实际 schema 是 `providers[].api_key_env`、`server.port`、`runtime.rate_limit`，无 dataDir/store 字段。
  样例（`config/{server,auth,providers,runtime}.yaml` + `.env.example`）按真实 schema 写，且有测试用 `loadConfig` 实际加载验证。
- 凭证只用 `api_key_env` 环境变量名引用，无明文；`.env.example` 全占位（`sk-...`）。
- store driver / dataDir / admin 字段待对应模块任务再扩 schema + env-map + 样例。

---

## 2026-05-30 · Phase 0 实现：SQLite 适配器（Drizzle + better-sqlite3）

所属：CLAUDE.md DB 抽象层、docs/02、docs/06、store.sqlite-schema

- **迁移走签入的 SQL DDL + `_migrations` 版本表**，不依赖 `drizzle-kit generate` 的构建期 codegen。
  `runMigrations(path)` / `createSqliteDb(path)` 对全新或已存在的 sqlite 文件幂等 apply；失败抛错（fail-closed）。
  幂等性测试用真实临时文件（`:memory:` 每次 new 一个新库，测不出幂等）。
- **better-sqlite3 原生编译是环境坑**（⚠️ CI 必读）：
  - 本机 Node 25 + arm64 没有 prebuilt 二进制，`prebuild-install` 静默失败，需 `node-gyp rebuild` 现编译。
  - 已在根 `package.json` 加 `pnpm.onlyBuiltDependencies: ["better-sqlite3","esbuild"]` 允许安装时构建；
    但若该平台无 prebuilt，仍需本机有 C++ 工具链（Xcode CLT / build-essential）。
  - CI 建议：用有预编译二进制的 LTS Node（20/22），或在 CI 装 build 工具链；docker.image 任务的 runtime 镜像需确保二进制随构建产出。
  - 偏离点：spec 写「drizzle-kit generate 产出并签入迁移 SQL」；这里改为代码内联 DDL + 版本表，等价满足
    「干净 apply + 幂等 + 可签入」，且少一层 drizzle-kit CLI 依赖。后续如需多迁移可平滑加 `MIGRATIONS` 数组项。
- **vitest 加载原生模块**：`vitest.config.ts` 设 `test.server.deps.external: ["better-sqlite3"]`，
  让 Node 原生 require 加载 `.node`，否则 Vite 转换管线定位不到 bindings。

---

## 2026-05-30 · Phase 0 实现：ApiKeyRecord schema 补位（spec 缺口）

所属：docs/06、store.ports / auth.keygen

- **`ApiKeyRecord` Zod schema 是我自己补的**：`store.ports` 契约引用 `@helm/shared` 的 `ApiKeyRecord`
  类型，但 breakdown 的四个 shared schema 任务（request/decision/error/config）都没建它。为不阻塞 store/auth，
  我在 `packages/shared/src/key/schema.ts` 新建 `ApiKeyRecordSchema` + `KeyRoleSchema`，字段照 docs/06：
  `key_id/hash/prefix/account_id/role(root|user)/max_lane?/allowed_lanes?/allow_custom_model/disabled`，
  **无任何明文字段**（原则 7）。`max_lane`/`allowed_lanes` 用 `.nullable()`（present-but-null）。
- 后续 `auth.keygen`/`auth.bootstrap`/`auth.middleware` 直接复用此 schema，不再另立 key 类型。

---

## 2026-05-30 · Phase 0 实现：Zod v4 / 配置加载 / env 映射

所属：CLAUDE.md 原则 2、docs/02、docs/06、docs/10

实现 Phase 0 骨架（scaffold + shared schema + config loader）时的决定：

- **Zod = v4（4.4.x）**，而非 spec 草稿里隐含的 v3 写法。被迫的 API 调整：
  - `z.record(z.unknown())` → `z.record(z.string(), z.unknown())`（v4 record 需 key+value 两参）。
  - `.passthrough()` → `z.looseObject({...})`（v4 重命名）。
  - `z.string().url()` → `z.url()`（v4 string.url 已弃用）。
  - `z.ZodIssue` 类型 → `z.core.$ZodIssue`（v4 把 issue 类型移到 `z.core` 命名空间）。
- **配置文件拆分（Phase 0 实际落地）**：`config/{server,auth,providers,runtime}.yaml` 四份；
  `server/auth/runtime.yaml` 各对应 `HelmConfig` 同名顶层键，`providers.yaml` 顶层带 `providers:` 数组键并整体合并。
  docs/02 列的 lanes/policies/classifier/capabilities/pricing 五份留待 Phase 1+，本期不读。
- **env→config 映射对齐真实 schema**：task spec 给的 env 映射表（`runtime.port`/`admin.user`/`runtime.store.driver`）
  是示意，与本期 `HelmConfigSchema`（`server.port`，无 admin/store 字段）不符。实现按真实 schema 映射：
  `HELM_HOST→server.host`、`HELM_PORT→server.port`、`HELM_REQUIRE_API_KEY→auth.require_api_key`、
  `HELM_KEYS_PERSIST_TO→auth.bootstrap.persist_to`、`HELM_MAX_REQUEST_BYTES`/`HELM_REQUEST_TIMEOUT_MS`/
  `HELM_RATE_LIMIT_ENABLED→runtime.*`。admin（docs/11）与 store driver 字段待对应任务再入 schema + env-map。
- **env 优先 + 显式转型**：env 值恒为字符串，loader 在 parse 前按 env-map 的 `kind` 做最小转型
  （number/boolean/string），不可解析的（如 `HELM_PORT=abc`）转成 `NaN`/原字符串 → 交给 Zod 拒绝（fail-closed），
  而非 loader 手抛 opaque error。
- **fail-closed 不回显密钥**：`ConfigError` 只携带 issue 的 `path`+`message`，`formatIssues` 不打印出错值；
  测试断言 `OPENAI_API_KEY`/`HELM_ADMIN_PASSWORD` 明文不出现在错误信息里（对齐原则 7）。

---

## 2026-05-30 · 开放问题拍板（lint / 数据源 / 执行层 / 缓存）

所属：CLAUDE.md / docs/02、docs/03

- **Lint/Format = Biome（TS）+ Svelte 原生（admin）**。
  - 理由：Biome 单工具、极快、零配置摩擦，适合 greenfield TS。
  - 取舍：Biome 对 `.svelte` 支持不足，故 admin 用 `prettier-plugin-svelte` + `svelte-check`。monorepo 分包用不同工具可接受。
- **capabilities/pricing 数据源 = LiteLLM `model_prices_and_context_window.json` 同步 + 手动覆盖**。
  - 机制：`pnpm sync:catalog` 生成签入的 catalog；运行时读 `capabilities.yaml`/`pricing.yaml`，手动条目覆盖；不在运行时拉取。
  - 理由：落实 spec 安全规则"生成目录是供应链输入，不直接进运行时选择"。备选源 models.dev / OpenRouter `/models`。
- **provider 执行层 = 重写并移植 llm-router 语义，不抄代码**。
  - 移植：熔断 OPEN/HALF_OPEN + 探测锁、首个有效 chunk 前记失败/后记成功、能力过滤显式 skip reason、`:free` 429 跳过、abort 非故障。
  - 取舍：llm-router 有 dead surface（如废弃的 ScoreBreakdown），直接抄会带进技术债；用其测试当行为 checklist 更干净。
- **eval 缓存键 = sha256(canonical-json)**，字段：末条 user 消息(trim)、turn 数、排序 tool 名、response_format 是否 JSON、是否含附件/vision；稳定键序、排除易变字段、不 lowercase；TTL 300s 可配。
  - 待实现后验证命中率，必要时调字段集。

---

## 2026-05-30 · 初始技术决策（spec 未细化，于 CLAUDE.md 落定）

所属：全局 / docs/02、docs/10、docs/11

实现尚未开始。以下是为初始化项目而做的、spec 层面未明确的决定：

- **API 框架选 Hono（而非 SvelteKit SSR endpoints）**。
  - 理由：网关需 headless 独立部署，不能绑死前端框架；Hono 基于 Web 标准、`streamSSE` 对跨协议 SSE 翻译控制更精细；轻量、跨运行时。
  - 取舍：SvelteKit SSR 可以少一个进程，但会把核心网关耦合进 UI 框架，违背"网关与 UI 解耦"原则。
- **管理界面 = SvelteKit + Tailwind，`adapter-static`(SPA) 打包，由 Hono 在 `/admin` 托管**。
  - 理由：单容器部署、与网关解耦；admin 通过 API 调用网关。
- **DB 抽象层 = Store 端口接口 + 适配器（sqlite 默认 / supabase）**，底层建议 Drizzle ORM（同时支持 SQLite + Postgres + 迁移）。
  - 取舍：Drizzle 给到类型化查询与迁移，但 SQLite/Postgres 方言差异需封在各适配器里，core 只依赖接口。
- **Lint/Format 未最终敲定**：CLAUDE.md 给了 ESLint+Prettier 或 Biome 二选一，待起项目时确认（Biome 更快、单工具；ESLint+Prettier 生态更熟）。

### 开放问题

- 以上 lint / 数据源 / 执行层 / 缓存四项已于上方 2026-05-30 条目拍板。
- Lint 细节、catalog 同步脚本、执行层移植边界、缓存命中率均待实现时验证。
