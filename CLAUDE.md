# CLAUDE.md — Helm API

Helm API 是一个**开源、自托管**的 LLM 路由网关（"LLM 世界的 nginx"）。完整规格见 [`docs/`](docs/)（按 01–11 编号阅读）。本文件只放**实现时必须遵守的原则与约定**，不重复 spec 内容。

---

## 核心原则（不可妥协）

1. **网关与 UI 解耦**：核心网关（路由、分类、provider 执行、协议互译、存储）必须能**脱离管理界面 headless 独立运行**。core 逻辑不得 import 任何框架（Hono / SvelteKit）。
2. **配置即代码**：行为由 `config/*.yaml` + 环境变量驱动，不靠改代码。配置加载用 Zod 校验，**非法配置 fail-closed（拒绝启动）**，绝不带病运行。**唯一例外（已拍板）：observer 记忆压缩是网关内部自适应行为，刻意零配置**——价格/上下文窗口从 model catalog 自动解析（价格 pin 走 `pricing.yaml`）、工作负载统计从存储数据现场推导、专家先验是代码常量（`AUTO_PRIORS`）；不暴露调参面，遗留 `config.memory.observer` 块拒绝启动。理由：会"撒谎"的旋钮比没有旋钮更糟（旧 economy 模式 17 个手调参数从未投产且多处与实现脱节），自适应输入让配置无可配。
3. **fail-open 路由**：分类/eval/缓存等任何辅助环节失败，都不得让请求 5xx——降级到 `balanced` 并记录。只有"所有 provider 都失败"才返回结构化错误。
4. **确定性优先**：第 1 层规则是纯函数、零网络、可单测；eval（第 2 层）`temperature:0`、默认关闭、带缓存。
5. **两种 fallback 分清楚**：分类兜底（→ balanced）与执行兜底（→ 链内下一个 model）是两套机制、两套日志字段，绝不混淆（见 docs/03、04）。
6. **暴露 lane 抽象，不暴露模型市场**；provider 别名是内部供应链细节。
7. **密钥安全 + 正文可观测**：API key **只存 sha256 哈希**，遥测/日志/payload 表绝不出现明文 key（bearer 在 Authorization 头里，不在 chat 正文中）。**完整 request/response 正文按运行时设置 `capture_payloads`（默认开）记录到独立的 `request_payloads` 表**，便于调试与审计；可在管理界面「系统设置」随时关闭，并按 `payload_retention_days` 自动清理。`DecisionRecord` 仍保持脱敏（不含正文）作为纵深防御。
8. **流式正确性是头号风险**：协议互译的 SSE 事件映射（见 docs/05）必须有针对性测试覆盖。

---

## 技术栈（已定）

| 层 | 选型 |
|---|---|
| 语言 | TypeScript（`strict: true`，ESM，Node 22+） |
| 包管理 | **pnpm**（workspace 单仓多包） |
| API / 网关 | **Hono**（Web 标准、`streamSSE`、可 headless）—— 不用 SvelteKit SSR 当 API |
| 管理界面 | **SvelteKit + Tailwind**，`adapter-static`(SPA) 打包，由 Hono 在 `/admin` 托管 |
| 校验 | **Zod**——schema 是**类型唯一来源**，内部请求/配置/eval 输出/错误模型全部 `z.infer` 出类型 |
| DB | 默认 **SQLite**，支持 **Supabase(Postgres)**；统一抽象层随时切换（见下） |
| 单测 | **Vitest** |
| e2e | **Playwright** |
| Lint / Format | **Biome**（TS：core/shared/gateway）；admin 的 `.svelte` 用 Prettier + prettier-plugin-svelte + svelte-check |

### DB 抽象层

- core 定义 **Store 端口接口**（repository pattern）：`KeyStore` / `TelemetryStore` / `ConfigStore` 等。
- 提供两个适配器：`sqlite`（默认，本地文件）、`supabase`（Postgres）。
- 运行时按 config 选择实现；core 只依赖接口，不依赖具体 DB。
- 底层 SQL 建议用 **Drizzle ORM**（同时支持 SQLite + Postgres + 迁移），方言差异封在适配器里。

