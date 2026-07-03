# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-07-03 · 策略级 reasoning_effort 覆盖 Lane 默认值（Routing policies / Admin policies，docs/04/11，原则 2/5/6）

- **背景（Lukin）**：Lane 已支持 `reasoning_effort`，但 policy 命中后只能强制车道，不能针对某类任务把思考等级调高/调低；这导致同一 Lane 内的请求无法按策略更细粒度控制推理预算。
- **语义决策**：Policy 新增可选 action `reasoning_effort`，与 Lane 使用同一严格枚举：`none|minimal|low|medium|high|xhigh|max`。最终优先级为 **policy > selected lane > client request**；其中 `none` 是显式覆盖，可关闭 Lane 的高思考等级。
- **first-match 决策**：`reasoning_effort` 跟 `use_lane` 一样取第一条命中 policy 的值；`allowed_lanes` 仍保持原有“所有命中策略取交集”的 cap 语义。这样不会让靠后的 restrict-only rule 意外改写思考等级。
- **执行路径**：`routeRequest` 在生成 `ExecutionPlan` 后用 `policy.reasoning_effort ?? lane.reasoning_effort` 覆盖 `req.reasoning_effort` 并设置 `reasoning_effort_forced=true`，复用现有 translated/native passthrough 出站改写链路，不触碰 provider 选择与 fallback 机制。
- **Admin 决策**：Policies 页面新增“Forced reasoning effort”下拉，复用 LaneEditor 的同一组选项；API client round-trip `reasoning_effort`，gateway 仍由 `PoliciesConfigSchema` 对整个 policy 列表 fail-closed 校验。
- **验证计划**：新增 shared/core policy schema、policy engine、routeRequest、admin API client、PolicyRow 回归测试；再跑目标 Vitest、typecheck/lint/build。

## 2026-07-03 · cron monitor 自动化请求降到低成本规则（Classifier / routing，docs/03/04，原则 2/4）

- **背景（Lukin）**：生产 `openclaw` key 的 monitor/cron 请求常请求 `gpt-5.4-mini`，但因 key 不允许 custom model，路由走分类器；请求带长历史、36 个左右工具和 `MONITOR.md` 文件路径，Layer-1 把它判成 `coding/medium`，最终第一候选落到 `openai-codex/gpt-5.5`。
- **根因**：这些工具和文件路径是自动化探针的环境能力，不代表当前用户 turn 是 coding 任务；`tools_floor`、`tool_count`、`detectFilePath()` 叠加后把“检查状态，无事不回复”的低成本请求误升到 coding/balanced 级别。
- **规则决策**：新增 `classifier.rules.overrides.low_cost_automation`，只有同时命中 `intent_markers`（如 `[cron:`、`MONITOR.md`）和 `no_reply_markers`（如 `NO_REPLY`、`nothing to action`）时，才 set 到 `simple`；普通“解释 NO_REPLY”不会触发。长历史不再让该自动化探针升档，真实窗口适配交给后续 capability filter。
- **task_type 决策**：低成本自动化模式下，task detector 忽略 ambient tool-prefix 和 file-path 证据，但仍保留显式 coding keyword（如 `debug/refactor/function`）的升级路径，避免真正要修代码的 monitor 任务被错误降级。
- **验证计划**：新增 openclaw cron monitor golden route 回归、override 单测、taskdetect 单测和 schema 默认值测试；目标是该形态走 `chat/simple/economy`，链首回到 `openai-codex/gpt-5.4-mini`。

## 2026-07-03 · 上下文窗口超限按候选跳过处理（执行 fallback / streaming telemetry，docs/04/07，原则 5/8）

- **背景（Lukin）**：生产请求 `69d5058f-ea6c-4bfc-91d8-0686a7c120f3` 最终由 `anthropic/claude-opus-4-8` 成功服务，但链中 `openai-codex/gpt-5.5` 先返回 Responses stream `context_length_exceeded`，admin 详情把它显示为普通 `upstream_error`。
- **修复决策**：`context_length_exceeded` / “context window” / “prompt is too long” 属于当前候选模型窗口不足；即使它来自首个有效输出前的 SSE error 且没有 HTTP 400，也记录为 `skipped:true` + `skip_reason:"context_too_small"`，继续执行 fallback。
- **熔断决策**：该类错误不调用 `breaker.recordFailure()`，不触发 OAuth 账号 auto-park，也不计入 execution fallback count；它和预检能力过滤的 `context_too_small` 语义保持一致。
- **保留边界**：非上下文类 request-shape 错误（例如图片尺寸超限、非法参数）仍短路为 `invalid_request`，因为换候选模型无法修复请求体本身。
- **验证**：新增执行器 stream 回归测试，覆盖 Codex Responses `context_length_exceeded` 先失败、后续 Opus 成功、首个 attempt 显示跳过且不记录 breaker failure；目标 `execute.test.ts` 117/117 绿。

