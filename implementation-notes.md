# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-07-16 · Admin 首次点击卡顿改为非投机加载与汇总读（Admin / Store performance，docs/08/11，原则 1/3/7）

- **生产根因**：`la.atmy.work` 的 `/admin/api/memory/stats` 冷读实测最高约 10.2 秒；同步 `better-sqlite3` 在 Node 事件循环上对约 139 万 `memory_messages`、11.9k observations 及其他 memory 表执行 `COUNT/MAX`，扫描期间连 health completion 都暂停。Admin 又在 `app.html` 全局启用 `data-sveltekit-preload-data="hover"`，鼠标经过侧栏即可投机触发这些数据库查询；第一次点击因此等待冷扫描，第二次点击命中 10 秒应用缓存或 OS page cache，形成“再点一下马上出来”的假象。同期没有 VACUUM、cleanup、OOM、`SQLITE_BUSY` 或 payload capture 事件，不能把本次页面卡顿归因于这些路径。
- **稳定读模型**：SQLite v39 / Postgres v38 在 `memory_threads` 增加 `message_count`、`last_message_at`、`observation_count`、`last_observation_at`，迁移以每个子表一次 set-based `GROUP BY` 原子回填；单条/批量消息写入、dedup conflict、observation 写入与消息清理在同一事务维护汇总。Postgres prune 先按固定顺序锁定受影响的 thread 父行，避免并发 append 的增量被旧快照覆盖；既有 `memory:dedup` SQLite/Postgres 运维路径也在 wipe/prune 后原子重建四个汇总字段，重复运行保持幂等。Admin stats 之后只聚合较小的 thread 父表，不再扫描正文子表。首次升级仍会执行一次有界全量回填，生产发布必须预留启动迁移窗口并观察 WAL/磁盘；它不是每次页面读取的成本。
- **缓存与前端边界**：SQLite page cache 从 16 MiB 提升到保守的 64 MiB；`/admin/api/stats` 与 `/admin/api/keys/usage` 使用 10 秒 fresh、5 分钟 last-known-good stale 的进程级 single-flight / stale-while-revalidate 缓存，并用 `X-Helm-Cache` 暴露 `miss/coalesced/fresh/stale`。动态 live window 使用稳定 cache key，历史闭合窗口仍按精确边界隔离。Admin 保留 hover code preload，但 data preload 改为 tap；dashboard 与 key detail 的独立读并行，隐藏 tab 不再执行自动刷新。当前生产库约 58.8 GB 且只有约 15 GB 可用、freelist 约 22.8 GiB，继续禁止在线 VACUUM；本次也不擅自开启 memory retention 或修改生产数据。

## 2026-07-15 · Codex 已重置冷却在 Admin 投影为成功（Admin providers UI，docs/11，原则 3/5/7）

- **UI 边界**：Gateway 与 reset-credit guard 保持不变；Admin 客户端仅把本地 `429 + reset_credit_cooldown_active` 解释为“该账号最近已经完成重置”，复用既有 `alreadyRedeemed` 成功路径并显示“重置已成功完成”。该投影不会重试、不会产生第二次 fetch，也不会再次请求 OpenAI。
- **错误边界**：进行中的 `reset_credit_reservation_active`、配额/资格问题、其他 429、guard 故障与真实上游失败继续作为错误显示，不能因本次 UI 修正被吞掉。定向测试同时断言 cooldown 只调用一次 fetch、相邻 429 仍拒绝，以及 Providers 成功状态不出现 error alert。

## 2026-07-15 · Codex 配额 PULL 饱和后触发自动重置（OAuth quota / reset credits，docs/04/11，原则 3/5/7）