---

## 仓库结构（建议）

```text
helm-api/
  apps/
    gateway/     # Hono：API + 托管 admin 静态资源 + healthz/version
    admin/       # SvelteKit + Tailwind 管理界面
  packages/
    core/        # 路由/分类/provider/协议互译/Store 端口 —— 框架无关
    shared/      # Zod schema + 共享类型
  config/        # 默认 lanes/policies/classifier/providers/... yaml
  docs/          # 规格（01–11）
  CLAUDE.md
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
pnpm test           # Vitest 单测
pnpm test:e2e       # Playwright
pnpm typecheck      # tsc --noEmit
pnpm lint
pnpm build          # 构建网关 + admin 静态资源
```

---

## 代码规范

- TypeScript `strict`，无 `any`（必要时 `unknown` + 收窄）；ESM。
- Zod schema 与类型不重复定义——**先写 schema，类型用 `z.infer`**。
- 错误以结构化形式产生，由 Protocol Adapter 翻成客户端协议形态（docs/07）。
- 结构化日志，全程透传 `trace_id`。
- 提供 `/healthz` 与 `/version`（Docker 部署/升级 SOP 依赖）。
- 客户端断连视为**非 provider 故障**（不触发熔断），见 docs/02。

---

## 安全

- 强制 API key 鉴权；启动无 key 则生成一把 root key 并打印一次（docs/06）。
- 管理界面用 HTTP Basic（账号密码经配置/环境变量），未配置且开启时启动告警（docs/11）。
- 上游 provider 凭证经环境变量注入，不写进仓库、不回显。

---

## Git 工作流

- 在分支上开发，开 PR，**CI 全绿（typecheck + lint + build + 单测 + Docker smoke）方可合并**；e2e（Playwright）在本地跑，不在 CI 门禁内；不直接推 `main`。
- Commit message 结尾带：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 只有用户明确要求时才提交/推送。

---

## 实现笔记（必须维护）

实现 spec 时，持续维护根目录 **`implementation-notes.md`**，记录：

- spec 未覆盖、你不得不自己做的决定；
- 你被迫修改 spec / 偏离 spec 的地方及原因；
- 权衡取舍（为什么选 A 不选 B）；
- 任何用户应当知道的坑、限制、TODO。

新增条目追加在文件顶部，带日期与所属 spec 章节。

**体积控制**：该文件只保留**最近 3 条**完整记录；新条目入栈时，把被挤出前三的条目压缩成一行要点（保留日期、标题、关键决定/坑/TODO），移入文末「历史条目摘要」。完整原文经 git history 回溯。

---

## 实现约定（已拍板，细节见 implementation-notes.md）

- **能力与定价数据源**：上游取 LiteLLM 的 `model_prices_and_context_window.json`，经 `pnpm sync:catalog` 同步成**签入的 generated catalog**；运行时读 `capabilities.yaml` / `pricing.yaml`，**手动条目覆盖生成项**。**不在运行时拉取**（生成目录是供应链输入，不直接进运行时选择）。
- **provider 执行层**：在 `packages/core/src/provider` **重写**，移植 llm-router 的久经考验语义（熔断 OPEN/HALF_OPEN + 探测锁、首个有效 chunk 前记失败/后记成功、能力过滤显式 skip reason、`:free` 429 跳过、abort 不算故障）；用其现有测试当行为 checklist。**不 import llm-router**。
- **eval 缓存键**：`sha256(canonical-json)`，只哈希分类依赖输入——末条 user 消息(trim)、turn 数、排序后的 tool 名、`response_format` 是否 JSON、是否含附件/vision；稳定键序、排除易变字段、不 lowercase。TTL 默认 300s，字段集可配，实现后验命中率。

## 仍需用户决定

- 暂无（如出现 spec 与实现冲突，记入 implementation-notes.md 并在 PR 中提出）。
