# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-08-24 · Grok quality 图片以 2:3 上游结果中心裁切绘本画幅（Images，Imagine spec §4.1，原则 3/6/7）

- **兼容决定**：`grok-imagine-image-quality` 新接受 `3:4` 封面与 `4:5` 内页；Helm 的唯一付费 POST 固定向上游请求 `2:3 + b64_json`，再以整数像素最大内接矩形做确定性中心裁切，不重采样、不二次调用 provider。
- **响应边界**：客户端请求 `b64_json` 时仍返回 `data[].b64_json`；请求 `url` 时返回同一 `data[].url` 字段中的 `data:image/...;base64` URL，避免为裁切结果新增对象存储与 SSRF 下载面。Sharp 是仓库原先缺少的唯一运行时图片编解码依赖；结构 QA 不替代人工视觉验收。

## 2026-08-24 · Codex Responses 续接 ID 可在账号池内有界找回原账号（OAuth provider / Responses，docs/04/05/07，原则 3/5/8）

- **恢复边界**：同一账号、同一 WebSocket 的一次原样重试仍优先；只有它再次返回精确的 `400 Invalid previous_response_id` 且尚未产生客户端可见输出时，OAuth pool 才逐个尝试其余同 provider、同 model 的可调度账号。其他 4xx、限流、凭证、超时、断连与已开始输出的错误继续保持原有 fail-closed 语义，搜索次数天然受账号数限制。
- **亲和修复**：找到能继续该 ID 的账号后，同时更新进程内 sticky 映射与 durable Responses registry 中旧 ID 的 `provider_account`；后续续接优先回到这个实际拥有状态的原账号。全部账号都报告不存在时仍返回最后一个上游错误，不删除 ID、不伪造历史，也不跨 provider/协议。

## 2026-08-20 · Grok 视频输入对齐 xAI 官方 reference-to-video 合同（Videos，Imagine spec §4 / Phase 1 §2–5，原则 2/3/6/7）

- **官方合同与最小修复**：2026-08-20 复核 xAI Videos 文档与 Sub2API `49504adc` 后，确认 stable `grok-imagine-video-1.5` 接受 1–7 张 `reference_images`、七种画幅，以及最多 3 个预设 `{ voice_id }` `reference_audios`；image-to-video 接受可选画幅并支持 1080p。共享严格 schema 在同一边界扩展这些字段，`images` 兼容输入仍只在付费 POST 前规范成 `reference_images`。
- **兼容、实测与限制**：generation/extension 时长扩大为官方 `1–15` 秒整数，同时保留已公开的 `30` 兼容值；reference-to-video 仍限 480p/720p。当前只开放普遍可用的预设 voice ID，不开放需 partner 权限且会引入大正文处理的自定义音频 URL；既有 prompt-only `audio` 仅作为历史兼容，不把它宣称为官方 REST 字段。付费单写、账号 entitlement、receipt 绑定和 `outcome_unknown` 边界不变。本机 SuperGrok OAuth 单写 canary 已验证 1 张参考图 + `eve`、16:9/9:16、720p、8 秒和 AAC 音轨；1080p、其他时长与其他画幅未做付费穷举。

## 2026-08-20 · 配额周期历史新增已用百分比（OAuth providers，原则 3/7）

- 重置边界记录新增可空 `usedPercent`，仅在以后观测到周期关闭时从上游快照写入；旧行不回填，无法证明的近似/日周聚合继续显示空值。
- SQLite/Postgres 各新增一次可空列迁移；当前周期仅使用未过期快照，避免把上一周期百分比套到新周期。

## 2026-08-19 · Codex Responses 续接 ID 在原 WebSocket 上做一次有界恢复（OAuth provider / Responses，docs/04/05/07，原则 3/5/8）