## 2026-07-03 · API key 级 usage stats 给外部自动化读取（Gateway usage API / telemetry，docs/07，原则 7）

- **背景（Lukin）**：Skillstore 公开页需要每天同步 AI audit token / cost 快照；旧办法直接从 Helm SQLite 和 claude-relay Redis 取数，不适合作为长期自动化接口。新的来源应主要走 Helm 系统，并通过 API key 读取统计数据。
- **接口决策**：新增 `GET /v1/usage/stats`，复用现有 API-key auth，不挂 admin Basic Auth。默认 `start=0`、`end=now`，返回当前 key 的累计 request/token/cost 汇总；仍接受 `start/end/bucket/tzOffsetMinutes` 以便后续做日窗口或趋势同步。
- **隔离决策**：接口忽略 caller 传入的 `key_id`，只使用 `authMiddleware` 解析出的 `identity.keyId` 调 `TelemetryStore.aggregate(..., keyId)`；这样 Skillstore workflow 只能读它自己的 Helm key，不可能枚举其它 key 的用量。
- **返回形状**：返回紧凑 snake_case 机器格式：`prompt_tokens`、`completion_tokens`、`total_tokens`、`cost_usd` 等，避免让下游 workflow 依赖 admin dashboard 的 series/byModel 大结构。
- **限制 / TODO**：该接口反映 Helm telemetry 当前保留窗口内的数据；历史上还在 claude-relay 的用量需要 Skillstore 侧保留 legacy baseline 或临时兼容同步，等所有 audit 入口完全切到 Helm 后再移除 relay 补数。
- **验证计划**：新增 route 测试覆盖缺 key 401、当前 key 聚合、恶意 `key_id` 被忽略；OpenAPI 加入 bearer-secured usage endpoint。

## 2026-07-02 · API key 加密恢复与原地轮转（Auth / Admin keys，docs/06/11，原则 7）

- **背景（Lukin）**：管理后台原本只能创建后一次性显示 API key；如果操作员没有保存完整 key，只能删除或重新创建。现需支持查看已存在 key 的完整值，并支持不丢历史的轮转。
- **安全决策**：鉴权路径仍只用 `sha256(plaintext)` 查找；数据库不保存明文 key。新增 `api_keys.secret_enc` 只保存 AES-GCM 密文，复用 `HELM_OAUTH_ENC_KEY` 作为 at-rest 加密密钥。未配置该密钥时，新建/轮转仍返回一次性 plaintext，但后续 reveal 不可用。
- **兼容决策**：已有 hash-only 行无法从 sha256 反推出完整 key，因此管理后台 reveal 会明确返回不可恢复；操作员可对该行执行 rotate，让同一个 `key_id` 获得新的 hash/prefix/secret_enc。
- **轮转决策**：`KeyStore.rotateKey()` 只替换 `hash`、`prefix`、`secret_enc`，保留 `key_id`、name、role、account、caps、usage 与 telemetry 关联。旧 key 值立即失效，但请求历史仍挂在同一 key 下。
- **UI 决策**：Keys 页面新增「View full key」和「Rotate」。Reveal/rotated plaintext 只存在短暂 modal state；普通 list/detail 仍只显示 prefix，不返回 hash、plaintext 或 ciphertext。
- **验证计划**：覆盖 store contract（SQLite/Postgres）、cached keystore、admin routes、admin API client 与 Keys 页面交互；旧 hash-only 行 reveal 失败、新/轮转行可 reveal。

## 2026-07-02 · Claude Fable 周限额改读 `limits[]`（Admin providers / OAuth quota，docs/11，原则 3/7）

