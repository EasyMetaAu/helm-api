# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。

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