- **根因与修复**：生产证据显示多个刚成功的同账号续接约一秒后收到上游 `400 Invalid previous_response_id`，且成功与失败请求使用相同 native sanitizer；这不是账号轮换或正文变换。provider 现在只在首个客户端可见输出前、只针对该精确 400，在同一上游 WebSocket 上原样重发一次，吸收短暂的上游状态传播竞态。
- **安全边界**：重试不删除 `previous_response_id`、不换账号/模型、不重建正文，也不占用连接重建预算；第二次相同错误继续关闭 session 并 fail-closed，避免确定性坏 ID 循环或上下文串线。无 schema、配置或依赖变化。

## 2026-08-19 · Grok 视频统一 30 秒并复用单写链增加扩展接口（Videos，扩展方案 §4–7，原则 2/3/6/7）

- **统一合同**：纯文本、单图、多图与 extension 共用 `6 | 10 | 15 | 30` 时长；单图 stable/preview 名称复用既有 preview entitlement，但 stable 请求仍以 `grok-imagine-video-1.5` 原样发送。当前 Grok Build 证明多图上游 wire 为 stable `grok-imagine-video-1.5 + reference_images: [{ url }]`；Helm 因此只允许 stable 1.5 多图 model，并把严格互斥的兼容入参 `images` 在付费 POST 前统一转成 `reference_images`，不做单图/多图升降级。
- **执行边界**：`POST /v1/videos/extensions` 复用 generation 的鉴权、预算、付费单写 reservation、telemetry、receipt registry 与固定账号 poll；provider 精确发送 `/videos/extensions`，任何 transport/5xx/无 receipt 都返回 `503 outcome_unknown`，不重试、不换账号。未新增 Store、migration、无版本别名或内容代理。
- **验收与限制**：shared/provider/OAuth/route/OpenAPI 定向测试及 `e2e/videos.spec.ts` 通过；离线 e2e 覆盖四种 30 秒 body、单次 POST、跨 key、账号亲和与重启恢复。2026-08-19 获授权后，本机账号的 30 秒纯文本生成仅 POST 一次，上游链返回 `503 outcome_unknown` 且无 receipt；按单写边界没有重试，extension POST 为 0 次。用户随后确认该环境账号不支持 30 秒；新的 15 秒纯文本 canary 仅 POST 一次，取得 receipt 后经同账号 18 次只读轮询到 `done`，结果 URL 有效，`ffprobe` 实测 15.041667 秒。15 秒单图 canary 使用 `grok-imagine-video-1.5-preview + image` 仅 POST 一次，经 8 次同账号 GET 到 `done`，下载结果同样实测 15.041667 秒。修正前的多图 `grok-imagine-video + reference_images` canary 返回 `503 outcome_unknown` 且无 receipt，没有重放；按 Grok Build 当前合同改为 `grok-imagine-video-1.5 + reference_images` 后，一次本机入站鉴权错误被 Helm 以 401 拒绝且未进入付费链，随后一次有效鉴权的付费 POST 取得 receipt，经同账号 6 次 GET 到 `done`，结果实测 15.041667 秒、1280×720。当前真实证据证明 15 秒纯文本、单图与多图 generation；仍不证明 30 秒或 extension 的真实能力。

## 2026-08-19 · 保留已公开的 Grok Imagine 媒体选项（Images / Videos，Phase 1 spec §4–9，原则 3/6/7）

- **兼容决定**：用户确认 fast image 与 prompt-only video 的已公开选项不得移除。`grok-imagine-image` 继续接受并透传 `n=1..4`、六种 `aspect_ratio`、`resolution=1k` 与 `response_format=b64_json`；`grok-imagine-video` 继续接受并透传 `aspect_ratio`、`duration=6/10/15`、`resolution=480p/720p/1080p` 与 `audio`。合同仍为严格对象，不开放任意未知字段或 ZDR `output`。
- **边界不变**：此次只恢复请求 schema 兼容性；model/key 授权、blocked model、预算 fail-closed、OAuth 账号选择与固定账号轮询、付费 POST 单写，以及视频 `done` 必须带非空 `video.url` 均保持不变。旧 quality image、single-image video 与 reference-video 路径不改。