- **生产根因**：账号已启用 `autoReset`、仍有 reset credit，显式刷新也从 Codex PULL 得到账号级周窗口 100%；但刷新链只持久化 snapshot、同步 live pool 并停车，自动重置仅由后续响应头 PUSH 触发。账号一旦因 PULL 饱和而停车，可能不再获得下一次响应头，形成“缓存页面持续显示 100%，自动重置没有入口”的延迟触发；生产实例最终在约 5 分钟后的新响应头到达时才成功消耗 credit，证明设置与 guard 本身正常。
- **触发边界**：cache-only 的 `/oauth/quota` 与 `/oauth/overview` 继续严格无副作用，绝不因读取旧 snapshot 消耗 credit；只有显式 refresh job 的新鲜上游 PULL 和实际响应头 PUSH 属于权威输入。PULL 在完成 durable/live quota 更新和 cooldown 停车同步后，仅对账号级周窗口 `>=100%` 调用并等待同一 `maybeAutoReset` 入口，避免先解停后又被异步停车覆盖；同一 Helm label 的并发触发复用同一个 in-flight promise。credit 成功消费后立即强制再 PULL 一次并更新 durable snapshot、live pool、剩余 credits 与 cooldown，cache-only 页面不会继续显示重置前的 100%。低于 100%、5h 窗口和 model-scoped 饱和窗口不触发；是否有 credit、共享账号幂等 marker、每小时 cooldown 与 workspace spend-control 拒绝仍由既有 reset guard fail-closed 判定。
- **验证**：TDD 先证明 fresh Codex PULL 没有传递自动重置信号，再覆盖真实 `primary + 10080m + 100%` PULL 必须按“停车 -> 触发”顺序执行、成功消费后 cache/live state 立即变为新窗口与新 credit 数、共享 ChatGPT 账号的第二个 Helm label 必须等待首个 reset/unpark 完成后才开始 PULL、99% 周窗口与 cache-only GET/overview 不触发。定向 4 files / 196 tests、Gateway typecheck、Biome 与 Gateway build 全绿。

## 2026-07-15 · Anthropic 不可用地域哨兵按全球基础卡计费（Catalog / telemetry accounting，docs/07/08，原则 2/3/5/7）

- **生产根因**：Anthropic OAuth 原生流会返回 `usage.inference_geo=not_available`，表示未提供推理地域，不是新的计费地域。地域计费上线后把任意非空字符串都当作已确认地域；catalog 只有 `global` / `us`，该哨兵因此被当作未知费率并令已有完整 token usage 的成功请求得到 `cost_usd=null`。模型、能力和价格条目均未缺失。
- **兼容边界**：计费边界只把空字符串和已确认的 `not_available` 规范化为“地域缺失”，使用既有全球基础卡；仍将真实但未配置的地域（如 `moon`）保持 unknown，避免猜价。原始哨兵继续保存在 telemetry 作为 provenance，不改写 provider 事实；实时响应与历史重算共用同一规范化函数，防止两套语义漂移。
- **验证与修复边界**：TDD 以生产请求的 Opus 4.8 token/cache 数复现 `$0.24682125`，覆盖未知地域严格拒绝、Anthropic SSE 哨兵保真，以及历史重算仅在 `best-evidence` 下把该哨兵作为全球假设。生产历史数据修复仍须使用既有 manifest、逐批微型恢复库、health/WAL/disk 门禁和 OAuth delta 一致性保护。

## 2026-07-15 · 终端事件缺失的 Responses 流使用部分估算计费（Protocol streaming / telemetry accounting，docs/05/07，原则 3/5/7/8）

- **终态语义**：provider 已产出首包仍保留成功 attempt，但 Responses 流只有收到 `response.completed` / `response.incomplete` / `response.failed` 才算有上游终态；无终态的自然 EOF 记为 `stream_outcome=truncated`、下游 abort 记为 `client_aborted`，request `final.status` 改为 error，分别使用 `upstream_error` / `client_abort`，不再把部分消费伪装成完整成功。`response.incomplete` 保留其独立终态；provider 明确报告的 usage（包括全 0）永远优先。
- **估算边界**：只在原生 Responses 流缺少 usage 时，对去除 transport 字段与内嵌 binary/base64 的语义 upstream request，以及实际收到的 output/reasoning/tool-call semantic delta 做 `estimated_partial` 估算。16 KiB 内使用 o200k-harmony，超过后改用既有 UTF-8 bytes/4 确定性估算，避免大上下文在 stream finally 阻塞事件循环；sequence number 去重，同一 semantic channel 的碎片先拼接，done snapshot 与 encrypted/base64 数据不参与。cache、cache creation 与隐藏 reasoning 不猜测，保持 null。估算费用沿现有 catalog `costOf` 计算，并以 `cost_basis=catalog_api_equivalent_estimate` 标记，不能解释为 provider 实际账单。
- **一致性边界**：同一份部分 usage/cost 同时写入 telemetry usage、成功 provider attempt、key budget 与实际 serving account 的 OAuth usage；每项只结算一次。stream generation window 与 usage 解耦，即使 usage 解析失败也保留 `generation_ms`。registry 使用同一 `stream_outcome`，不再把缺失终态默认成 completed。

