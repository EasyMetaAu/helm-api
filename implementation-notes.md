# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

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

## 2026-07-14 · 丢弃 Codex 空 secondary 配额占位窗口（OAuth quota / Admin providers / reset credits，docs/04/11，原则 3/5/7）

- **生产根因**：Codex 部分账号的响应头会同时返回真实 `primary + windowMinutes:10080` 周窗口，以及 `secondary + usedPercent:0 + 无 duration + reset-after:0`。后者只是空占位，但 header parser 将其作为配额写入；latest-wins snapshot 随后覆盖完整 PULL 数据，Admin 又把未知时长的 positional key 翻译成“次窗口”，造成看似存在第二个额度且 7 天用量消失。
- **三层防御**：header parser 在入库前丢弃“0% + 无时长 + 截止采集时已重置”的窗口；Admin cache-only API 与 Providers 页面用 snapshot 自己的 `capturedAt` 过滤旧版本已写入的同类脏数据，部署后无需等待新请求或人工清库即可恢复展示。未来重置、非零用量或带真实 duration 的窗口继续保留，避免误删刚开始的新周期与 legacy 数据。
- **周额度权威**：周窗口改为集合级选择：账号级 `windowMinutes >= 10080` 的明确时长窗口优先；只有整组没有明确周窗口时，才兼容使用非零的未知时长 `secondary`。model-scoped 窗口仍排除。Admin、自动重置和 reset-credit 幂等 guard 共用该选择，空 positional 数据不能再覆盖真实周用量或 reset marker。
- **验证**：TDD 定向覆盖 live header 形态、durable cache 旧快照、Providers 标签、明确周窗口优先、legacy fallback 与 reset-credit guard；6 files / 219 tests 全绿。

## 2026-07-14 · Subscription Providers 改为缓存优先与全局串行刷新（OAuth Admin / provider observability，docs/04/11，原则 1/3/6/7）

- **性能根因**：Providers 首屏过去并行请求 status、usage、quota；status 会刷新过期 token 并逐账号发现模型，quota 会逐账号拉取上游额度、写 snapshot、同步 cooldown 并清理 orphan。慢代理、上游限流或账号数增加会把页面打开直接绑定到外部网络，刷新按钮和自动刷新也会重复制造同一批工作。
- **缓存读边界**：新增单次 `GET /admin/api/oauth/overview`，只读取本地 token/settings、进程内模型/额度 snapshot、durable quota 与当日 usage；不得刷新 token、发现模型、请求 quota、删除 orphan 或修改 cooldown。原 `/oauth`、`/usage`、`/quota` 同样改为 cache-only，保持兼容但不再隐式产生上游流量；无需数据库迁移。
- **刷新队列**：显式 `POST /admin/api/oauth/refresh` 立即返回 `202`，由 Gateway 进程级 coordinator 保证全局最多一个 active job；并发点击合并到同一 job，成功或失败后冷却 60 秒。job 内按账号串行刷新 token、模型目录与 quota，显式刷新可绕过正/负 TTL 缓存；Anthropic/Codex 模型发现增加 10 秒硬超时，避免死代理长期占住唯一 worker。
- **失败与旧数据**：任一账号的 quota 超时、空/非法窗口或持久化失败会把 job 标为 `failed` 并记录安全错误摘要，但不会删除 last-known-good snapshot；其余账号仍继续串行刷新。页面展示 queued/running/succeeded/failed、最近成功时间与 cooldown，手动点击只入队一次并 cache-only 轮询，定时自动刷新永远只读缓存。
- **验证**：TDD 覆盖 cache-only 首屏、20 次并发点击合并、账号刷新最大并发 1、失败保留旧 quota、force cache bypass、模型发现 timeout、前端单请求加载、手动/自动刷新分流与多语言状态文案；workspace 357 files / 5775 tests、typecheck、Biome、build 与 Admin check 全通过。

## 2026-07-14 · Avoid Waste 在 provider 池内限制 reset-credit 偏置（OAuth provider selection，docs/04/11，原则 3/5/6）

- **生产根因**：`openai-codex` 的四个 Plus/Pro 账号已正确合并进同一 provider pool，套餐名没有参与分池或筛选；但 reset credit 的虚拟周容量乘数为 `10`，单个 credit 的加分远高于自然周窗口。生产中 31% 已用、3 credits 的 Pro 账号因此持续压过 2% 已用、0 credits 的 Plus 账号，形成看似按套餐分组的长期偏置。
- **评分边界**：同一 provider 内继续按账号优先级、模型 entitlement、可调度/限流状态形成候选集；Avoid Waste 的主分数仍来自即将重置的真实 5h/周额度。reset credits 保留为弱的可恢复容量信号，每个 credit 只贡献完整自然周窗口加权分数的 5%，可打破接近分数，但不能压过明显更多的真实即将过期额度。Plus/Pro/Team/Business 等套餐标签仍只用于身份与配额展示，不进入选择逻辑。
- **验证**：TDD 使用生产比例覆盖同一池内 `2% + 0 credits` 对 `31% + 3 credits`，并保留真实额度相同情况下 credits 参与选择的回归；定向 pool 测试、typecheck、lint 与 build 作为交付门禁。

