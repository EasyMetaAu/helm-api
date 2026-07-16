# AGENTS.md — Helm API

Helm API 是一个**开源、自托管**的 LLM 路由网关（"LLM 世界的 nginx"）。当前规格与历史附录索引见 [`docs/README.md`](docs/README.md)（核心章节按 01–14 阅读，Self-Service Portal 单独列出）。本文件只放**实现时必须遵守的原则与约定**，不重复 spec 内容。

---

## 核心原则（不可妥协）

1. **网关与 UI 解耦**：核心网关（路由、分类、provider 执行、协议互译、存储）必须能**脱离管理界面 headless 独立运行**。core 逻辑不得 import 任何框架（Hono / SvelteKit）。
2. **配置即代码**：行为由 `config/*.yaml` + 环境变量驱动，不靠改代码。配置加载用 Zod 校验，**非法配置 fail-closed（拒绝启动）**，绝不带病运行。
3. **辅助环节 fail-open，边界校验 fail-closed**：分类/eval 失败回退到 `runtime.default_lane`（出厂值为 `balanced`）并记录；Memory 失败保持请求不变，其他可选缓存/信号读取按各自契约降级。鉴权、schema、硬配额、显式禁用项与确定性客户端错误必须拒绝；执行链耗尽时返回协议形状的结构化错误。
4. **确定性优先**：第 1 层规则是纯函数、零网络、可单测；eval（第 2 层）`temperature:0`、默认关闭、带缓存。
5. **两种 fallback 分清楚**：分类兜底（→ `runtime.default_lane`）与执行兜底（→ 链内下一个 model）是两套机制、两套日志字段，绝不混淆（见 docs/03、04）。
6. **暴露 lane 抽象，不暴露模型市场**；provider 别名是内部供应链细节。
7. **密钥安全 + 正文可观测**：API key 鉴权只依赖 **sha256 哈希**；如配置了 at-rest 加密密钥，可额外保存 `secret_enc`（AES-GCM 密文）供管理后台查看/轮转。Key Store、遥测、payload 表与常规日志绝不保存明文 key；唯一例外是首次 bootstrap 可把 root key 打印一次，并原子写入配置的 `0600` recovery file，之后不会再次显示。**完整 request/response 正文按运行时设置 `capture_payloads`（默认开）记录到独立的 `request_payloads` 表**，便于调试与审计；可在管理界面「系统设置」随时关闭，并按 `payload_retention_days` 自动清理。`DecisionRecord` 仍保持脱敏（不含正文）作为纵深防御。
8. **流式正确性是头号风险**：协议互译的 SSE 事件映射（见 docs/05）必须有针对性测试覆盖。

---

## 技术栈（已定）

| 层 | 选型 |
|---|---|
| 语言 | TypeScript（`strict: true`，ESM，Node 22+） |
| 包管理 | **pnpm**（workspace 单仓多包） |
| API / 网关 | **Hono**（Web 标准、`streamSSE`、可 headless）—— 不用 SvelteKit SSR 当 API |
| Web 界面 | **SvelteKit + Tailwind**，`adapter-static` SPA；Hono 在 `/admin` 托管运维面板、在 `/portal` 托管 key 持有者门户 |
| 校验 | **Zod**——schema 是**类型唯一来源**，内部请求/配置/eval 输出/错误模型全部 `z.infer` 出类型 |
| DB | 默认 **SQLite**，支持 **Supabase(Postgres)**；统一抽象层随时切换（见下） |
| 单测 | **Vitest** |
| e2e | **Playwright** |
| Lint / Format | **Biome**（TS：core/shared/gateway）；admin 的 `.svelte` 用 Prettier + prettier-plugin-svelte + svelte-check |

### DB 抽象层

- core 定义 **Store 端口接口**（repository pattern）：`KeyStore` / `TelemetryStore` / `ConfigStore` 等。
- 提供两个适配器：`sqlite`（默认，本地文件）、`supabase`（Postgres）。
- 运行时按 config 选择实现；core 只依赖接口，不依赖具体 DB。
- 底层使用 **Drizzle ORM**：SQLite 绑定 `better-sqlite3`，Postgres/Supabase 绑定 `postgres-js`；两套迁移与方言差异封在适配器里。

---

## 仓库结构（当前）

```text
helm-api/
  apps/
    gateway/     # Hono：API + 托管 admin 静态资源 + healthz/version
    admin/       # SvelteKit + Tailwind 管理界面
    portal/      # SvelteKit key 持有者自助门户
  packages/
    core/        # 路由/分类/provider/协议互译/Store 端口 —— 框架无关
    shared/      # Zod schema + 共享类型
  config/        # 默认 lanes/policies/classifier/providers/... yaml
  docs/          # 当前规格（01–14 + Portal）与已标注的历史/研究附录
  AGENTS.md
  implementation-notes.md
  LICENSE
```

---

## 开发流程

### TDD（强制）

**红 → 绿 → 重构**：先写失败测试，再写最小实现使其通过，再重构。不允许"先写实现后补测试"。

