# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-07-01 · Claude Code 日期指纹扩展到全部 prompt 文本面（Anthropic protocol / anti-fingerprint，docs/05/07，原则 7/8）

- **背景（Lukin）**：阅读 X 复盘后确认风险不应只按 `system` 推断；Claude Code 当前实现虽把 `currentDate` 放入系统上下文，但从防检测角度，任意会被发往 Anthropic 的 prompt 文本块只要出现同一句隐写模板，都应还原为普通字符串。
- **修复决策**：`normalizeClaudeCodeDateFingerprintInAnthropicRequest()` 不再依赖 billing header，也不再按 message role 限制；所有 `messages[].content` 的 string / `type:"text"` block 都归一化，嵌套 `tool_result.content` 也处理。
- **工具提示面**：`tools[].description` 也是会进入上游 prompt surface 的自然语言说明，同样归一化；但 `tool_use.input`、`input_schema`、`metadata` 等结构化/数据字段不递归改写，避免把用户数据或 schema 常量改坏。
- **边界**：仍只匹配精确句式 `Today[',’,ʼ,ʹ]s date is YYYY[-/]MM[-/]DD.`，统一输出 `Today's date is YYYY-MM-DD.`；这覆盖 X 文强调的「普通第三方端点 + 中国时区」即普通 apostrophe + slash 日期。
- **验证**：新增 core 测试覆盖 user/assistant/tool_result/tools description，gateway native carrier 测试覆盖 message + tools 字段；目标 Vitest 绿。

## 2026-07-01 · Claude Code 日期指纹入站归一化（Anthropic protocol / native passthrough，docs/05/07，原则 7/8）

- **背景（Lukin）**：升级最新 `claude update` 后当前最新客户端为 `2.1.197`；二进制中确认仍存在 `ANTHROPIC_BASE_URL` + `Asia/Shanghai|Asia/Urumqi` 检测，以及把 `Today's date is YYYY-MM-DD.` 改成不同 apostrophe / slash 日期格式的逻辑。
- **风险**：Helm 的 `/v1/messages` 会把 Claude Code 原始 Anthropic body 同时转换成 IR，并作为 `native_request` 交给 native passthrough；如果不处理，日期指纹会在互译路径和 byte passthrough 路径继续到达上游。
- **修复决策**：新增 core 纯函数 `normalizeClaudeCodeDateFingerprintInAnthropicRequest()`，只还原精确日期句式：`Today[',’,ʼ,ʹ]s date is YYYY[-/]MM[-/]DD.` → `Today's date is YYYY-MM-DD.`；默认只处理 top-level `system` 与 `system/developer` message，若检测到 Claude Code billing header，则也处理 message 文本块以覆盖动态 system sections 被移到消息里的形态。
- **passthrough 决策**：`request_payloads.request_json` 保留客户端原始输入用于审计；`native_request.body/raw_body` 使用归一化后的 body，并在 mutation ledger 记录 `body_shims_applied=["claude_code_date_fingerprint_normalized"]`，避免隐式改写。
- **验证**：新增 core 纯函数测试与 gateway native carrier 回归；`pnpm vitest run packages/core/src/protocol/anthropic/request.test.ts packages/core/src/protocol/anthropic/date-fingerprint.test.ts apps/gateway/src/routes/messages.test.ts` 122/122 绿，`pnpm typecheck` 绿，触碰文件 Biome 绿，全仓 `pnpm lint` 退出 0（仅既有 style info）。全量 `pnpm test` 4888/4890 绿后被 2 个 PGlite 15s timeout 拦住，两个失败文件单独重跑均绿。

## 2026-07-01 · admin telemetry 聚合改为列化延迟 + 覆盖索引（Admin observability / store，docs/07/11，原则 7）

- **背景（Lukin）**：生产 SQLite 数据库约 22GB，`/admin/api/stats` 在 7d/30d 窗口可跑到 100s+；由于 SQLite 适配器使用同步 `better-sqlite3`，这类长统计会阻塞 Node event loop，让其它管理端 API 看起来也一起卡住。
- **根因**：`TelemetryStore.aggregate()` 的 totals 查询仍从 `decision_json` 里 `json_extract('$.latency_total_ms')` 计算平均延迟；在大窗口下这会强制逐行读 telemetry 大 JSON 并解析。series / byModel / usage 也依赖同一时间窗扫描，缺少覆盖索引时会回表读取更多页面。
- **修复决策**：新增 `telemetry.latency_total_ms` 普通列，写入时从 `DecisionRecord.latency_total_ms` 列化；SQLite v32 / Postgres v31 对历史行从 JSON 回填该列，并把 aggregate 的 `AVG` 改为读普通列。
- **索引决策**：新增两条管理端聚合覆盖索引：全局窗口以 `created_at` 开头，key 详情窗口以 `(api_key_id, created_at)` 开头，并覆盖 status/cost/tokens/cache/generation/model/key 字段。目标是让 dashboard 三个聚合 shape 尽量扫描窄索引页，减少 JSON 解析和回表。
- **范围限制**：本次不改 admin 路由返回形状，也不引入物化日报表；先消除确认过的同步慢查询放大器。若未来 telemetry 增长到百万级以上，再考虑后台 rollup 表或异步 worker。
- **验证**：新增 SQLite/PG 迁移回填测试、SQLite “篡改 decision_json 后 aggregate 仍读列化延迟”测试、跨适配器 aggregate 延迟契约；全量 `pnpm test` 4887/4887 绿，`pnpm typecheck`、`pnpm build` 绿。

