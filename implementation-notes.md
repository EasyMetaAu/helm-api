# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-08-10 · 配额统计按真实重置点切分（OAuth quota / Admin providers，docs/04/11，原则 3/7）

- **根因**：旧 writer 在 `resetsAtMs` 推进时写入 `[oldReset,newReset)`，把新周期误当成已结束历史；自然周 UI 又掩盖了 OpenAI 提前重置、reset-credit 重置和非整点边界，所以“每周”并不等于真实额度周期。
- **实现**：复用既有 `oauth_reset_period`，统一记录刚结束的 `[previousStart,actualResetAt)`；PULL、Codex header PUSH、手动/自动 reset-credit 共用记录入口。quota snapshot 按 `capturedAt` 单调更新，晚到的旧采样既不覆盖新状态，也不写伪 reset。旧版 `detectedAtMs < periodEndMs` 行只在读取时忽略，不改写历史库；本地“Reset usage”仍只清 Helm cooldown，不冒充上游重置。
- **精度边界**：usage 继续按小时聚合，但真实重置发生在小时中间时，新请求的 bucket 起点提升到最近 reset point，因此不会再跨边界混入上一周期。部署前已经落入旧整点 bucket 的历史数据不可逆，继续标 `≈`/`partial`；新记录到的真实边界作为精确周期返回。Admin 默认显示 Period，并保留 Daily / Weekly 兼容视图。

## 2026-08-10 · 大 Session 客户端重建按记录时间展示并提前停止分页（Admin / requests debug，docs/07/11，原则 1/3/7）

- **现场与根因**：生产 v0.28.56 的目标详情点击后约 46 秒才完成，普通 Conversation 把重建后的请求 `input` 与最终响应折成一条聊天；现场原始 `input` 自身就是角色分段排列，因此 UI 没有再次排序，但这种折叠不能代表 Session 的真实请求/响应发生顺序。大 Session 客户端路径还丢弃了目标 revision 已保存的 `responseJson`，所以最终响应只能退化成脱敏 metadata。
- **展示修复**：raw revision API 增加已有的 `sequence` 与 `createdAt`；浏览器把每个 revision 的 request delta / response snapshot 组成记录，按 `createdAt` 升序、`sequence` 稳定打破同毫秒并列，并统一复用现有 `JsonViewer`。目标请求和目标响应也分别进入原有 Request / Response JSON viewer；大 Session 不再经过普通 Conversation lens，避免把“请求文档顺序”误称为“会话时间线”。
- **加载加速**：浏览器一旦收到目标 revision 就停止游标分页，不再下载该目标之后的同 Session revision；行上限从 50 恢复到 100，单页 `maxBytes=8 MiB` 不变，所以服务端单请求正文物化上限不扩大。没有改成多进程/并发请求，因为下一页游标依赖上一页的 soft-byte 结果，并发会产生跳页或重复读取风险。
- **边界**：时间线展示的是持久化的增量 request delta 与可用 response snapshot，不伪装成原始 HTTP body；Session 恢复仍是 `exact=false`、不可精确 Retry。响应为空表示当时没有可用快照，不补造内容。

## 2026-08-08 · Grok Imagine 仅复用 SuperGrok OAuth 媒体链路（Grok media spec §2/6–10/13）

- **凭证与上游边界**：客户端 `helm_live_*` 只做 Helm 鉴权；媒体执行复用后台已连接 xAI 订阅账号的 OAuth bearer。文本仍去 `cli-chat-proxy.grok.com/v1`，图片/视频固定去 `api.x.ai/v1`，不保留官方 `XAI_API_KEY` 分支。
- **任务归属**：MVP 复用 `ResponsesRegistryStore`，以 `video-create:${helm_request_id}` 先占位、`video:${upstream_request_id}` 原子映射；poll 同时绑定 Helm account、原 key、provider 和 OAuth account。这个选择避免新建 `MediaTaskStore`，代价是 key 轮转后不能接管旧任务，长期历史/取消/reconcile UI 仍需未来独立任务模型。
- **付费单写**：图片 generation/edit 与视频 start 一旦进入媒体执行就不重放 POST、不切 provider、不切 OAuth sibling；timeout、断线、无法确认的 5xx/成功响应及 registry 映射失败统一为 `outcome_unknown`。视频 poll 是固定原账号的只读 GET，可在同账号内刷新一次 401 bearer。
- **预算与正文**：没有可信媒体价格时 `cost_usd:null`；带美元 spend cap 的 key 在 create 前以 `media_pricing_unavailable` fail-closed。data URL 进入既有 blob externalizer，捕获的 HTTP(S) URL 删除 query/fragment。
- **后台模型投影**：xAI 文本 discovery 继续保持 fail-closed；Providers 账号卡片与“管理模型”接口在 auto 模式合并三个已验证媒体 alias，manual 模式严格服从账号 allowlist。媒体项不写入文本 discovery。现有“连通性测试”只验证流式聊天，因此 UI 排除媒体 alias，服务端也在上游调用前以 400 拒绝，不能借测试按钮隐式创建付费媒体任务。
- **审查后收紧**：媒体 alias 在 auto 模式默认可用，但 manual 模式严格服从每个账号的 `enabledModels`；视频模型和单图/多参考图 schema 一一绑定，聊天协议在执行前拒绝 xAI `outputImage` 与所有 `outputVideo` 模型，同时保留 Gemini 等供应商通过原生聊天协议返回图片的既有能力。OAuth pool 在付费 POST 前回报所选账号，视频 reservation 先持久化账号，图片/视频的 `outcome_unknown` telemetry 也保留账号归因；原子媒体 reservation 复用 registry 的节流 prune，但 reservation 已成功后 prune 失败按辅助维护 fail-open，避免把成功的付费单写误报为 `outcome_unknown`；Providers 卡片优先展示媒体 badge。
- **刻意延后**：ZDR `output.upload_url` 在 request/upstream/response/error 四类正文都完成预签名 query 脱敏前由严格 schema 拒绝；本机 SuperGrok 图片/视频真实 canary 已通过，staging canary、GitHub Docker CI 与生产单副本观察仍是发布 No-Go 门禁。

## 2026-08-08 · 会话转录客户端重建，绕开服务端内存阀（Admin / requests debug，docs/07，原则 1）