## 2026-07-15 · 历史费用回填改由常驻 supervisor 持续推进（Catalog / telemetry repair operations，docs/07/08，原则 2/3/5/7）

- **执行边界**：一次性 Codex automation 改为 host systemd 常驻 supervisor；它通过非阻塞 `flock` 保证唯一执行者，并把大阶段拆成每次最多 100 行的独立 CLI 进程。每批提交并落盘 checkpoint 后才进入下一批，因此 SIGTERM、容器短暂不可用或 supervisor 重启都只会从原子 checkpoint 恢复，不需要大事务、整库备份或 `kill -9`。
- **资源控制**：启动前必须连续取得 3 个有余量样本；运行中持续检查 host load/MemAvailable、Helm CPU/内存、health status、WAL、磁盘、restart/OOM 与结构化 5xx/timeout/`SQLITE_BUSY`。Helm CPU 的 preflight 与 runtime stop 阈值统一为 75%，runtime 仍要求连续 2 次达到阈值才暂停；HTTP 200 的 health latency 仅保留在状态中作观测，不再触发暂停，但 non-200 与 `collectSample` 的 5 秒 probe timeout 仍 fail-closed。supervisor 每批 apply 前已经完成该采样，因此 apply CLI 显式使用 `--skip-health-check`，避免在同一批次前重复调用 health endpoint。2GiB 主机的 MemAvailable 采用 512MiB preflight / 384MiB runtime stop，保留 128MiB hysteresis，并继续叠加容器内存比例与 health/CPU 保护，避免原 768MiB 固定门槛在约 588MiB 稳态可用内存下永久饿死。Gateway `request.error` 显式记录 `fault_scope`：可预期的结构化请求错误为 `request`，未知 throw 为 `gateway_internal`；5xx/timeout 总数继续写入状态作纯观测，只有 `gateway_internal` 5xx 与 `SQLITE_BUSY` 会触发 supervisor safety stop，因此正常 `all_providers_failed` 的 error/completed 双日志不能阻断回填，而真正内部故障仍 fail-closed。硬阈值触发后 supervisor 留在 `waiting_safety` 并自动重试，不把辅助回填失败扩散为网关故障；每 5,000 行强制至少冷却 5 分钟。固定截止点为 `2026-07-15T13:28:46+08:00`，不追逐持续增长的新流量。
- **验证与可观测性**：`pricing:reprice` 新增只读 manifest slice verifier，逐批验证 telemetry 顶层总价、attempt completion、breakdown、alias/status/timestamp 全部已成为 manifest new state；窗口完成后再全量验证。supervisor 原子写入 `supervisor.status.json`，记录 phase、窗口/checkpoint、最近指标、费用 delta、错误与备份聚合哈希；Codex 定时任务部署后只读该状态并汇报，不再直接写生产数据库。manifest 仍按 UTC 日窗、`best-evidence`、固定 pricing/plan hash 依次生成，歧义行保持不变。

## 2026-07-15 · 历史重算兼容旧版 completion-only 顶层费用（Catalog / telemetry repair，docs/07/08，原则 2/5/7）