---

## 历史条目摘要（最近 7 条）

- **2026-06-30 · admin favicon cache policy（Admin UI 静态资源，docs/11，原则 7）**：favicon 慢不是体积问题，而是 `/admin` 静态资源 no-cache 策略；`/admin/favicon.{svg,png}` 改私有缓存 7 天，SPA shell/deep-link fallback 仍 no-cache，admin shell 只声明 SVG 避免双拉；补 gateway/admin 回归测试。
- **2026-06-30 · per-model reasoning effort policy（执行 fallback / 协议转换，docs/04/05，原则 2/5/8）**：新增 catalog `reasoningEffort` policy，按模型/协议 wire 字段映射或删除 unsupported effort；Haiku 4.5 保留 manual `thinking` 但删除 `output_config.effort`，Sonnet `xhigh -> max`，translated/native passthrough 回归覆盖。
- **2026-06-30 · Anthropic `output_config.effort` 与 OpenAI `reasoning_effort` 双向保真（协议转换/执行 fallback，docs/05/04，原则 5/8）**：Anthropic 入站 `output_config.effort` 提升到 IR `reasoning_effort`，OpenAI/Responses fallback 保留推理等级；反向 GPT/OpenAI→Anthropic 在无显式 output_config 时合成 `output_config.effort`；只映射等级字段，不从 `thinking.budget_tokens` 反推。
- **2026-06-30 · Fast mode 账号强制覆盖 + API key 透传限制（OAuth subscription provider / key governance，docs/04/11，原则 2/5）**：账号级 `fastMode` 统一映射到 Codex `service_tier:"priority"` 与 Anthropic `speed:"fast"` + beta header，并强制覆盖 provider wire request；per-key `allow_fast_mode` 只治理客户端透传，不阻止账号级强制启用；UI 仅对支持 provider 展示。
- **2026-06-30 · OAuth 5h 限额恢复时间不再落回 60s（admin/gateway，docs/04，原则 5）**：已 park 账号的 generic 60s 429 fallback 改用 near-full (`>=95%`) 窗口推断真实恢复时间，避免 Anthropic 5h 98–99% 限额显示 `0m`；健康账号仍不因 98% 预先 park。验证 core/gateway/admin 相关测试、全量 test/typecheck/svelte-check/biome/build 绿，发 v0.22.27。
- **2026-06-29 · OAuth 配额冷却 extend-only + refresh-429 归账号级（Codex review 跟进；provider 执行/池）**：修复 Codex quota 精确长 reset 被 generic 60s 429 覆盖的问题（park/applyUsageLimit 改 extend-only，清除仍直通）；同时把 `TokenRefreshError(429)` 纳入 pool 与 executor 的账号级 rate-limit 分类，避免 refresh 限流污染 alias breaker。验证 pool/executor 矩阵、typecheck、biome、build 绿，发 v0.22.24。
- **2026-06-29 · OAuth 单账号故障不再污染 alias 级熔断（provider 执行；docs/04，原则 5）**：OAuth pool 内部拦截账号级 `TokenRefreshError(400/401/403)`、上游 `401/403` 与 `429`，按账号 park/冷却并请求内 sibling 重试；executor 只对账号级故障跳过 alias breaker，整池 5xx/transport 故障仍记 breaker。验证 pool/executor/server OAuth 回归绿。

## 更早历史总览

2026-06-28 及以前的工作主要围绕 Helm API 的协议面、路由执行、admin 可观测性与自托管部署逐步成型：补齐 Gemini/OpenAI/Anthropic/Responses 双向转换、SSE 流式正确性、tool-call/JSON schema/思考参数保真、模型别名与能力/成本目录、provider fallback 与熔断语义、OAuth subscription providers、多账户池与 quota 处理、memory observe/inject/forgetting/admin/MCP、请求 payload 捕获与 request detail UI、API key 治理、admin 表格/过滤/分页/i18n、Docker/CI/release/deploy 验证，以及早期 Phase 0 的 Hono + SvelteKit static admin + Store 端口 + SQLite/Supabase 架构决策。更早细节不再逐条保留在本文件；需要精确背景时回查 git history。