- **现场**：未捕获正文的长 Codex/Responses 会话，请求详情页显示「会话转录过大，无法安全恢复」。数据都在（`session_revisions` 纯 TEXT 增量），但服务端重建 `getSessionRequest`（`apps/gateway/src/routes/admin/requests.ts`）在拉第一页前就 `responseAdmission.acquire(recoveryMaxWireBytes=响应窗口/放大/2)` 预留整窗内存；长链超阀 → `session_recovery_limited`。这是**故意保守**：admin 看后台不该和线上流量抢内存。
- **方案（Lukin 拍板"吐给客户端自己重建"）**：新增 `GET /admin/api/requests/:id/session-revisions?after=<seq>`，只分页流式吐 raw revision 行（固定 `maxBytes=4MB`/页 + `limit=100`，`nextSequence` 游标），**不做服务端重建、不预留整窗**。前端 `session_recovery_limited` 分支换成「点击加载」懒加载按钮 → 循环拉页攒链 → 浏览器本地重建 → `JsonViewer` 渲染。服务端常驻内存降到「一页」。旧服务端重建路径保留（小转录仍走它，快）。
- **架构取舍（AskUserQuestion 敲定）**：重建纯函数 `restoreSessionRevisionJson` 从 `packages/core/src/store/session-delta.ts` 抽到 **`@helm/shared`**（零 node 依赖、浏览器安全），core 反向 re-export（barrel 与调用方无感）；写入侧 `splitSessionRequestJson`/`hashEvents`（依赖 `node:crypto`）留在 core。admin `lib/api/requests.ts` **破例 import** shared 的这一个纯函数——打破该文件「零 core/gateway 业务逻辑」红线，理由：复制重建逻辑违反 DRY 更糟。破例已在两处注释标明。
- **坑**：① 不能让 admin `import "@helm/core"`——core barrel 拽入 better-sqlite3/postgres/undici，浏览器 bundle 炸。② `session-revisions` 端点检查顺序：先取 sessionRef（`no_session` 更根本）再 null-check `listSessionRevisionsPage`（`session_unavailable`）。③ e2e/单测跑前须 `pnpm --filter @helm/{shared,core} build`——gateway e2e test-server 从 dist 解析 `@helm/core`，改 shared 后 core dist 会过期报 `runtimeResponseWorkAdmission` 缺失（红鲱鱼，非本改动）。④ 新增 5 个 UI 字符串须同步 7 locale + 加进 `request-detail-locales.test.ts` 的 `requestDetailPayloadKeys`（CI 门槛，要求 zh/ja/ko 真译文 ≠ 英文）；旧 key `...recover safely.` 变成孤儿但对齐无害（未跑 i18n:extract 清理）。

## 2026-08-07 · 真上游上下文溢出短路直返 400，不再 fall back（Gateway / execution chain，docs/03/04/07，原则 3/5）

- **现场（box 12a22879）**：客户端请求 `claude-opus-5`（anthropic passthrough），链上 anthropic/opus-4-8 与 sonnet-5 都真上游 400 `prompt is too long: N > 1000000`，被当作 `context_too_small` skip，一路 fall back 到 `openrouter/deepseek-v4-pro`（更大窗口）**成功返回 200**。客户端拿到成功响应→永不触发 context compaction→下一轮请求只会更长。透传场景尤其致命：Claude Code / Codex 靠收到 4xx 才压缩。
- **根因**：`#702`（v0.28.43）的设计是「真上游溢出当 skip 继续 fall back，只在**链条耗尽**时由 `authoritativeShapedOverflow` 返回 400」。但只要链上有一个更大窗口模型兜住（deepseek 返回 200），链条就没耗尽，那段终态逻辑永远走不到。「让更大 sibling 试」的假设直接破坏了压缩语义。
- **修复（Lukin 拍板"遇到一个上下文太大就直接返回，不要往后走"）**：`isContextWindowRejection(err)` 命中的分支从 `skip + continue` 改为**短路返回 400**（`error_class:invalid_request`，原样透传上游 `provider_raw`），形态对齐紧邻的 `isUpstreamRequestRejection` 短路模板。不记熔断（上游健康、错的是请求），不算 execution-fallback。
- **刻意的边界（AskUserQuestion 敲定）**：**仅真上游 400 短路**。预检估算两条路径——能力过滤近似估算（`execute.ts` ~1776）与 `count_tokens` 精确预检（~1863）——**仍 skip 继续 fall back**，因为估算可能偏保守，更大真实窗口的模型也许真能服务。这两条继续走 `contextOverflow` + `contextConfirmations`（≥2 确认）的链条耗尽终态。
- **清理死代码**：真上游溢出短路后不再进终态判定，删除只服务旧机制的 `authoritativeShapedOverflow` 变量、`rememberContextOverflow` 的 `authoritative` 形参、`ABSOLUTE_CONTEXT_MAX_PATTERN`、终态 `else if (authoritativeShapedOverflow)` 分支。`contextOverflow` 择优逻辑同步简化（两个预检调用点 message 都是 shaped，择优永不触发）。
- **可观测影响**：这类请求 `provider_attempts` 从多条变 1 条、`fallback_count` 从 1 变 0、admin「提供商尝试」面板只显示第一个候选返回 400。这是短路的直接结果，预期内。
- **Codex review 补的 gate（round 1-2 HIGH）**：短路把一个潜伏 bug 放大了——`isContextWindowRejection` 原本纯靠 error body/message 标记判定，**不看 `err.upstreamStatus`**。一个可重试的 429/5xx/408 若 body 恰好含 `context_length_exceeded` 标记（如上游把上下文相关的过载包成 500），会被短路成客户端 400 → 不再 fall back 到健康兄弟、不记熔断。round-1 用黑名单（`status === 429 || status >= 500`）；round-2 Codex 指出漏了 408 → 改成**白名单** `if (status !== null && status !== 400 && status !== 413 && status !== 422) return false;`。只有确定性请求-shape 4xx（400/413/422）+ `null`（in-band 流式，无 HTTP 状态）短路；其余所有 numeric status（408/409/425/429/5xx…）走正常 fall back + 记熔断。与 `isUpstreamRequestRejection` 的 4xx 白名单一致，未来新增可重试 status 天然被排除，不用补黑名单。旧的 skip-and-continue 设计下这个误判无害（只少试一个候选），是短路抬高了代价。
- **测试**：9 个围绕旧「skip+耗尽才返回/多候选确认/让位给更大 sibling」的 case 全部重写为「第一个真上游溢出即短路、后续候选从不被调用」（含 in-band 流式溢出、native Responses 脱敏、逗号分组、box c211e4a1）；新增复现线上 case 的短路测试 + 预检估算不短路的正向证明 + 5xx-gate 测试（500 带溢出标记必须 fall back 而非短路）。execute.test.ts 170 全绿；route-request 92 全绿；typecheck + lint 全绿。

## 2026-08-07 · Codex 配额富元数据持久化（providers page Tier 3，docs/11，原则 7）