## 2026-08-18 · Grok Imagine 合并后收紧 entitlement 与媒体协议边界（OAuth / Images / Videos，Phase 1 spec §4–9，原则 3/6/7/8）

- **撤权与 cooldown**：xAI billing 刷新失败不再删除整条 quota；改写入 `windows: []` 的 entitlement tombstone，复用两种 Store 已有的 upsert 语义保留 `usageLimitedUntilMs`。若 tombstone 无法持久化，进程级紧急 latch 会先摘除全部 xAI 媒体 alias，并在任何普通 OAuth pool rebuild 后继续生效；只有权威 billing 刷新成功持久化且对应 rebuild 成功后才恢复。
- **公开合同**：`/v1/models` 已公开的 `xai/grok-imagine-video*` alias 现在可由 `allow_custom_model` key 直接调用，普通 key 仍在付费 reservation 前拒绝。新 fast image 与 prompt-only video 只接受已证明的 `model + prompt`；合并前已有的 quality image、single-image video 和 reference-video 合同保持兼容，不从一次默认 canary 外推细粒度付费能力。
- **视频终态**：共享 Zod response schema、provider 客户端和 gateway poll 边界共同要求非空 `status`，且 `done` 必须带非空 `video.url`；畸形完成响应返回 502，不写入 durable terminal state。
- **限制**：紧急 latch 是进程内状态；quota Store 完全不可写且进程在下一次成功刷新前重启时，无法把该瞬时失败跨进程持久化。正常失败路径会优先写 tombstone，因此不新增 migration、配置项或依赖。

## 2026-08-18 · Grok.com Imagine 复用 OAuth 媒体链并以短期 billing 证据授权（OAuth / Images / Videos，Phase 1 spec §4–9，原则 2/3/6/7）