## 2026-07-13 · Responses 工具结果的 multipart 文本使用 input_text（Protocol translation / provider execution，docs/05/07，原则 3/5/8）

- **生产根因**：请求 `7963c4fa-c0ea-436f-aa4d-af0beb41615e` 从 Anthropic fallback 到 Codex Responses 时，数组形式的 `tool_result` 被编码为 `function_call_output.output[].output_text`；该 item 属于 Responses 请求输入，上游只接受 `input_text`，因此返回确定性 400 `invalid_request`。
- **修复边界**：provider 专用 Chat→Responses 与共享 IR→Responses 两条路径统一把 multipart 工具结果文本编码为 `input_text`；字符串工具结果仍保持字符串，`input_image` 与 `input_file` 保持原 wire shape。助手消息正文继续使用 `output_text`，不扩大成全局 content-part 改写，也不改变 `invalid_request` fallback 语义。
- **验证**：TDD 红灯同时覆盖 provider、共享 transformer 与真实 Anthropic `tool_result`→Codex Responses 链路；定向 Vitest 绿灯为 2 files / 274 tests。

## 2026-07-13 · Codex 周配额按真实窗口时长识别（OAuth quota / Admin providers / reset credits，docs/04/11，原则 3/5/7）

- **生产证据与根因**：生产 `oauth_quota` 中四个 Codex 账号都出现 `primary + windowMinutes:10080`，截图中的唯一窗口虽显示 `5h`，重置倒计时却是 `6d 22h`。上游不同套餐不再保证 `primary=5h / secondary=7d`，Admin 的位置硬编码因此把真实周配额错标为 5h；同一假设还会让手动/自动 reset-credit 误报周快照不可用。
- **统一判定**：账号级 Codex 周窗口以 provider 报告的 `windowMinutes >= 10080` 为权威；只有旧 header 快照缺少 duration 且窗口有真实用量时才兼容回退到 `secondary`。带非默认 `limitId` 的 model-scoped 窗口绝不当作账号周配额。Admin 标签同样时长优先（300m→5h、10080m→Weekly）；有意义的缺时长窗口显示中性的 Primary/Secondary，空的已过期占位窗口则直接过滤。
- **账号边界**：规则完全 plan-agnostic，覆盖 Codex Plus/Pro/Team/Business/Enterprise/Edu 等实际窗口形态，不按套餐名维护分支。Claude 继续使用其 5h/7d keys；Copilot、SuperGrok 与普通 API-key provider 没有可验证的同类 Codex reset-credit 周窗口，不套用本规则或伪造数据。
- **验证**：共享 predicate、Admin 单周窗口、reset-credit UI、自动重置与持久 guard 均增加 `primary + 10080m` 回归；同时覆盖 `secondary + 300m` 不误判、缺 duration 的 legacy fallback，以及 model-scoped 周窗口隔离。

## 2026-07-12 · Grok premium fallback 与 Composer 评估边界（Routing / provider evaluation，docs/04/07，原则 2/3/5/6/7）

- **移除 official OpenAI 付费 lane 候选**：所有 `openai/gpt-*` 从 shipped lanes 删除，只保留 provider、能力与价格定义供显式 custom-model 使用；GPT vendor lanes 在 Codex subscription 不可用时进入通用订阅/静态 fallback，不再自动触发 official OpenAI 账单。`gpt-image` 改由 ZenMux relay 的 `gpt-image-2` 领衔，official Images API 同样不再被 lane 自动选择。
- **Vision 订阅限定**：`vision` 改为 Codex Terra → Grok 4.5 → Claude Sonnet 5 → Claude Opus 4.8，全部为订阅 provider；`zenmux-vertex/gemini-3.5-flash` 从该 lane 移除，但 dedicated `gemini-flash` vendor lane 与底层 provider/catalog 保留供显式 Gemini 请求。链使用 concrete aliases，不再隐式展开 `premium`。
- **路由调整**：`premium` 在 Claude Opus 前加入 `xai/grok-4.5`，使已连接且健康的 SuperGrok 账号吸收原本进入 Opus 的 fallback 流量；未连接、park 或 provider failure 继续 fail-open。Haiku 改为 Anthropic OAuth → economy，不再自动使用 ZenMux Haiku；GPT-5.5 改为 Codex GPT-5.5 → premium，不再自动使用 `zenmux/gpt-5.5`；GPT-5.4 继续由真实 Codex GPT-5.4 领衔。`zenmux-anthropic/claude-opus-4.8` 同样只从 lanes 移除，所有被移除的 provider/catalog 定义仍保留供显式调用。
- **Composer 边界**：真实 A/B 暴露 200 + stop + 空正文与质量不足后，不进入 economy，也不再保留独立 canary lane；底层 OAuth 模型发现与 transport 兼容仍保留，避免把一次路由决策扩大成 provider 协议删除。
- **真实 A/B**：本地 Docker 使用同一账号、总并发 2，Composer 与 Grok 4.5 各执行 30 个相同任务，覆盖 exact/factual/coding/long-context/speed/tool。Composer HTTP/模型命中 30/30、SSE `[DONE]` 30/30、工具参数 4/4、长上下文 6/6、长输出 TPS 中位数约 197，但事实仅 2/5、编码仅 1/4，6 次出现 200 + stop + 空正文，总质量 24/30（80%），可见 TTFT p95 约 1.59s；未达到 economy 晋升门槛。Grok 4.5 模型命中 29/30、质量 28/30、工具 4/4、长上下文 6/6、长输出 TPS 中位数约 138，但出现一次 504，成功率 96.7%、可见 TTFT p95 约 22.9s；速度达标但可靠性未达到 99%，因此只保留 premium fallback，不进入 balanced 或 primary。
- **Docker 证据**：授权恢复后账号 `healthy:true` 且同时发现 `grok-4.5` / `grok-composer-2.5-fast`，真实 quota PULL 返回 `7d` 周窗口；三条预检分别真实命中 Composer、direct Grok 和 premium→Grok。授权前 premium 的 Grok 候选以 `provider_unavailable` 跳过并继续由 ZenMux Opus 成功，证明未连接边界 fail-open。测试 key 已全部禁用；容器限制 2 CPU / 2 GiB，结束时 healthy、restartCount 0。
- **Lanes 模型选择器修复**：xAI 自动模式虽然能通过账号发现参与真实路由，但网络无关的 `/admin/api/models` 投影缺少 xAI picker fallback，导致选择器无 `xai/*` 建议。现将已验证的 `grok-4.5` 与 `grok-composer-2.5-fast` 加入仅供已绑定账号使用的 Admin 投影 fallback；它刻意不进入 core `CURATED_OAUTH_MODELS`，所以真实路由在 xAI `/models` entitlement 发现失败时仍 fail-closed。手动模式可按账号缩窄 allowlist，未连接账号不会凭空出现。