- **现场**：providers 页某 Codex 账号卡片"显示不全"——只有"周限 100%"进度条 + resetCredits 0，缺 Plan 类型、Credits 点数、Reset limit 按钮点数、individualLimit。box 刚重启到 0.28.46 后**所有** Codex 账号都这样；手动 refresh 后未限流账号立即恢复出 planType/credits，已限流账号（其 `/wham/usage` PULL 拿不到富数据）仍缺。
- **根因**：Codex 富元数据（planType/credits/resetCreditDetails/individualLimit/additionalLimits/rateLimitReachedType）此前**只存在 `admin-oauth.ts` 的进程内 `quotaCache` Map**，从不落库——`oauth_quota` 的 `store.upsert` 只写 windows + resetCredits（`oauth.ts:467`）。重启即清空进程缓存；持久化 store 只剩 windows（→ 周限进度条能显示），`getCachedCodexQuota` 返回 null → 富字段全丢，直到下次 refresh 重填进程缓存。
- **修复（Lukin 拍板"扩 store schema"）**：给 `oauth_quota` 加一列 `metadata`（sqlite TEXT / pg JSONB，nullable）。① shared 新增 `CodexQuotaMetadataSchema` + `packCodexQuotaMetadata`（header PUSH 无富数据时返回 `undefined` → upsert 里省略该列，保留上次 PULL，与 resetCredits 同 preserve-on-omit 契约）+ `unpackCodexQuotaMetadata`（null/损坏 → `{}` fail-open）。② 两个适配器 upsert 写 metadata、toSnapshot 读回。③ sqlite migration v48 / pg migration v47（都 `ADD COLUMN IF NOT EXISTS`）。④ 刷新路径 `oauth.ts` 把 activeResult 的富字段一并 upsert。⑤ 读取路径 `readCachedQuota`：进程缓存（最新最全）优先，**冷缓存时 fallback 到行上持久化的 metadata**——重启后卡片即完整，无需等 refresh。
- **未修的次要项**：已限流账号（weekly 100%）的 `/wham/usage` PULL 本身拿不到富数据，是 OpenAI 上游对限流账号的行为，非 helm bug；weekly 重置后自愈。
- **测试**：sqlite round-trip + header-PUSH 保留；pg（pglite）round-trip + 保留 + fail-open；admin route 冷缓存 fallback（fullSeam 无 getCachedCodexQuota → 用行持久化 metadata）。core store 807 全绿；admin oauth route 86 全绿；typecheck + lint 全绿。

## 2026-08-07 · context_management 转发给 generic responses 导致 grok 422（Protocol / provider execution，docs/04/05，原则 3/5/8）

- **现场**：anthropic_messages 请求 fallback 到 xAI grok-4.5（generic openai_responses profile）时，`context_management` 以 Anthropic 对象形状 `{ edits: [...] }` 发出，xAI Responses 反序列化要 array → 422 `invalid type: map, expected a sequence`（正是上一条 prompt-too-long 现场里 grok 那个无关 422）。
- **根因**：`context_management` 是 Anthropic 原生上下文编辑控制，因 Codex GPT-5.6 订阅工作（`680e570a`）被加进 `openai_responses` 转发 allowlist——供 **Codex 官方**端点消费；但 **generic** profile（grok）继承同一 allowlist，不认这个字段且形状不符。
- **修复（两条路径都堵）**：(1) **翻译路径** `renderProviderRawForTarget`：对 `targetIsGenericResponsesProfile` 从 allowed 删除 `context_management`，与其上方既有 `responses_input_items` 删除同理同位。(2) **同协议 passthrough 路径**（Codex review 补漏）：`openai_responses → generic grok` 同协议可 verbatim passthrough 绕过 allowlist；在 `prepareNativeRequestForUpstream`（native body 唯一 chokepoint，已有 Codex/Anthropic sanitizer）新增：generic profile 时删除 body 里的 `context_management`（任何形状；对 generic 都是不可执行的 Anthropic 控制），mutation 记 `context_management_stripped_for_generic`。Codex 官方（非 generic）两路都保留。
- **测试**：三向锁定——翻译 strip 到 generic xai（mutation `provider_raw_stripped_for_target`）+ 非 generic Codex-official 保留 + 同协议 passthrough strip（mutation `context_management_stripped_for_generic`）。execute.test.ts 169 全绿；execute/pipeline/responses/core-responses 合计 539 全绿。
- **遗留**：allowlist 里 `text`/`reasoning_config`/`truncation`/`logit_bias`/`include`/`responses_tools`/`container` 等对 generic provider 是否有同类 array/object 形状风险，Codex 抽查未确认第二例，未逐一核；本次只修实测触发的 `context_management`。

## 2026-08-07 · OAuth 账号「限流后继续用剩余点数」每账号开关（OAuth pool / account settings，docs/06，原则 3/6）

- **需求**：账号周限 100%（`已限流`）但仍想榨干剩余点数——加一个每账号开关，开了就别把它从池里 park 掉。
- **实现**：`AccountSettings.allowSpendRemainingCredits`（可选布尔）→ 合成时喂进 `OAuthPoolMember.allowSpendRemainingCredits` → pool 的 `usageLimited()` 首行：`if (member.allowSpendRemainingCredits) return false`。整条读侧只有这一处 gate（`eligibleEntries` 的 `!usageLimited`），所以一处 bypass 即全覆盖（chat/stream/native/responses/realtime 都走 `select()`）。
- **刻意的边界**：只绕过**账号级 usage-limit park**（`usageLimitedUntilMs`）。model-scoped（`scopedRateLimits`）与 transient retryable（`retryableAccountFailures`）冷却**不动**——它们是不同轴，绕过会误伤。写侧（park 的记录）也不碰：账号真没预算时上游照样 429，pool 正常 in-pool failover 到兄弟账号，不会死循环打爆上游。
- **拍板（AskUserQuestion）**：① 忽略**全部** usage-limit park（不只周限）；② **每账号**开关，跟 `autoReset`/`fastMode` 并列。开关对所有 OAuth provider 生效（非 Codex 专属），所以 ManageAccountDialog 里是无条件 toggle。
- **布线**镜像 `autoReset`：account-settings → server 合成 → admin-oauth 的 `getAccountSchedule`/`setAccountSchedule` seam → deps.ts 三处类型（list-item / setAccountSchedule 入参 / `AccountScheduleView`）→ PUT 路由校验（非布尔 400）→ admin client `oauth.ts`（list-item 可选、schedule 必填，跟 `autoReset?`/`autoReset` 的可选/必填分裂一致）→ Svelte toggle + 3 条 i18n 串（7 语已对齐；`i18n:translate` 离线失败无碍，key 已由 `i18n:update` 填英文占位）。
- **TDD**：pool.test 先加失败用例（parked 成员带 flag 仍应被选中→原本落到兄弟）→ Red→加 flag+bypass→Green（99/99）。admin-oauth/oauth 路由测试补 round-trip 与 400 校验。
- **坑**：worktree 内编辑必须用 worktree 绝对路径——首次 Edit 误落主库（共享 checkout），已 `git checkout --` 干净回退后在 worktree 重做。

## 2026-08-07 · per-key `max_reasoning_effort` 上限在三处身份解析器漏挂，全协议静默失效（Gateway / Key governance，docs/06/11，原则 2/7）