- **账号资格**：不新增 entitlement 表；复用 SQLite/Postgres 已持久化的 xAI 周 billing snapshot。媒体正向授权必须同时满足“24 小时内的新鲜周 billing”与“当前 OAuth JWT 是明确的已知付费 tier”，opaque、缺失、未知、`free`、`x_basic` 均 fail-closed；有效期取 `capturedAt + 24h` 与周窗口 reset 的较早者。普通 Grok 文本模型不读取此媒体 gate。
- **动态撤权与混合账号池**：每个媒体模型把 `validUntilMs` 带进账号池，选择、图片/视频 resolver 和 `/v1/models` 都按实时 clock 重评估，无需重启或定时 sweep；只指向已失效 OAuth leaf 的媒体 lane 也同步从 discovery 隐藏。OAuth 完成后异步拉取 xAI billing；空结果或失败会删除旧快照并重建。若删除失败，即使普通 rebuild 成功也立即摘除全部 live xAI 媒体 alias，避免旧行重新授权；单账号失败不遮蔽其他有新鲜证据的账号。
- **媒体合同**：图片继续使用原 `/v1/images/generations` 与单写保护，只给 Grok 快速/质量模型增加严格的 `n=1..4`、六种宽高比合同，并把空数组、空字符串或纯空白图片载体视为 `outcome_unknown`；其他图片 provider 保持宽松 OpenAI 兼容合同。纯文字视频复用原 `/v1/videos/generations`、任务 registry 与固定账号 poll，不新增文字转图片的两步 workflow。
- **真实 canary 与运行边界**：用户批准的本机 canary 恰好执行一次默认 fast 图片 create 和一次默认 prompt-only 视频 create，均未重试；图片得到 1 个非空结果，视频取得 receipt 后由原账号 6 次 GET 轮询到 `done` 和非空结果。候选镜像 `sha256:2940600c…`、`/version` dirty SHA、entitlement、serving account、registry、telemetry 与普通日志脱敏回读一致，旧 v0.28.74 容器保留为停止态回滚点。宿主 Playwright 因真实 `response_work_capacity_exhausted` 保护无法解析 mock 响应，未削弱生产保护；同一 `videos.spec.ts` 在 Docker builder 中 2/2 通过。现有 recovery key 没有低 cap，因此完整 Go 门禁仍未满足。
- **可重复 live smoke**：新增默认跳过的 `apps/gateway/src/live-grok-imagine.test.ts`，必须同时提供 loopback Helm 地址、环境变量 key 与 `I_ACCEPT_EXACTLY_2_MEDIA_CREATES` 才会执行；每次只发 1 次默认图片 create 和 1 次纯文字视频 create，POST 无重试，视频只做有界同 receipt GET poll，测试输出不包含 key、prompt、receipt、正文或签名 URL。用户同日明确要求的实跑为 2/2 通过：图片结果可读；视频一次接受后经 5 次只读 poll 到 `done`，且结果字节可读取。
- **完整 CI 本机复刻**：在不再调用付费媒体接口的前提下，以 Docker 隔离环境逐项复刻 `.github/workflows/ci.yml`：typecheck、lint、build 通过；fast suite 355/355 文件、6417/6417 用例通过；Store suite 60/60 文件、650/650 用例通过；真实 PostgreSQL 合约与完整 Playwright e2e 95/95 通过；正式多阶段镜像 `sha256:fbfa07f3…` 的 `/healthz` 回读 `ready:true`，`/version` 回读 `0.28.74` 与非 `unknown` Git SHA。最初的缺 `.github`、root 权限、OpenSSL 和容器内 Docker 都是本地测试壳与 GitHub Ubuntu runner 的环境差异，补齐同等前置条件后均全绿；临时数据库、网络、浏览器缓存和 smoke 容器已清理，现有 `helm` 候选容器未受影响。
- **交付边界**：正式 PR #761 已创建；实现提交 `29ff7655` 的托管 GitHub Actions run `32142663949` 已回读 `verify`、`store`、`e2e`、`docker` 与四个稳定 required checks 全部成功。本轮不合并或部署；P1 细粒度媒体选项、低 cap key 前置条件与“关闭新能力但保留已接受视频 poll”的回滚门禁仍未完成，因此整体发布 Go 门禁仍是 No-Go。
- **剩余限制**：当前只有账号级媒体开关；默认 fast 图片已经真实验证，但仍没有可靠的上游细粒度 entitlement 分别证明 quality、数量、宽高比、6/10/15s、480p/720p/1080p 或 audio 对该套餐都可用。这些 P1 选项继续保持关闭/未完成，不能从一次默认 canary 外推。

## 2026-08-15 · 自动 Memory 形成必须挂在项目或资源下（Memory Observer / Reflector / Store，docs/08/12，原则 3/7）

- **根因与修复**：历史 quarantine thread 没有项目/资源；decay 归档 observation 时把它回退成 thread-only Reflector scope，随后生成 Admin「按范围」里没有父级的 active reflection。请求 observe writeback 与 eager fact 路径也允许相同的孤立范围。现在入站/出站观察在缺少项目和资源时直接 fail-open 跳过，eager extraction 不调用模型，Reflector 对已持久化的孤立 job 在任何读写前标记失败。
- **遗忘与兼容**：SQLite/Postgres 仍会软归档历史孤立 observation，但不再排 thread-only rebuild；正常 project/resource rebuild 与直接管理的历史数据格式不变，无 schema/migration 或新依赖。现有孤立 active facts/reflections 不由升级代码猜测删除，需按运维范围显式清理。

## 历史条目摘要（最新要点）