- **生产根因**：渐进回填在 June 29 manifest 的第 1,580 行 fail-closed；该 legacy telemetry 的 `provider_attempt.cost_usd` 与 `cost_breakdown.completion_usd` 都是 `$0.118735`，`cost_breakdown.total_usd` 是包含输入费用的 `$0.1193894`，但旧版顶层 `telemetry.cost_usd` 仍只保存 completion cost。planner 正确选择 breakdown total 作为 canonical old total，apply guard 却只接受顶层值已等于该 total 的新格式，导致合法旧格式无法应用；剩余 25,269 行只发现 3 行属于此精确形态，且没有其他 unmatched 状态。
- **兼容边界**：apply 仍优先要求 canonical top-level total；仅当 old completion 与 old total 均非空且不同、顶层值与 attempt 都精确等于 old completion、breakdown completion/total 又分别精确等于 manifest 的 old completion/total 时，才接受 completion-only legacy 状态。任一字段漂移仍 fail-closed；更新后顶层与 breakdown 都统一写入新 canonical total，原行继续由每批 targeted backup 保留。
- **验证**：TDD 回归先复现 `old values no longer match manifest`，再证明 legacy 行可完成单批更新；原有任意顶层费用冲突测试继续拒绝。生产回填在发布新版本前保持暂停，已提交的 1,500 行与全部微型恢复库另行完整校验。

## 2026-07-14 · 生产模型官方价格与多模态计费全量校准（Catalog / telemetry / protocol usage，docs/04/05/07/08，原则 1/2/3/5/7/8）

- **生产与数据源边界**：只读核对 `la.atmy.work` 的 `0.27.4 / fd806a3`、bind-mounted `pricing.yaml` / `capabilities.yaml` / `providers.yaml` 与 37 个可路由 alias；价格在启动时载入进程内 catalog，不存在远程价格缓存，`oauth.codex_model_cache` 只保存模型发现/entitlement。官方对照仅使用 OpenAI、Anthropic、Google、DeepSeek、xAI 价格页；动态 `zenmux/auto` / `openrouter/auto`、没有公开费率的 `xai/grok-composer-2.5-fast` 与无固定公开价的 `openai-codex/codex-auto-review` 必须保持 `cost_usd=null`，不得伪造固定价。
- **费率修正**：补齐 DeepSeek Flash/Pro cache hit，OpenAI GPT-5.5/5.4/mini cached input、GPT-5.6/5.5/5.4 `>272K` 全请求阶梯、OpenAI/xAI Flex/Priority、Gemini Pro `>200K` 全请求阶梯、Flash-Lite audio/cache、Gemini image text/thinking 与 image output 分价，以及 Anthropic 5 分钟/1 小时 cache write。Anthropic Opus 4.8 Fast 只在官方 `usage.speed=fast` 时使用 `$10/$50` 基础卡及 `$1/$12.5/$20` cache read/5m-write/1h-write；ZenMux Fast 未验证，不借用该卡。Sonnet 5 的 `$2/$10` 介绍价截至 2026-08-31，之后仍需按官方标准价更新。
- **计算与保真**：context tier 按跨阈值后的整次请求计价，不做边际分段；只采信响应实际 `service_tier` / `usage.speed`。Gemini 的顶层 `serviceTier` 在原生请求与 IR 间双向透传，响应/流式 `usageMetadata.serviceTier` 也进入计费 normalization；`unspecified` 按 Standard，未知非标准 tier 保持 unknown。Anthropic 响应实际 `usage.inference_geo=us` 由 eligible direct model 的 config rate card 对整次 token/cache/service-tier 成本叠加官方 `1.1x`，`global` 为 `1.0x`，未知 geo 不猜价。所有实际用于计费的 provider response normalization 路径都保留 Anthropic cache TTL、Gemini prompt/cache/candidate modality、thinking token 与 OpenAI Chat `completion_tokens_details`。分价模型若上游缺少 modality partition，返回 unknown 而不是把全部 token 猜成低价 text 或高价 image。Telemetry SQL 聚合改用 canonical `cost_breakdown.total_usd`，避免遗漏 Layer-2 eval；memory compaction economics 同样选择当前 thread token 数对应的 context tier。
- **影响与限制**：按当前生产历史只读估算，旧规则净高估约 `$55.6k`，主因 GPT-5.5/5.4 cached input 曾按全价；另有长上下文和 DeepSeek 小额方向相反修正。历史 telemetry 只有四个聚合 token 字段，不能猜测丢失的 tier/TTL/modality；新的 `DecisionRecord.usage` 会向前保存实际 service tier、inference geo、5m/1h cache-write、audio/cache、image output 与 relay-billed USD，供以后安全重算并保留权威账单 provenance。此变更未回填数据库、未修改生产配置、未部署；显式 Gemini cache storage 的按小时资源费不属于 request token usage，当前也不创建该资源。Anthropic native server tools 虽可经 `/v1/messages` passthrough 到达，但 web-search 次数费与 code-execution container-hour（含免费额度/组合工具免费语义）不是 token price primitive，本次不把它们猜进 catalog，需另建非 token usage/cost provenance。新增 catalog 覆盖测试保证所有手工生产 alias 都有显式价格决策，并对 unsorted tiers fail-closed。
- **历史重算边界**：新增 `pricing:reprice` 运维工具，默认 dry-run，并以确定性 manifest/hash、定向 SQLite 恢复备份、`quick_check`、事务内重验和幂等更新保护生产数据。`exact` 只使用已持久的 tier/TTL/modality/billed-cost 证据；`best-evidence` 额外允许把缺失旧 tier 的 direct/Codex GPT 记录按 Standard 重算，但必须在 manifest 单列该假设。Relay-billed、Anthropic TTL、Gemini modality 等证据已被旧 retention 丢弃的记录保持不变；`oauth_usage` 不能从 telemetry 整表重建，只对带 `serving_account` 且 bucket 仍存在的已重算完成费用做 delta 更新，未映射的旧记录只修 telemetry 并显式计数。
- **渐进回填安全边界**：生产回填不得重新扫描 34GB telemetry 或使用整库备份；dry-run manifest 只生成一次，后续 `--apply-manifest` 默认每次最多执行 1 批、每批 100 行，并在多批模式间隔 5 秒。每批先校验线上 health、WAL 小于 1GiB、可用磁盘至少 10GiB，再校验旧值、创建只含该批 telemetry/OAuth 原行的微型恢复库并执行 `quick_check`；主库只在短 `BEGIN IMMEDIATE` 事务里更新该批 telemetry 与按 pending 行聚合的 OAuth delta，提交后原子推进 checkpoint。事务已提交但 checkpoint 未落盘时，下一次依据 new-value 状态跳过该批，不能重复扣加 OAuth。CLI 强制 manifest hash、当前 pricing hash、health URL（或显式跳过）并禁用整窗口 `--apply`；manifest 写入文件时 stdout 只输出摘要，避免终端复制 38 万行 JSON。
- **非 token 附加费 TODO**：native Anthropic passthrough 可达官方 server tools；Web Search 另收 `$10/1,000` 次搜索，Code Execution 在组织免费额度后按 container-hour 计费，而普通 client-side tool call 与 Web Fetch 无额外调用费。当前 usage/telemetry 没有保存足以结算 Code Execution 免费池与容器时长的证据，因此本次只修模型 token 费与可由响应确认的 `inference_geo`（US data-residency 费率为对应模型 token/cache 卡的 `1.1x`），不把 server-tool 附加费伪装成可精确历史重算；后续需另增非 token usage ledger。