- **现场（box v0.28.43）**：luke 的 key 设了 `max_reasoning_effort=medium`，但 `decision_json` 显示 Anthropic 请求 `xhigh→xhigh`、Responses 请求 `high→high`，**两协议都没被 clamp**。DB 列值正确、v0.28.39 的 `clampClientReasoningEffortToKeyMax` 也被各路由正确调用。
- **根因**：composition root（`server.ts`）里 `/v1/chat`、`/v1/messages`、`/v1/responses` 各自**内联**一份 `record → caps` 映射（三份几乎相同的 25 行块）。v0.28.39 加 `max_reasoning_effort` 时改了 DB、clamp 调用点、以及 `middleware/auth.ts` 的构造器——但**漏了这三份内联副本**。于是 `identity.caps.maxReasoningEffort` 运行时恒为 `undefined`，clamp 第一行 `if (maxEffort == null) return req` 直接 no-op。`middleware/auth.ts` 版本有该字段，但那个 middleware 并不服务这三条路由（它们走 `resolveIdentity`/内联 resolver）。经典“同一映射多副本漂移”bug（与 memory 里 KeySummary/toSummary 同类）。
- **修复（消除漂移，不加兼容层）**：把三份内联块抽成单一 `capsFromRecord(record)`（`routes/messages.ts` 导出），三处 resolver 全部改调它。新增 cap 只改一处，物理上杜绝再漂移。删除 server.ts ~90 行重复。
- **测试**：`messages.caps.test.ts` 直接 pin 映射（`max_reasoning_effort=medium → caps.maxReasoningEffort=medium`，null 透传，其余 caps 齐全）；`responses.test.ts` 新增用例走**真实 `capsFromRecord`** 构造 identity + 真实 pipeline + stateful passthrough continuation，断言到达 `route()` 的 carrier body 与 `reasoning_effort` 均被压到 medium。临时注释掉修复 → 两测试红，且 responses 用例复现 box 症状 `expected 'high' to be 'medium'`；恢复后全绿（reasoning-cap 29 / auth 10 / responses 99 / messages+chat+pipeline 191 全绿）。
- **坑/边界**：clamp 本身对 `openai_responses` 原生 passthrough carrier 处理完整（早已覆盖），本次纯粹是 cap 值没送达。三处 resolver 之外，`realtime` 的 auth 子集不含 reasoning cap（realtime 无 reasoning，无需）。box 需部署新版本后该 key 才会真正生效（旧进程仍 undefined）。

## 2026-08-07 · 真实上游超长溢出在链耗尽时胜出终态，修复客户端无法压缩（Provider execution / protocol errors，docs/04/05/07，原则 3/5/8）

- **现场（box `c211e4a1`，v0.28.42）**：Claude Code 发 ~102 万 token，Anthropic（链首、最大窗口）返回真实 400 `prompt is too long: 1022145 tokens > 1000000 maximum`（**无** `context_length_exceeded` code）。helm 把它当可重试 `context_too_small` 继续 fallback；`xai/grok-4.5` 因独立翻译 bug 返回 422，把 `onlyContextOrCapabilitySkips` 打成 false，终态选择器降级为合成 `all_providers_failed / 502`。客户端拿不到真实 400 → 认不出该压缩 → 卡死。
- **根因**：2026-08-03 的终态优先级（下方同标题条目）只在“整链仅上下文/能力 skip”或“≥2 个 `context_length_exceeded` code 确认”时才回 `invalid_request / 400`。Anthropic 绝对上限用 `prompt is too long: N > M` 措辞、不带该 code，一个无关兄弟失败就翻掉守卫。
- **关键教训（Codex review 纠偏，避免过修）**：初版曾想“命中即短路、不再 fallback”，**错**——`N > M` 只证明**该候选**的窗口，200k 模型也用同一措辞；若链后面有更大窗口候选，短路会误杀可成功的 fallback。正解是**继续 fallback 试更大窗口**，仅在**链耗尽**时让这个溢出胜出终态。
- **修复（拍板：所有协议一致；不短路，改终态守卫）**：单独追踪 `authoritativeShapedOverflow`——**只有真实上游响应**报的、且消息形如 `prompt is too long: N > M`（逗号分组容错）的溢出才记入；预检估算（char / `count_tokens`）绝不进。终态在原两条件（`onlyContextOrCapabilitySkips` / `≥2` 确认）后新增：`authoritativeShapedOverflow !== undefined` → 即使夹有无关 provider failure 也回 `invalid_request / 400` 保留其 `provider_raw`。把「形状」与「真实来源」绑在同一条记录，杜绝近似估算冒充硬上限压过真实 5xx（守住既有 “approximate estimate override provider failure” 用例）。
- **Codex 对抗式 review 的价值**：Codex 曾提「短路会误杀更大窗口兄弟」（真，已改为不短路）、「近似估算的 shape 经 boolean 合并冒充 authoritative」（合理担忧，实测该路径下 `onlyContextOrCapabilitySkips` 仍为 true、第一条守卫本就触发，不会错翻 error class——属 plausible-but-not-reachable，但仍按其建议重构成 provenance 绑定，更干净且消息来源正确）、「回显内容误判」（真，已收窄 `isContextWindowRejection` 弱措辞只匹配结构化 message）。遗留：强标记 `context_length_exceeded`/“maximum context” 仍全 body 匹配（API 专有 token，正文混入概率极低，ponytail 上限）；真实溢出行仍记 `skipped:true`（既有全体 context-overflow 约定，`fallback_count` 少计一次，非本次回归，另议）。
- **顺带加固 `isContextWindowRejection`（Codex #2 回显内容误判）**：强信号（`context_length_exceeded` code / “maximum context”）仍全 body 匹配；弱措辞（“prompt is too long”/“context window/length”）只在**结构化 error message** 匹配，不扫 `rawErrorText`——否则 provider-failure body 里回显的用户 prompt 会被误判为溢出，甚至在终态**伪造**一个客户端 400。
- **测试**：box 回归（`N>M` 首 + 兄弟 422 → 两候选都试、终态 400）；`context_length_exceeded` 变体同理；“更大窗口兄弟胜过 shaped 溢出”（不短路、fallback 成功）；“回显内容不伪造 400”（全链失败 → `all_providers_failed`）；per-model / 流式 / 多候选确认 / 近似估算不压真实故障用例全绿。execute.test.ts 164 全绿；messages/chat/gemini/responses/image-chain/pipeline 相关 239 全绿。
- **遗留（本次不修）**：`xai/grok-4.5` 的 422 `invalid type: map, expected a sequence` 是独立的 anthropic→openai_responses 翻译缺陷；另开 change。

## 历史条目摘要（最新要点）

- **2026-08-06 · HALF_OPEN 探测锁释放与所有权令牌**：所有被允许的 provider/image 尝试都结算 breaker，HALF_OPEN abort 仅凭匹配的 probe token 释放对应探针，避免锁永久卡住或旧请求误清新探针；完整原文经 git history 回溯。
- **2026-08-04 · per-key 请求内容存储覆盖优先级**：显式 `none`/`payload`/`session` 无条件覆盖实时全局设置，仅 `null`/`undefined` 继承；共享 capture helper 一处修复覆盖全部协议入口，完整原文经 git history 回溯。
- **2026-08-04 · Codex 跨协议 fallback 修复**：可折叠 Responses items 走协议翻译，generic Responses 禁止 Codex 私有 passthrough，多账号池恢复 runtime profile；unknown/caller-linked/encrypted sub-agent items 继续 fail-closed，完整原文经 git history 回溯。

- **2026-08-02 · Responses WebSocket 首输出前恢复并提前释放物化准入**：上游 WebSocket 只产生 created/in_progress 后关闭时丢弃未提交 preamble 并按连接重试预算重连、耗尽回退 HTTP/SSE，最多缓冲两个 preamble、第三个重复立即提交为已开始输出，真实输出绝不重放，`response.cancelled` 两处均为失败终态；bridge 用进程内 `WeakMap<Request,callback>` 把 request-body lease 交给可信内部路由、随机 proof 匹配后第二次 parse 完即标物化，避免长期持有 6 倍预留，并发大请求仍受动态 headroom 保护，未恢复任何固定大小上限，完整原文经 git history 回溯。