- **背景（Lukin）**：Claude Code 的 Plan usage limits 已把 scoped weekly model 用量显示为 `Fable`，不再是旧的 Sonnet 专项行；本机真实 `GET https://api.anthropic.com/api/oauth/usage` 返回中，`seven_day_sonnet` 为 `null`，而 `limits[]` 包含 `kind:"weekly_scoped"` + `scope.model.display_name:"Fable"`。
- **修复决策**：Anthropic quota parser 优先读取新的 `limits[]`：`session -> 5h`、`weekly_all -> 7d`、`weekly_scoped -> 7d-{model-slug}`，例如 Fable 变成 `7d-fable`；旧 top-level `five_hour/seven_day/seven_day_opus/seven_day_sonnet` 只作为 fallback，保证老 payload 继续可读。
- **UI 决策**：providers 页 quota label 增加 `7d · Fable`，并为未来 `7d-*` scoped key 提供通用标题化 fallback；避免下一次 Claude 增加 scoped model 时页面又退回原始 key 或显示旧 Sonnet。
- **价格决策**：`anthropic/claude-fable-5` 已按官方 Anthropic 价格配置为 input `$10/M`、output `$50/M`、cache hit `$1/M`、5-minute cache write `$12.50/M`；官方还有 1-hour cache write `$20/M`，但当前 Helm pricing schema 只有一个 `cacheWritePerMTokUsd`，所以仍记录 5-minute rate，避免在本次小修里扩大 telemetry schema。
- **验证**：真实上游 usage payload 与 `/v1/models` 已本机核验；新增 parser、gateway quota pull、providers 页面回归测试。目标 parser/admin 页面测试与 typecheck 绿；gateway SQLite 相关测试仍被本机 `better-sqlite3` Node ABI 不匹配阻塞。

## 2026-07-02 · OAuth 测试成功与 quota PULL 同步账号可用状态（Admin providers / OAuth cooldown，docs/04/11，原则 3/5/7）

- **背景（Lukin）**：生产中 `riverathomas6094@outlook.com` 已能通过单账号 Test 成功返回，但 providers 页仍因旧 `usage_limited_until_ms` 显示“已限流 / 3 天后恢复”，正常路由池也继续跳过该账号。
- **修复决策**：`GET /admin/api/oauth/quota` 对“已 park 账号”把成功 quota PULL 视作可信状态同步：窗口 near-full 时用真实恢复窗口 `replace` 旧 cooldown；窗口干净时清空 cooldown；未 park 账号仍不会因 PULL 预先 park。
- **测试路径决策**：Providers 页 Test 仍使用独立 per-account client，不写 request telemetry / payload，也不扰动主路由 breaker；但测试成功会写入 `oauth_usage` 并清空旧 auto-park cooldown，因为它消耗真实上游额度且证明账号当前可用。
- **UI 决策**：Test 成功后自动 `invalidateAll()`，让状态 pill、Today 用量和 quota/cooldown 立即重新读取，而不是要求操作员手动刷新。
- **验证**：新增 admin OAuth route 回归覆盖干净窗口清 cooldown、旧 7d cooldown 替换为 active 5h、Test 成功记录用量并清 cooldown；目标 Vitest 53/53 绿，typecheck / build 绿。本机全量 SQLite 测试受 `better-sqlite3` Node ABI 不匹配阻塞，非业务断言失败。

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

## 历史条目摘要（最近 2 条）

- **2026-06-30 · admin favicon cache policy（Admin UI 静态资源，docs/11，原则 7）**：favicon 慢不是体积问题，而是 `/admin` 静态资源 no-cache 策略；`/admin/favicon.{svg,png}` 改私有缓存 7 天，SPA shell/deep-link fallback 仍 no-cache，admin shell 只声明 SVG 避免双拉；补 gateway/admin 回归测试。
- **2026-06-30 · per-model reasoning effort policy（执行 fallback / 协议转换，docs/04/05，原则 2/5/8）**：新增 catalog `reasoningEffort` policy，按模型/协议 wire 字段映射或删除 unsupported effort；Haiku 4.5 保留 manual `thinking` 但删除 `output_config.effort`，Sonnet `xhigh -> max`，translated/native passthrough 回归覆盖。

## 更早历史总览

2026-06-28 及以前的工作主要围绕 Helm API 的协议面、路由执行、admin 可观测性与自托管部署逐步成型：补齐 Gemini/OpenAI/Anthropic/Responses 双向转换、SSE 流式正确性、tool-call/JSON schema/思考参数保真、模型别名与能力/成本目录、provider fallback 与熔断语义、OAuth subscription providers、多账户池与 quota 处理、memory observe/inject/forgetting/admin/MCP、请求 payload 捕获与 request detail UI、API key 治理、admin 表格/过滤/分页/i18n、Docker/CI/release/deploy 验证，以及早期 Phase 0 的 Hono + SvelteKit static admin + Store 端口 + SQLite/Supabase 架构决策。更早细节不再逐条保留在本文件；需要精确背景时回查 git history。