## 2026-07-14 · 确定模型名优先于兼容通配别名（Routing / model alias precedence，docs/04，原则 2/5/6）

- **生产根因**：请求 `6becfc0f-9ce7-43c6-b604-322972f5aa59` 明确指定已配置 lane `claude-opus`，但兼容映射先执行；`claude-opus-*` 因字面连字符不匹配裸名，宽泛 `claude-*` 把请求改写到 `balanced`，最终首候选 `openai-codex/gpt-5.6-terra` 成功。telemetry 的分类 `passthrough` 仅表示跳过分类器；该次原生协议直通实际因 `anthropic_messages -> openai_responses` 不匹配而关闭。
- **统一优先级**：`allow_custom_model` 且未触发 budget degrade 时，先识别精确配置 lane，再识别部署已知的精确 model alias；只有两者都不存在时才进入 `model-aliases.yaml`，并继续保持“精确映射键优先、最长字面量 glob 次之”。因此所有当前及未来 lane 都不会再被 `claude-*` / `gpt-*` / `gemini-*` 吞掉；固定 vendor id（如 `claude-opus-4-8`）仍通过兼容映射进入族 lane。
- **行为边界与验证**：精确 lane 恢复 docs/04 既定的完整 fallback 与 `allowed_lanes` 显式 400 语义，精确 model 保持单候选；标准 key、`auto`、blocked models、image pre-pin、budget degrade、alias cap 与 headless legacy 均不变。`gpt-5.6` 的 telemetry lane 从兼容目标 `gpt-5.6-sol` 恢复为精确 `gpt-5.6`，首个实际模型仍为 Sol。路由单测覆盖 Claude/GPT/Gemini 全部碰撞族及精确 model，shipped-config 组合测试遍历全部 lane 防止未来回归；无需 schema 或配置迁移。