- **2026-08-02 · 流式错误的 telemetry 终态与 metadata-only 捕获短路**：Chat/Messages/Gemini 已开始写 SSE 后遇非取消错误，共用取消边界旁 helper 把同一 `DecisionRecord` 标 `final.status=error`、保留 `error_reason`、写 `stream_outcome=failed`，客户端断连仍走 `client_aborted`；Session capture 关闭时队列入口在算字节/查 cache/建 deferred write 前直接返回，不产生 `session.capture_limited` 或存储工作，脱敏 telemetry 不受影响，完整原文经 git history 回溯。
- **2026-08-02 · xAI Responses 对象 input 在本地拒绝**：xAI `grok-4.5` 对 `input` 对象返回 `invalid type: map, expected a sequence`；只为 xAI generic Responses contract 加对象形态预检 → 结构化 `invalid_request / 400` 不发上游，数组保持可用、string 形态未证实不猜测；未动 admission/错误正文预算/Session 容量，`error_body_capacity_exhausted` 是独立上游边界保留真实诊断，完整原文经 git history 回溯。
- **2026-08-02 · Session 正文原子分块存储 + 机器压力协调后台工作**：Session 正文按 256 KiB UTF-8 安全块 gzip/raw 写入（≤4 块/批），revision 用请求/响应双 generation 指针原子发布、响应回填不重写大请求正文；不恢复 64 MiB 上限，改由 V8/cgroup 动态协调器统管并在 PSI 压力下暂停 Memory/Signals/cleanup；SQLite 小批 prune、PostgreSQL 每 tick≤128 行续跑，VACUUM 前后双检压力；切 capture generation 丢弃未 flush 正文，`part=meta` 不读正文（原“全局 metadata-only 硬 off 不可 override”契约已于 2026-08-04 更正），完整原文经 git history 回溯。
- **2026-07-31 · 保证 Session 捕获且删除累计字节上限**：按用户要求删单 Session 64 MiB 累计上限（不换更大常量），`stored_bytes` 仅作观测、SQLite INTEGER/Postgres BIGINT 无需迁移；可信客户端标识全缺时以 `account_id+api_key_id+request_id` 派生仅覆盖本请求的 Session（不拿 `prompt_cache_key` 当身份以免错并会话），外部 ID 用 `helm-request:` 保留前缀避免碰撞、v0.28.26 回滚仍可读；单请求仍受动态 capture-body 内存预算与 10,000 revision 上限保护，历史缺失 revision 不补写，生产需 `capture_sessions=true`+`capture_payloads=false` 才用增量模式，完整原文经 git history 回溯。
- **2026-07-31 · API key 单独覆盖请求内容存储模式**：`api_keys.request_content_mode` nullable 枚举列，`NULL` 继承实时全局、`none`/`payload`/`session` 显式覆盖；鉴权身份把覆盖值传到 Chat/Messages/Responses(含 compact)/Gemini/Images/Interactions/Admin Replay 复用同一 capture helper，只换本次请求 getter；`payload_retention_days` 仍全局，无 per-key retention（2026-08-04 修正其优先级回归，见顶部）。完整原文经 git history 回溯。
- **2026-07-31 · 请求列表记录并显示客户端正文大小**：新增可选 `request_body_bytes`（客户端 wire UTF-8 字节，非 Content-Length/token/压缩量），随脱敏 DecisionRecord 保存；Admin 表按 B/KB/MB 展示，旧记录显示 `—`；完整原文通过 git history 回溯。
- **2026-07-29 · 生产韧性：持续小批清理 + 无丢弃背压 + 执行 Token 租约 + 完整错误诊断**：SQLite retention 每批≤10 行让出事件循环、Session prune claim 可续；写队列删除 OOM shedding 改统一串行 admission 背压 FIFO；OAuth 保存真实 `expires`、执行 client 6 分钟提前刷新、刷新失败重读共享 Store 只用他实例轮换出的有效 credential；Provider 错误有界诊断（64 KiB body / 128 KiB 总预算），完整原文通过 git history 回溯。
- **2026-07-28 · 删除 HTTP 与 WebSocket 请求大小上限**：删除应用与 Remote Nginx 固定正文上限，继续由动态内存准入、鉴权、schema、maintenance drain 和 provider timeout 保护运行时；完整原文通过 git history回溯。
- **2026-07-28 · preflight/registry 内存放大与自动 VACUUM 空闲门禁**：Responses preflight 增加 deadline/abort，catalog 与 registry 改为有界热路径；自动 VACUUM 仅在空闲 drain 后执行，完整原文通过 git history 回溯。
- **2026-07-25 · 上游过载（529/503）在 fetch 边界退避重试**：只在首字节前对 529/503 做两次有界退避，保留账号池、熔断、fallback 与终态 telemetry 语义；客户端断连立即停止，完整原文通过 git history 回溯。
- **2026-07-25 · Responses WebSocket terminal 立即释放并关闭失效连接**：成功终态立即释放请求与 ingress lease，失败终态关闭失效连接；Codex 增量续接保持 registry/provider/account/lane provenance 与 abort 边界，完整原文通过 git history 回溯。
- **2026-07-25 · 图片上游参数拒绝保持客户端 400**：ZenMux 的结构化 `invalid_params` 在共享边界转为 `invalid_request / 400`，provider 5xx、网络、限流与真实链耗尽语义不变，完整原文通过 git history回溯。
- **2026-07-24 · Codex Voice、Responses 音频与图片编辑补齐代理面**：Realtime V1/V2/V3、Responses 音频与 Images edits 复用既有鉴权、路由、账号和遥测链；Voice attestation 与单实例 call registry 保持收窄边界，完整原文通过 git history 回溯。
- **2026-07-24 · 请求准入增加实时 V8 堆高水位**：曾以 live heap + 分池余量拒绝高风险请求；后被 2026-07-27 的启发式拒绝拆除与 2026-07-28 的请求大小上限删除取代，完整原文通过 git history 回溯。
- **2026-07-24 · Admin 登录同源证明兼容代理 Host 改写**：登录/登出优先接受浏览器不可伪造的 `Sec-Fetch-Site: same-origin`，同时保留 Origin/Host 与 cross-site 拒绝边界；完整原文通过 git history 回溯。
- **2026-07-24 · Responses WebSocket ingress 改为按活动消息计费**：空闲连接不再预留完整帧容量，活动 `response.create` 才按真实 wire/JSON bytes 申请并释放 ingress lease；上游非 101 body 统一由有界响应超时接管，完整原文通过 git history 回溯。
- **2026-07-23 · PostgreSQL API-key 分布式并发 lease**：PostgreSQL 用 DB 时钟和 state-row lease 实现跨 replica 并发上限、心跳与 crash recovery，真实多 pool e2e 作为验收边界；完整原文通过 git history 回溯。
- **2026-07-23 · Session 恢复与在线响应共享内存池**：Admin Session 恢复单次最多占 response-work 池一半，保留在线响应容量并坚持先准入后物化；完整原文通过 git history 回溯。
- **2026-07-27 · 请求内存准入只计算未物化 headroom**：曾修 live-heap 双重计账误拒 503；后被同日“拆除启发式请求内存拒绝并保留硬边界”取代，完整原文通过 git history 回溯。
- **2026-07-23 · Codex Responses 按运行时容量准入并让夜间 SQLite 维护收缩内存（Gateway / Session / Store，docs/02/05/07/10，原则 2/3/7/8）**：机器推导的共享请求/响应/缓存预算、活动消息准入和维护 drain 保留正文捕获与自动维护能力；后续物化重复计账、WebSocket ingress 与 terminal 生命周期修正见顶部更新条目，完整原文通过 git history 回溯。
- **2026-07-23 · SQLite Session 与 Memory 正文使用兼容 gzip 存储（Store / Memory，docs/07/08，原则 1/3/7）**：SQLite 以 value type + gzip magic 兼容压缩 Session/Memory 正文，不回写历史数据、不在线 VACUUM，完整原文通过 git history 回溯。
- **2026-07-22 · 全项目文案审查补齐多语言维护闭环（Admin / Portal / Setup，docs/11/12，原则 1/2）**：以 Opus 只读审查和七语言结构测试补齐 Admin、Portal、Setup 文案维护闭环，完整原文通过 git history 回溯。
- **2026-07-22 · Session 恢复补齐响应快照并限制默认留存范围（Telemetry / Admin requests，docs/07/11，原则 1/3/7/8）**：复用 `session_revisions.response_json` 保存四种协议的成功非流式响应快照，流式不新增 SSE 缓冲；当时的 Session 64 MiB 累计上限已于 2026-07-31 按用户要求删除，来源仍恒为 `exact=false` 且 Retry 禁用，完整原文通过 git history 回溯。
- **2026-07-22 · 按会话增量保存请求正文并诚实区分恢复保真度（Telemetry / Admin requests / Store，docs/07/11，原则 1/3/7/8）**：新增 `capture_sessions` 与 `capture_payloads` 构成三种互斥留存模式（同时为 true 则 fail-closed），只解析高置信客户端会话信号并以不可猜测 `session_ref` 存储；Session head + 单调 sequence + 不可变 revision 按最长公共前缀存增量，Responses 续接建真实 `response_id → request_id` 父边、找不到父 response 时恢复 fail-closed 为 `session_incomplete`，完整原文通过 git history 回溯。
- **2026-07-22 · Lanes 批量保存、拖拽回退与可配置默认通道删除边界（Routing / Admin lanes，docs/03/04/11，原则 2/3/5/6）**：Lanes 整组原子保存、拖拽排序并只保护当前默认通道，非法默认配置 fail-closed，完整原文通过 git history 回溯。
- **2026-07-22 · Responses 状态续接严格绑定原 provider 与账号（Protocol translation / provider execution，docs/04/05/07，原则 2/3/5/8）**：`previous_response_id` 只允许同 account/key、原 provider 与原账号继续执行；未知、跨协议或不可用状态 fail-closed，完整原文通过 git history 回溯。
- **2026-07-22 · Codex 客户端默认启用 Responses WebSocket，并补齐反向代理边界（Deployment / Protocol / Admin client setup，docs/05/10/11，原则 3/5/8）**：Admin 的 Codex 配置复用既有 Responses WebSocket；代理只在真实 Upgrade 时转发 hop-by-hop header，Claude 图片 shim 延后，完整原文通过 git history 回溯。
- **2026-07-21 · 首次安装改为令牌保护的浏览器向导并允许订阅-only 启动（Deployment / bootstrap / Admin，docs/10/11，原则 2/3/7）**：无完整 Admin 凭据时只开放令牌保护的浏览器向导与健康端点，完成后同进程启用 Gateway；凭据保存到 `0600` managed env，CLI/无 `.env`/OAuth-only Linux 安装路径均完成实测，完整原文通过 git history 回溯。
- **2026-07-21 · Grok Build 复用 OpenAI 模型发现接入 Helm（Admin client setup，docs/05/11，原则 2/5/6）**：Grok Build 复用现有 `/v1/models` 与 Chat Completions，只新增七语言客户端配置引导，不引入专用路由或依赖；完整原文通过 git history 回溯。
- **2026-07-20 · `end_turn` XML 泄漏只按终态工具调用恢复（Protocol streaming / provider execution，原则 3/5/8）**：仅在终态、完整、白名单且无既有结构化调用时恢复 `end_turn` XML 工具调用，四个出口共用收紧边界；完整原文通过 git history 回溯。
- **2026-07-18 · 请求推理等级与实际路由等级分开展示（Telemetry / Admin requests，原则 1/7）**：单独保存客户端请求等级与覆盖后的实际执行等级，共享列表分别展示且不从旧记录反推；完整原文通过 git history 回溯。
- **2026-07-18 · 关闭正文捕获时仍保留推理等级（Telemetry / Admin requests，原则 1/7）**：完整正文关闭时仍把实际生效的 `reasoning_effort` 作为脱敏 DecisionRecord 元数据保存并显示；完整原文通过 git history 回溯。
- **2026-07-18 · Codex 自动压缩目录与无状态传输故障切换（OAuth subscription / Responses / provider execution，原则 3/5/7/8）**：对齐 Codex 自动压缩阈值，并只允许无状态 transport failure 在兄弟账号间切换；有状态续接与私有 Responses items 保持 fail-closed，完整原文通过 git history 回溯。
- **2026-07-17 · Anthropic XML 工具调用恢复边界（Protocol streaming / provider execution，原则 3/5/8）**：只在终态、完整、白名单且无既有结构化调用时恢复 XML 工具调用；四个实际出口共用边界并以有界缓冲保持流式保真，完整原文通过 git history 回溯。
- **2026-07-16 · 历史费用回填放宽 WAL 与磁盘恢复门槛（Catalog / telemetry repair operations，原则 2/3/7）**：在既有 100 行原子批次、资源门禁和 12 GiB 硬底线不变的前提下，按健康实测放宽 preflight WAL/磁盘恢复门槛，避免任务永久饥饿；完整原文通过 git history 回溯。
- **2026-07-16 · 路由白名单改为真实交集并让分类开关兑现配置语义（Routing / classifier / CI，原则 2/3/5/6/7）**：Policy 与 key 白名单求真实交集并让空集 fail-closed；rules/eval cache 开关兑现配置语义，CI Actions 固定到核验 SHA；完整原文通过 git history 回溯。
- **2026-07-16 · xAI 订阅协议跟随官方 grok-build 并收紧动态目录边界（OAuth subscription / model catalog / Responses / Admin providers，原则 2/3/6/7/8）**：以真实 wire 和账号 entitlement 分离模型目录 ID、执行 slug、能力与配额，未知能力保持 fail-closed，跨账号冲突拒绝；完整原文通过 git history 回溯。
- **2026-07-16 · 收紧发布信任链、请求归属与 Memory 项目隔离（CI / observability / Memory，原则 1/3/7）**：PR 信任链固定到受核验 merge ref 与只读权限，发布绑定已验证 main SHA；内部 `request_id` 与客户端 trace 分离，Memory thread/project 迁移保持租户隔离与事务原子性；完整原文通过 git history 回溯。
- **2026-07-16 · 文档以当前源码为准完成全量运行时事实校准（docs/01–14 / README / operations，原则 1–8）**：以当前路由、schema、Store、配置与测试校准全部当前文档和中英文 README，明确 Portal、部署、安全、Memory 与协议实现/缺口边界；完整原文通过 git history 回溯。
- **2026-07-16 · Admin 首次点击卡顿改为非投机加载与汇总读（Admin / Store performance，docs/08/11，原则 1/3/7）**：以 `memory_threads` 的事务维护汇总替代正文表冷扫描，Admin 改为非投机 data preload，并以有界 stale-while-revalidate 缓存保护统计读取；在线 VACUUM 继续禁止。
- **2026-07-15 · Codex 配额 PULL 饱和后触发自动重置（OAuth quota / reset credits，docs/04/11，原则 3/5/7）**：仅新鲜 PULL/PUSH 在账号级周窗口饱和后经共享幂等 guard 触发 reset credit，成功后强制回读并同步 durable/live quota；cache-only 读取始终无副作用。
- **2026-07-15 · Anthropic 不可用地域哨兵按全球基础卡计费（Catalog / telemetry accounting，docs/07/08，原则 2/3/5/7）**：仅把 `usage.inference_geo=not_available` 解释为地域缺失并使用全球基础卡，真实未知地域继续 unknown；实时与历史重算共用规范化且保留原始 provenance。
- **2026-07-15 · 终端事件缺失的 Responses 流使用部分估算计费（Protocol streaming / telemetry accounting，docs/05/07，原则 3/5/7/8）**：原生 Responses 流缺终态时按 truncated/client_aborted 记失败，仅对已收 semantic delta 做有界 partial usage/cost 估算，并让 telemetry、attempt、budget 与 OAuth 账号结算一致；完整原文通过 git history 回溯。
- **2026-07-15 · 历史费用回填改由常驻 supervisor 持续推进（Catalog / telemetry repair operations，docs/07/08，原则 2/3/5/7）**：systemd 常驻 supervisor 以单实例、100 行原子批次、checkpoint、slice verification、微型恢复库、资源门禁和 5,000 行冷却推进固定截止点前的历史修复；完整原文通过 git history 回溯。
- **2026-07-15 · 历史重算兼容旧版 completion-only 顶层费用（Catalog / telemetry repair，docs/07/08，原则 2/5/7）**：仅在顶层、attempt 与 breakdown 同时精确证明旧版只保存 completion cost 时接受回填，任何其他漂移仍 fail-closed；完整原文通过 git history 回溯。
- **2026-07-14 · 官方模型费率与多模态计费校准（Catalog / telemetry / protocol usage，docs/04/05/07/08，原则 1/2/3/5/7/8）**：以官方价格和响应中可证明的 tier、地域、缓存与 modality 证据计费；未知分价、动态 alias 与已丢失的历史证据保持 unknown，历史修复只经 manifest、微型恢复库和资源门禁渐进执行。
- **2026-07-14 · 确定模型名优先于兼容通配别名（Routing / model alias precedence，docs/04，原则 2/5/6）**：精确 lane 与已配置 model 必须先于 `claude-*` / `gpt-*` / `gemini-*` 等宽泛兼容映射解析，避免显式模型被错误改写到其他 lane。
- **2026-07-14 · 通道模型选择器复用自动发现缓存（OAuth subscription / Admin lanes，docs/04/11，原则 1/3/6）**：通道目录保持 network-free，依次复用共享进程缓存、加密账号设置中的 durable last-known-good 与 curated fallback；空目录/失败不覆盖旧快照，重连以 cache generation 隔离旧身份，并保持 Manual/Codex entitlement 边界。
- **2026-07-14 · 丢弃 Codex 空 secondary 配额占位窗口（OAuth quota / Admin providers / reset credits，docs/04/11，原则 3/5/7）**：写入、cache-only API 与 UI 三层过滤 0%/无时长/已重置的空 positional 窗口；明确 `windowMinutes >= 10080` 的账号周窗口优先，避免脏 secondary 覆盖真实周额度与 reset marker。
- **2026-07-14 · Subscription Providers 改为缓存优先与全局串行刷新（OAuth Admin / provider observability，docs/04/11，原则 1/3/6/7）**：Providers 首屏与兼容读 API 严格 cache-only；显式刷新由进程级单 worker 串行账号、合并并发点击并保留 last-known-good 数据。
- **2026-07-14 · Avoid Waste 在 provider 池内限制 reset-credit 偏置（OAuth provider selection，docs/04/11，原则 3/5/6）**：reset credits 只作为同一 provider 池内的弱恢复容量信号，不能压过明显更多的真实即将过期额度；套餐标签不参与分池或评分。
- **2026-07-13 · Responses 工具结果的 multipart 文本使用 input_text（Protocol translation / provider execution，docs/05/07，原则 3/5/8）**：provider 与共享 transformer 统一把请求侧 multipart 工具结果文本编码为 `input_text`，保留字符串、图片、文件与助手输出的既有 wire shape。
- **2026-07-13 · Codex 周配额按真实窗口时长识别（OAuth quota / Admin providers / reset credits，docs/04/11，原则 3/5/7）**：账号级 Codex 周窗口以 provider 报告的 `windowMinutes >= 10080` 为权威，旧快照仅在缺 duration 且有真实用量时回退 secondary；Admin、reset-credit 与 model-scoped 隔离共用同一规则。
- **2026-07-12 · Grok premium fallback 与 Composer 评估边界（Routing / provider evaluation，docs/04/07，原则 2/3/5/6/7）**：移除 official OpenAI/ZenMux 自动付费候选，premium 以已验证的 SuperGrok Grok 4.5 作为订阅 fallback；Composer 因真实 A/B 的空响应与质量不足不进 lane，底层 transport/发现保留，xAI Admin 选择器补 curated 展示但运行时 entitlement 继续 fail-closed。
- **2026-07-12 · SuperGrok 周配额使用现有 OAuth 读取私有 gRPC-Web credits（OAuth subscription / Admin providers，docs/04/09/11，原则 3/6/7）**：复用现有 xAI OAuth bearer 严格读取 weekly gRPC-Web credits，按账号持久化 quota/cooldown 并以 cache epoch 隔离重连竞态；不保存 Cookie、不混用月度/public billing。
- **2026-07-12 · SuperGrok/X Premium OAuth 实验性订阅 Provider（OAuth subscription / Responses / Admin providers，docs/04/09/10/11，原则 2/3/6/7/8）**：通过受限 device-code OAuth、加密 token、generic Responses executor 与严格 host/redirect/body-size 边界接入实验性 SuperGrok；动态 entitlement、SSE 聚合、Admin 状态及真实协议矩阵完成验证，Composer 保持 unpriced，Grok 4.5 后续按公开 API 等价费率计 telemetry。
- **2026-07-11 · 上下文链耗尽恢复 Claude CLI 自动压缩信号（Provider execution / protocol errors，docs/04/05/07，原则 3/5/7/8）**：候选级 context overflow 继续 fail-open fallback；仅上下文/能力 skip 的整链耗尽统一返回 Claude CLI 可识别的 `invalid_request / 400` 与精确 token 上限消息，混合真实 provider failure 保留原分类。
- **2026-07-11 · Subscription Provider 自动模型展示使用账号级发现与共享缓存（OAuth subscription / Admin providers，docs/04/11，原则 1/3/6）**：Providers 表格与 Manage 弹窗改用账号实时发现；非 Codex 使用共享进程缓存与 last-known-good，手动 allowlist、Codex entitlement 和运行时 curated fail-open 边界保持不变。
- **2026-07-11 · Claude Sonnet 5 订阅流量 API 等价成本与能力目录（Provider catalog / cost telemetry，docs/04/07/11，原则 2/5/7）**：默认 Anthropic 订阅路由升级到 Sonnet 5，并按官方介绍期 API 等价费率记录 telemetry；补齐 1M context、128K output、tools/vision/stream/structured outputs/document 与 adaptive-thinking 能力，2026-09-01 需更新标准费率。
- **2026-07-11 · 退休 GPT-5.3-Codex-Spark 及其订阅配额投影（OAuth subscription / model catalog / Admin providers，docs/04/11，原则 3/5/6/7）**：从 live/bundled/cached catalog 与手工设置过滤退休模型，并从 WHAM/header/durable/Admin quota 投影移除其 model-scoped 限额，保留最小历史识别以阻止旧缓存复活。
- **2026-07-11 · Portal 请求详情对齐 Admin 查看器但保持供应链边界（Self-Service Portal / Requests，docs/12，原则 1/6/7/8）**：复用 Admin viewer 并按 metadata-first 懒加载请求/响应与图片，同时保持 ownership 和 `upstream_request` 隔离边界。
- **2026-07-11 · API-key 门户自助 Memory 默认设置（Self-Service Portal / Memory，docs/06/08/12，原则 2/7）**：bearer key 可在 Portal 安全配置 observe/inject、共享项目与线程来源；root 只读，显式请求头仍覆盖默认值。
- **2026-07-10–11 · Codex CLI GPT-5.6 subscription parity（OAuth subscription / Responses / model catalog，docs/04/05/11，原则 3/5/6/7/8）**：按 Codex 源码补齐 GPT-5.6 模型目录、Responses/WebSocket/compact、usage、订阅 entitlement 与 reset-credit 安全边界，并完成真实 CLI 验证。
- **2026-07-10 · Direct DeepSeek Responses reasoning history pre-skip（Provider execution / protocol translation，docs/04/05/07，原则 3/5/8）**：检测到 Responses reasoning history 时预跳过无法接收回传 `reasoning_content` 的 direct DeepSeek Chat 候选；OpenRouter mirror 保持可尝试，避免确定性 400 而不改变最终 fallback。
- **2026-07-10 · GPT-5.6 Chat tools force reasoning_effort none（Provider execution / protocol translation，docs/04/05/07，原则 3/5/8）**：official GPT-5.6 Chat fallback 带 tools 时强制 wire `reasoning_effort:none`，保留 tools 并记录专用 body shim，避免 Responses-only 组合返回确定性 400。
- **2026-07-10 · GPT-5.6 family support in Helm defaults（Routing / provider catalog / cost telemetry，docs/03/04/07，原则 3/4/5/6）**：默认 lanes、能力/价格目录与 wire 参数升级到 Sol/Terra/Luna，同时保持 official API 与 Codex subscription 的 entitlement/context 边界。
- **2026-07-06 · 请求总超时驱动下游 abort 与失败 telemetry（Gateway runtime / telemetry，docs/02/07，原则 3/5/7）**：总超时统一 abort 下游并把客户端可见终态固定为 timeout，晚到 provider 成功只保留为 attempt 事实，不得覆盖最终失败或 payload。
- **2026-07-06 · API key 绝对模型黑名单（Key governance / routing / Admin keys，docs/04/06/11，原则 5/6/7）**：每把 key 的 exact/glob `blocked_models` 同时约束 direct、lane expansion、fallback、model list 与各协议入口，空链 fail-closed，SQLite/Postgres 与 Admin 表单保持一致。
- **2026-07-06 · 折叠会话行显示工具调用参数预览（Admin requests / conversation view，docs/11，原则 1）**：工具参数预览改为 whitelist-free，按 args 形状泛化提取 readable scalar，覆盖自定义/大小写不同工具并保留展开详情。
- **2026-07-06 · 配额 PULL 的 100% 账号级窗口必须同步停车（OAuth provider pool / Admin providers，docs/04/11，原则 3/5/7）**：quota PULL 看到账号级 100% 窗口时立即写入 cooldown 并同步 live pool，scoped model 窗口不扩大成全账号停车。
- **2026-07-05 · OAuth 凭证失效持久化为 needs reconnect（OAuth provider pool / Admin providers，docs/04/11，原则 3/5/7）**：refresh/持久 upstream 400/401/403 标记 credential failure、写入账号设置并摘出调度，reconnect 成功后按手动/自动停车边界恢复。