## 2026-07-12 · SuperGrok 周配额使用现有 OAuth 读取私有 gRPC-Web credits（OAuth subscription / Admin providers，docs/04/09/11，原则 3/6/7）

- **协议与认证证据**：grok.com 当前通过 `grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` 读取消费者订阅 credits；官方 Grok CLI 同时暴露独立的 `/v1/billing` 私有接口。真实账号 A/B 验证确认 Helm 现有 `auth.x.ai` access bearer 可直接调用 credits RPC（无认证为 gRPC `UNAUTHENTICATED`，同一 Helm bearer 成功），因此不保存浏览器 Cookie、不引入 Management Key，也不申请额外 scope。token refresh 和请求继续复用账号代理。
- **额度语义**：只把 `credit_usage_percent` 与 `current_period.type = WEEKLY`、有效 start/end 归一化成账号级 `7d` window；缺省 proto3 percentage 按 0，超过 100 的上游值原样保留。`/v1/billing` 的 `monthlyLimit/used` 属于另一套月度 billing 语义，绝不冒充周配额；public `api.x.ai` credits 也不参与 SuperGrok quota。
- **安全与失败语义**：请求固定为 unary gRPC-Web、禁用 redirect、8 秒 timeout、1 MiB Content-Length 与流式双重上限；响应必须严格满足单个 data frame、单个最终 trailer、唯一 `grpc-status: 0` 与 EOF，并校验 protobuf wire type。周周期除 enum 外还必须具有 6–8 天的实际跨度且当前有效；malformed、stale、oversized、非周周期或上游失败均进入 5 分钟正/负缓存并 fail-open，保留旧 snapshot 或显示 `—`，不得影响推理请求。同名账号重连或 logout 成功后递增账号 cache epoch 并删除 durable snapshot；旧身份的并发 PULL 返回时不得写回缓存或存储，避免新身份继承旧 quota/cooldown。Logout 即使在 token 删除后发生设置/配额清理失败，也必须按 durable token truth 重建 live pool，不能让内存 token 继续路由。
- **路由与存储**：成功 PULL 写入 `source: xai`，同步 durable quota store 与 live pool；100% 账号级周窗口沿用既有 cooldown 规则停到 reset，低于 100% 只作为 `low_risk` / `use_expiring` 的软评分信号。SQLite/Postgres 在 quota PULL 前先收到 xAI 429 时，synthetic cooldown row 也必须标记 `xai`，不能伪装成 `codex-headers`。无需数据库迁移，`source` 底层仍为 text。
- **验证**：parser/shared/Gateway route/seam/SQLite/Postgres 定向测试共 197 个通过（含严格 trailer、周期跨度、并发身份切换、durable quota 生命周期与 logout partial-failure 回归）；真实已连接 xAI 账号通过现有 Helm bearer 返回并解析出 `7d / 0% / 10080m` 与准确 reset timestamp。workspace build、typecheck、Biome 全通过。完整 355-file Vitest 并发运行中 14 个无关 PGlite case 因 15 秒资源竞争超时；对应 4 个失败文件随后单 worker 重跑 161 个测试全部通过。

## 历史条目摘要（最新要点）

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