## 2026-07-14 · 通道模型选择器复用自动发现缓存（OAuth subscription / Admin lanes，docs/04/11，原则 1/3/6）

- **生产根因**：账号管理弹窗与运行时 provider pool 已把非 Codex 自动模式的远程模型目录写入同一个账号级进程缓存，但 `/admin/api/models` 的通道选择器投影没有读取该缓存，也没有跨进程保存成功目录；Anthropic/xAI 因而只显示代码内静态 fallback，Copilot 在没有静态 fallback 时甚至不显示任何自动发现模型。
- **统一投影与存储**：通道目录继续保持 network-free（读取时不发上游请求），Anthropic、Copilot、xAI 自动模式依次使用共享进程缓存、现有加密账号设置中的 durable last-known-good 目录、curated fallback；Admin 刷新与 runtime pool synthesis 只持久化仍被当前 cache generation 接受的非空发现。同名账号重连先失效旧 generation、严格清理旧身份 snapshot，成功后才替换 credential；手动模式仍只使用持久 allowlist，Codex 仍使用独立的持久 ModelInfo catalog，不改变 entitlement 边界，也无需数据库迁移。
- **失败语义与验证**：空目录或发现错误绝不覆盖 durable last-known-good；缓存和持久快照都不存在时才使用既有 curated fail-open fallback。后台 snapshot 写失败只告警、不阻断路由；但加密设置读取/解密/JSON shape 失败时严格拒绝任何 mutation，不能用空 map 覆盖 proxy、priority、allowlist 等既有状态。TDD 覆盖三种非 Codex provider、进程缓存丢失后的持久恢复、Manual 隔离、旧 credential 并发发现、重连清理顺序、损坏设置防覆盖与写失败 fail-open；定向 5 files / 153 tests 全绿。

## 历史条目摘要（最新要点）

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

2026-07-07–09 压缩条目包括 self-service portal 完整实现与多语言、视觉压缩后的 cache-control 收敛和 Anthropic 兼容路径 CCH 稳定化。

2026-07-06 压缩条目还包括 Anthropic native passthrough 稳定 Claude Code billing `cch`、Admin 模型搜索预计算列、payload 分段懒加载、纯工具 turn 去空 header/默认展开，以及 Claude Code 风格 inline tool peek。2026-07-04 更早条目还包括 cheap-model 当前轮低风险降级、视觉上下文压缩 observe/off 接入、Memory stats 队列索引优化、OAuth 会话亲和调度、idle-flush 碎片段优先压缩最大连续段、memory worker 受控并发追赶、记忆页只读运行状态面板、Claude scoped weekly quota 只影响对应模型、跨协议 reasoning-history 候选级跳过、memory idle-flush 防饥饿、策略级 reasoning_effort 覆盖 lane 默认值、cron monitor 低成本规则等。2026-06-30 及以前的工作主要围绕 Helm API 的协议面、路由执行、admin 可观测性与自托管部署逐步成型：补齐 Gemini/OpenAI/Anthropic/Responses 双向转换、SSE 流式正确性、tool-call/JSON schema/思考参数保真、per-model reasoning effort、模型别名与能力/成本目录、provider fallback 与熔断语义、OAuth subscription providers、多账户池与 quota 处理、memory observe/inject/forgetting/admin/MCP、请求 payload 捕获与 request detail UI、API key 治理、admin 表格/过滤/分页/i18n、Docker/CI/release/deploy 验证，以及早期 Phase 0 的 Hono + SvelteKit static admin + Store 端口 + SQLite/Supabase 架构决策。更早细节不再逐条保留在本文件；需要精确背景时回查 git history。