- **2026-08-15 · 请求级正文模式成为历史读取权威**：新 telemetry 保存实际有效正文模式，Admin 据此拒绝读取明确 `none` 的孤立正文，并用单 revision 大小判断浏览器恢复能力；完整原文经 git history 回溯。
- **2026-08-15 · 大型完整载荷改由浏览器解压与恢复图片**：Admin 优先读取 gzip/raw 存储态正文并由浏览器解压，外置图片按 `sha256` 经鉴权端点恢复，避免网关内存化放大；完整原文经 git history 回溯。
- **2026-08-13 · OAuth 永久失效只认明确凭证拒绝**：仅标准 `invalid_grant`、Copilot mint 401 与 Codex refresh 身份变化永久摘除账号，裸 refresh 403 只短暂冷却；完整原文经 git history 回溯。
- **2026-08-13 · Grok 4.6 补齐 Agent 能力、价格与 lane 投影**：手工 catalog 补齐已验证的 tools/SSE/常用 reasoning 与 API 等价估价，subscription vision/JSON/xhigh 继续 fail-closed；完整原文经 git history 回溯。
- **2026-08-13 · 使用率下降观测不得冒充精确重置**：deadline 未变化时的使用率下降只形成 `approximate=true` 事实，精确 header/reset-credit 继续优先；完整原文经 git history 回溯。
- **2026-08-13 · 历史配额周期使用公开公告补齐近似边界**：公开公告只能形成 `approximate=true` 的历史 reset facts，精确 header/reset-credit 继续优先且实时 bucket 不受影响；完整原文经 git history 回溯。
- **2026-08-11 · Admin Memory 范围分页与 Key 点查**：scopes 使用稳定服务端分页，首屏只加载轻量数据，Key 深链走不可变 id 索引点查；完整原文经 git history 回溯。
- **2026-08-11 · Memory 大线程有界形成与遗忘原子性**：Observer/Reflector/cleanup 改为有界分页、frontier/fence 与原子提交，避免超大线程 OOM、遗忘后复活和 stale counter 漂移；完整原文经 git history 回溯。
- **2026-08-10 · 配额统计按真实重置点切分**：PULL、Codex header 与 reset-credit 共用真实周期边界，晚到采样不写伪 reset；旧整点历史不可逆并继续标记为近似/部分数据，完整原文经 git history 回溯。
- **2026-08-10 · 大 Session 客户端重建按记录时间展示并提前停止分页**：目标 revision 到达即停，按 `createdAt`/`sequence` 展示持久化增量请求与响应快照；Session 仍为 `exact=false` 且不可精确 Retry，完整原文经 git history 回溯。
- **2026-08-08 · Grok Imagine 仅复用 SuperGrok OAuth 媒体链路**：媒体执行复用 xAI 订阅 OAuth，付费 POST 单写且不跨账号重试，未知价格对美元预算 fail-closed；完整原文经 git history 回溯。
- **2026-08-08 · 会话转录客户端重建，绕开服务端内存阀**：长 Session 以 4 MiB/100 行游标分页传给浏览器本地重建，小 Session 保留服务端快路径；共享纯重建函数留在浏览器安全的 `@helm/shared`，完整原文经 git history 回溯。
- **2026-08-07 · 真上游上下文溢出短路直返 400**：确定性上游 400/413/422 上下文溢出立即返回客户端并保留原始错误；预检估算仍允许 fallback，可重试状态不误判为客户端错误，完整原文经 git history 回溯。
- **2026-08-07 · Codex 配额富元数据持久化**：`oauth_quota.metadata` 保存 plan/credits/limits，冷缓存读取 durable metadata；限流账号上游缺富数据时待窗口重置后自愈，完整原文经 git history 回溯。
- **2026-08-07 · generic Responses 剥离 Anthropic `context_management`**：翻译与同协议 passthrough 都在 generic profile 边界删除不兼容字段，Codex official 保留；完整原文经 git history 回溯。
- **2026-08-07 · OAuth 账号限流后继续用剩余点数**：每账号开关只绕过 usage-limit park，model-scoped 与 transient 冷却保持不变；完整原文经 git history 回溯。
- **2026-08-07 · per-key `max_reasoning_effort` 上限**：统一三协议身份 caps 映射，避免内联副本漂移导致上限静默失效，完整原文经 git history 回溯。
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