## 更早历史总览

2026-08-03 压缩条目包括受限容器按 cgroup 比例保留内存、Playwright 注入确定性压力门，以及多候选上下文溢出在链耗尽时恢复客户端 400 压缩信号；后续短路语义以顶部 2026-08-07 条目为准。

2026-07-07–09 压缩条目包括 self-service portal 完整实现与多语言、视觉压缩后的 cache-control 收敛和 Anthropic 兼容路径 CCH 稳定化。

2026-07-06 压缩条目还包括 Anthropic native passthrough 稳定 Claude Code billing `cch`、Admin 模型搜索预计算列、payload 分段懒加载、纯工具 turn 去空 header/默认展开，以及 Claude Code 风格 inline tool peek。2026-07-04 更早条目还包括 cheap-model 当前轮低风险降级、视觉上下文压缩 observe/off 接入、Memory stats 队列索引优化、OAuth 会话亲和调度、idle-flush 碎片段优先压缩最大连续段、memory worker 受控并发追赶、记忆页只读运行状态面板、Claude scoped weekly quota 只影响对应模型、跨协议 reasoning-history 候选级跳过、memory idle-flush 防饥饿、策略级 reasoning_effort 覆盖 lane 默认值、cron monitor 低成本规则等。2026-06-30 及以前的工作主要围绕 Helm API 的协议面、路由执行、admin 可观测性与自托管部署逐步成型：补齐 Gemini/OpenAI/Anthropic/Responses 双向转换、SSE 流式正确性、tool-call/JSON schema/思考参数保真、per-model reasoning effort、模型别名与能力/成本目录、provider fallback 与熔断语义、OAuth subscription providers、多账户池与 quota 处理、memory observe/inject/forgetting/admin/MCP、请求 payload 捕获与 request detail UI、API key 治理、admin 表格/过滤/分页/i18n、Docker/CI/release/deploy 验证，以及早期 Phase 0 的 Hono + SvelteKit static admin + Store 端口 + SQLite/Supabase 架构决策。更早细节不再逐条保留在本文件；需要精确背景时回查 git history。