### 测试要求

- **单元测试（Vitest）**：覆盖 core 全部纯逻辑——规则评分、tier 边界、能力过滤、fallback 链、协议 transformer、Store 适配器、config 校验。
- **e2e（Playwright）**：覆盖关键链路——OpenAI/Anthropic 请求端到端路由、流式 SSE、协议互译、管理界面基本操作。
- **覆盖率到边际效应为止**：correctness-critical 路径（路由决策、分类、transformer、fallback、错误处理）追求高覆盖；UI 脚手架、纯胶水代码不强求。不为凑 100% 写无意义测试。
- 流式与 tool-call 翻译必须有专门 case（docs/05 的坑位逐条覆盖）。

### 常用命令（约定）

```bash
pnpm install
pnpm dev            # 仅起 admin 开发服务器（网关无 watch：跑构建产物或 Docker）
pnpm --filter @helm/portal dev # 仅起 portal 开发服务器
CI=true pnpm exec vitest run path/to/relevant.test.ts # 本机只跑定向 Vitest
CI=true pnpm --filter @helm/gateway exec playwright test path/to/relevant.spec.ts # 定向 e2e
pnpm typecheck      # tsc --noEmit
pnpm lint
pnpm build          # 构建网关 + admin + portal + ops bundle
```

---

## 代码规范

- TypeScript `strict`，无 `any`（必要时 `unknown` + 收窄）；ESM。
- Zod schema 与类型不重复定义——**先写 schema，类型用 `z.infer`**。
- **中文文档必须意译**：保留技术事实、命令、字段名、端点与链接，但按自然中文重新组织句子，不逐句照搬英文语序；`README.zh-CN.md` 是独立中文文案，不是英文 README 的机械镜像。
- 错误以结构化形式产生，由 Protocol Adapter 翻成客户端协议形态（docs/07）。
- 结构化日志，全程透传 `trace_id`。
- 提供 `/healthz` 与 `/version`（Docker 部署/升级 SOP 依赖）。
- 客户端断连视为**非 provider 故障**（不触发熔断），见 docs/02。

---

## 安全

- 强制 API key 鉴权；启动无 key 则生成一把 root key，打印一次并写入配置的 `0600` recovery file（docs/06）。
- 管理界面用 HTTP Basic；当前 `buildServer()` 的部署入口只从 `HELM_ADMIN_*` 环境变量读取（`resolveAdminAuth` 的 config 分支仅供直接调用/测试），未配凭证却显式开启时启动告警（docs/11）。
- 静态 provider 凭证经环境变量注入；OAuth token 只加密写入 Store。二者都不写进仓库或常规日志。

---

## Git 工作流

- 在分支上开发，开 PR，**CI 全绿（typecheck + lint + build + 单测 + e2e + Docker smoke）方可合并**；Playwright 是独立的 hermetic CI job；不直接推 `main`。
- Commit message 结尾带：
  `Co-Authored-By: Codex <noreply@openai.com>`
- 只有用户明确要求时才提交/推送。

---

## 实现笔记（必须维护）

实现 spec 时，持续维护根目录 **`implementation-notes.md`**，记录：

- spec 未覆盖、你不得不自己做的决定；
- 你被迫修改 spec / 偏离 spec 的地方及原因；
- 权衡取舍（为什么选 A 不选 B）；
- 任何用户应当知道的坑、限制、TODO。

新增条目追加在文件顶部，带日期与所属 spec 章节。

体积控制：`implementation-notes.md` 只保留最近 10 条可追踪记录；新增条目入栈后，保留顶部最新完整记录与历史摘要中最新的一行要点，超过 10 条的更早历史压缩进文末「更早历史总览」的一段精简概括。完整原文通过 git history 回溯。

---

## 实现约定（已拍板，细节见 implementation-notes.md）

- **能力与定价数据源**：上游取 LiteLLM 的 `model_prices_and_context_window.json`，经 `pnpm sync:catalog` 同步成**签入的 generated catalog**；运行时读 `capabilities.yaml` / `pricing.yaml`，**手动条目覆盖生成项**。**不在运行时拉取**（生成目录是供应链输入，不直接进运行时选择）。
- **provider 执行层**：在 `packages/core/src/provider` **重写**，移植 llm-router 的久经考验语义（熔断 OPEN/HALF_OPEN + 探测锁、首个有效 chunk 前记失败/后记成功、能力过滤显式 skip reason、`:free` 429 跳过、abort 不算故障）；用其现有测试当行为 checklist。**不 import llm-router**。
- **eval 缓存键**：`sha256(canonical-json)`，只哈希分类依赖输入——末条 user 消息(trim)、turn 数、排序后的 tool 名、`response_format` 是否 JSON、是否含附件/vision；稳定键序、排除易变字段、不 lowercase。TTL 默认 300s，字段集可配，实现后验命中率。

## 仍需用户决定

- 暂无（如出现 spec 与实现冲突，记入 implementation-notes.md 并在 PR 中提出）。
