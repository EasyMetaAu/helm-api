# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-07-22 · Session 恢复补齐响应快照并限制默认留存范围（Telemetry / Admin requests，docs/07/11，原则 1/3/7/8）

- **复用既有存储**：`session_revisions.response_json` 已为 OpenAI Responses continuation 保存带 `output` 的终态对象，指定线上记录也已证实响应存在；本次不新增表、列或迁移。Admin 的 Session fallback 改为从目标 revision 返回响应，`meta`、完整正文和 `part=response` 三种读取保持 payload 优先，Session 来源始终标记 `exact=false`，因此 Retry 继续禁用。
- **协议与流式边界**：OpenAI Chat、Anthropic Messages、Gemini 和 Responses 的成功非流式请求都保存客户端协议形态的响应快照；Chat 会在 response-model policy 生效后再保存，避免记录值与客户端看到的模型名不同。Responses 成功流继续只保存 terminal response object，保持 `previous_response_id` 展开所需的 `{ output: [...] }` 语义。Chat、Anthropic 与 Gemini 流不为 Session 新增整段 SSE 缓冲；在没有独立有界 accumulator 与 partial fidelity 前，响应保持不可用，避免默认开启的 Session capture 形成并发内存放大或把截断内容误报为完整响应。
- **容量与隐私边界**：单个 Session response snapshot 以 UTF-8 计限制为 16 MiB；超过上限或会让 Session 超过 64 MiB 时只省略响应，仍保留请求 revision，并记录 `session.response_limited`。设置页、七种语言、README 与 docs 明确披露 Session 模式会保存可用的模型响应，可能包含工具参数、reasoning 与媒体；Session 仍按最后活动时间整组清理、不归档，并与完整 payload 共用内容留存窗口。

## 2026-07-22 · 按会话增量保存请求正文并诚实区分恢复保真度（Telemetry / Admin requests / Store，docs/07/11，原则 1/3/7/8）

- **互斥留存模式**：运行时新增 `capture_sessions`，与既有 `capture_payloads` 组成「仅元数据 / 每请求完整载荷 / 按会话增量转录」三种互斥模式；新安装默认按 Session 增量保存，完整载荷默认关闭。两项同时为 `true` 时配置校验 fail-closed；旧实例若明确保存过 `capture_payloads`，缺少新字段时保持原选择，设置损坏时的隐私安全回退会同时关闭两种正文捕获。本次目标 Remote 在部署时显式切换为 Session 模式，不用升级逻辑覆盖其他自托管 operator 的隐私选择。
- **身份与隐私边界**：只从客户端入口解析高置信信号：`x-thread-id`、两个明确 metadata 字段、`x-session-key`、Codex 入站 `thread-id` / `session-id`，以及严格 JSON object 形式的 Claude Code `metadata.user_id.session_id`；不读取 Helm 注入上游的 provider/OAuth 身份。ID 限制 256 UTF-8 字节并按 account、API key、来源和原值生成不可猜测 `session_ref`。原始 Session ID 仅写入受正文留存策略控制的 Session 表，写 telemetry 前剥离 `label`；Admin 列表用批量 Session 查询回填显示值，避免每页 N+1 与正文关闭时的 PII 泄漏。
- **存储与并发边界**：SQLite/Postgres 使用 Session head + 单调 sequence + 不可变 revision，按最长公共前缀只保存新增 request suffix，显式 parent 保留编辑/并发分支；重复 request 只允许在原 response 为空时回填一次，新增 UTF-8 字节计入 `stored_bytes` 并在同一事务内执行上限，已有 response 的后续重写为 no-op。写入进入受字节预算保护的异步 Session lane，request 与 Responses output 都计入队列预算，优先牺牲完整 payload、保留脱敏 telemetry；Store 原子执行 10,000 revisions / 64 MiB 上限。常规追加使用 1,000 项且总计不超过 64 MiB 的 byte-bounded LRU，关闭 Session capture 时立即失效；恢复采用迭代父链、拒绝 cycle、负数/小数 `retain_count` 与非数组 delta，损坏记录不会静默生成错误请求。
- **Responses 续接与保真边界**：普通多轮请求只存客户端 request 增量；OpenAI Responses 为展开 `previous_response_id` 的隐藏状态，额外保存产生该 ID 的规范 response output，并以 Session 内唯一 `response_id → request_id` 建真实父边。chain、fork 与并发分支因此不会误借最新 head；恢复按「父请求 input + 父 response output + 当前 input」展开，保留 reasoning/tool-call items、删除已展开的 opaque ID，且当前顶层 instructions 不继承旧值。找不到父 response 的 revision 会以 `partial` 留痕，但恢复必须 fail-closed 为 `session_incomplete`；父 ID 不匹配、continuation 的 `retain_count` 非零、response output 缺失或损坏同样拒绝恢复，不猜测历史。
- **清理与运维边界**：Session 恢复是语义等价 JSON，不保留原始空白、headers 或翻译后的 upstream body；完整 payload 仍是唯一可精确 Retry 的来源，Admin 明示 `source=session`、`exact=false` 并禁用 Retry。Session 是 cleanup 报告中的独立 action，但 MVP 与完整 payload 共用 `payloads_cleanup_enabled` / `payload_retention_days` 这组“内容留存”设置；payload 可归档，Session 不归档并在最后活动超过窗口后整组删除。列表 Session 可一键切到 `range=all` 的 opaque-ref 筛选；恢复失败明确区分无 Session ID、转录不可用/已清理、转录链损坏。

## 2026-07-22 · Lanes 批量保存、拖拽回退与可配置默认通道删除边界（Routing / Admin lanes，docs/03/04/11，原则 2/3/5/6）

- **整组写入**：Lanes 页面不再由每张卡分别 PUT；所有编辑、fallback 顺序和待删除 lane 由一个底部保存按钮通过 `PUT /admin/api/lanes` 一次提交，Gateway 用共享 `LanesConfigSchema` 校验完整 map 后原子写回 `lanes.yaml` 并热更新，失败时整组不落盘。单 lane API 保留兼容，不新增依赖。
- **排序与删除**：fallback 的上下按钮改为复用 Policies 页交互语义的拖拽手柄，并保留方向键排序；每张 lane 卡提供删除按钮，删除先进入页面工作集，统一保存时才持久化。页面从 runtime settings 读取当前 `default_lane`，只保护当前默认 lane，不把 `balanced` 写死。
- **配置边界修正**：`LanesConfigSchema` 改为要求至少一个有效 lane；`runtime.default_lane` 与 lane 集合的交叉约束在 Gateway 边界及启动组合层 fail-closed 校验。因而用户先把默认通道改成其他 lane 后可删除 `balanced`；Settings 选项与默认配置说明也不再把 `balanced` 当作强制终点。若手工配置令默认通道不存在，Gateway 拒绝启动；Resolver 仍对异常调用防御性地回退到存在的 `balanced` 或第一个 lane。

## 2026-07-22 · Responses 状态续接严格绑定原 provider 与账号（Protocol translation / provider execution，docs/04/05/07，原则 2/3/5/8）

- **状态引用边界**：`previous_response_id` 引用的是上游保存、Helm 无法从当前增量请求重建的隐藏历史。Responses create 入口复用既有 lifecycle registry，按同一 account/key 查出产生该 ID 的 provider alias；未知 ID、registry 不可用、或由非 Responses 翻译路径生成的 ID 在路由前返回 `400 invalid_request`，要求客户端发送完整 conversation input，不猜测也不静默丢历史。
- **路由与协议边界**：可信 provider pin 只作为 Gateway 内部 metadata 进入共享执行器；候选不等于原 alias 时记录 `responses_previous_response_id_provider_mismatch` 并跳过，任何非 Responses 候选统一记录 `responses_previous_response_id_cross_protocol_blocked`。无状态首请求仍保留原有跨协议 fallback，只有有状态 continuation 被收紧。
- **账号绑定边界**：OAuth pool 同时收到 WebSocket session 与 `previous_response_id` 时以后者优先，复用现有 response-id → account affinity，使续接在原账号不可用或首输出前故障时直接失败，不切换兄弟账号。没有新增存储、配置、依赖或客户端协议。

## 2026-07-22 · Codex 客户端默认启用 Responses WebSocket，并补齐反向代理边界（Deployment / Protocol / Admin client setup，docs/05/10/11，原则 3/5/8）

- **客户端契约**：Admin「接入客户端」现有 Codex TOML 直接增加 `supports_websockets = true`，复用 Helm 已实现的三个 Responses WebSocket 入口及 Codex 自身的 HTTP fallback；不新增 Gateway 路由、媒体服务、客户端 npm shim 或缓存层。该优化只减少同一 Codex turn 内后续模型调用的重复 input，跨 turn 首次请求仍会发送完整历史。
- **部署边界**：WebSocket 可用性取决于整条反向代理链，不是 Gateway 代码存在即代表现网可用。nginx 只在真实 Upgrade 请求上转发 `Upgrade` / `Connection`，普通 HTTP/SSE 不注入 hop-by-hop header；若前置 HAProxy 另有 catch-all WebSocket backend，必须先按 Helm hostname 路由到 web backend，避免 Upgrade 在到达 nginx 前被截走。
- **延后项**：Claude Code 没有可依赖的图片 URL / `file_id` 客户端契约，因此暂不建设本地 npm shim；不可变媒体引用留待自有客户端或明确协议需求出现后再做。

## 2026-07-21 · 首次安装改为令牌保护的浏览器向导并允许订阅-only 启动（Deployment / bootstrap / Admin，docs/10/11，原则 2/3/7）

- **Admin 登录体验**：浏览器不再依赖 `WWW-Authenticate` 触发原生 Basic 弹窗；未登录页面跳转到 Gateway 自带的 `/admin/login`，成功后使用仅含过期时间与 HMAC 的 12 小时 `HttpOnly`、`SameSite=Strict`、`Path=/admin` Cookie，HTTPS 时加 `Secure`。签名密钥只由进程内现有 Admin 用户名/密码派生，凭据轮换自动让旧会话失效，不新增 session 表、JWT 依赖或独立 secret。Admin SPA 与静态资产仍在会话/Basic 双重认证之后，只有无脚本登录 HTML 公开；脚本可继续主动发送 HTTP Basic，失败响应不再带 challenge，避免浏览器弹窗。登录 POST 校验同源、常量时间比较并限制本地 `next`，顶栏提供退出入口。
- **安全状态机**：缺少完整 Admin 凭据时，只挂载 `/setup`、`/healthz`、`/version`；推理、Admin、Portal 与文档均不暴露。随机 256-bit setup token 写入 `0600` 文件并嵌入脚本/日志打印的 URL fragment，由页面自动读取且不再要求用户填写，既避免公网首访者抢占，也不把安全机制变成新手表单。完成后同一进程切换完整 Gateway 并一次性显示自动创建的管理员 API Token，不要求重启；脚本/无人值守部署可直接提供环境变量，显式 `HELM_ADMIN_ENABLED=false` 或 `HELM_SETUP_DISABLED=1` 保留 headless 行为。
- **凭据与边界**：向导可对静态 Provider 发起一次 1-token 真实请求，只有测试通过的新增 key 才可保存；也允许零静态 key 完成。默认只展开 OpenRouter 与 DeepSeek 并提供官方注册入口，其他静态 Provider 收进可选折叠区；订阅绑定直接复用既有 Admin Providers 页面，不复制 OAuth 流程。Admin、自动生成的 OAuth encryption key 与静态 key 原子写入 `data/helm-managed-env.json`（`0600`），外部非空环境变量优先。该文件等同数据卷内私有 `.env`，没有把同盘密钥与密文包装成虚假的整盘泄露防护；不得记录、回显或写入数据库。零可用 Provider 时服务保持健康，推理明确返回 `503 lane_unavailable`，真实上游全部失败仍是 `502 all_providers_failed`。
- **两种安装方式与 Linux 实测**：`quickstart.sh` 默认只写端口/UID/GID 后进入浏览器向导，`--cli` 保留终端自动配置；`pnpm start` 使用 Node 22 原生 env-file，无新增依赖。Compose 的 `.env` 为可选，`HELM_PORT` 统一控制宿主、容器监听和 healthcheck；脚本按安装者 UID/GID 运行非 root 容器，SQLite 自动创建缺失数据目录。Ubuntu x86_64 上已验证 Docker build、无 `.env` 启动、OAuth-only 完成、Admin/Models、`0600`、重启持久化、19096→19097 端口切换与 8080 关闭。

## 2026-07-21 · Grok Build 复用 OpenAI 模型发现接入 Helm（Admin client setup，docs/05/11，原则 2/5/6）

- **官方契约**：以 `xai-org/grok-build@a881e67` 的 Custom Models 指南为准，Grok Build 设置 `GROK_MODELS_BASE_URL` 后从 `{base_url}/models` 发现模型，以 `XAI_API_KEY` 作为 Bearer key，并默认走 OpenAI Chat Completions。Admin「接入客户端」因此只新增可复制的 `GROK_MODELS_BASE_URL=<origin>/v1`、Helm key 与 `grok -m auto` 引导；`/v1/models` 继续按 key 暴露 `auto` / lanes，推理由既有 `/v1/chat/completions` 路由处理。
- **最小边界**：不新增 Grok 专用 Gateway 路由、协议适配、依赖或运行时配置，也不要求 `grok login`；只扩展现有 Admin 对话框、七种现有语言文案与一个定向组件测试。

## 2026-07-20 · `end_turn` XML 泄漏只按终态工具调用恢复（Protocol streaming / provider execution，docs/05/07，原则 3/5/8）

- **恢复边界**：本机 2,520 个 Claude session JSONL 的匿名化扫描中，高置信完整泄漏有 85 个 `tool_use` 与 23 个 `end_turn`；后者是当前真实漏项。保留既有 `tool_use` 的宽松周边文本恢复；仅对 `end_turn` 增加收紧路径。共享 parser 只有在所有完整 invoke 都精确命中请求声明的工具、最后一个非空 segment 是已恢复的 tool、文本 segment 不含残留 `<invoke`，且 invoke 不在 Markdown 三反引号 fence 内时才接受；多个调用之间仅允许空白，避免把前置的无围栏 XML 示例一并执行。末尾空白可保留；无名、未闭合、未知尾巴、function-calls wrapper 和带转义引号的文档示例都不扩 grammar、不恢复。
- **四出口一致性**：native Anthropic JSON/SSE 与 OpenAI→Anthropic translation JSON/SSE 都只在末个 terminal text 上调用该收紧路径，且没有既有 structured call 才可恢复；成功后分别将终态改为 `tool_use` / `tool_calls`。Translation SSE 与 JSON 复用同一份声明工具名映射，保证点号、碰撞等名称规范化一致。SSE 仍在 `message_delta` 证明终态后才改写，普通 `tool_use` 与非候选路径保持既有行为。
- **验证**：TDD 先在共享 parser 和四个出口加入失败 case，再以 4 个定向 Vitest 文件、257 个用例覆盖完整 end-turn 恢复及拒绝 fence、尾随文本、调用间 prose、未闭合和未知 invoke；`pnpm typecheck`、`pnpm lint`、`pnpm build` 与 `git diff --check` 通过，不新增依赖或运行时配置。

## 2026-07-18 · 请求推理等级与实际路由等级分开展示（Telemetry / Admin requests，docs/07/11，原则 1/7）

- **事实边界**：`requested_reasoning_effort` 在进入路由、策略或 lane 覆盖前从客户端请求单独截取；既有 `reasoning_effort` 继续表示覆盖后的有效执行等级。两者都是不含正文与密钥的可选 `DecisionRecord` 元数据，因此关闭 `capture_payloads` 后仍可读取，旧记录缺少请求等级时保持空白，不用有效等级反推客户端意图。
- **列表展示**：共享 `RequestsTable` 在“请求”模型后直接追加客户端等级（例如 `请求: gpt-5.6-sol high`），Routing 单元格只显示实际有效等级值，不再重复“推理等级”标签。Dashboard、主 Requests 与 key-scoped 列表共用该行为；请求详情现有的有效等级展示不变。

## 2026-07-18 · 关闭正文捕获时仍保留推理等级（Telemetry / Admin requests，docs/07/11，原则 1/7）

- **存储边界**：`capture_payloads:false` 仍只禁止 `request_payloads` 中的完整请求、上游请求与响应正文；请求实际生效的 `reasoning_effort` 作为不含正文和密钥的独立字段写入既有 `DecisionRecord`，随 `decision_json` 持久化。策略或 lane 强制覆盖时记录覆盖后的有效值；请求未指定时记录 `null`，旧记录缺字段继续兼容，不新增 SQLite/Postgres 列或迁移。
- **展示边界**：Admin 请求详情在正文未捕获时，通过既有脱敏 request metadata 面板展示 `reasoning_effort`；完整正文开启时仍以原始 payload 为事实来源。OpenAI Chat、Anthropic、Responses、Gemini 的共享路由链自动覆盖，`/v1/responses/compact` 的独立遥测构造也显式投影 `reasoning.effort`。
- **列表投影**：共享 `RequestsTable` 的 Routing 单元格同步展示已记录的有效推理等级，因此主 Requests 列表、Dashboard recent 与 key-scoped 列表保持一致；旧记录缺字段时不渲染占位行。

## 2026-07-18 · Codex 自动压缩目录与无状态传输故障切换（OAuth subscription / Responses / provider execution，docs/04/05/07，原则 3/5/7/8）

- **压缩职责边界**：Codex 客户端拥有当前会话历史并负责在阈值到达时调用 `/v1/responses/compact`、用摘要更新本地 transcript 后重试；Gateway 不透明改写历史，也不把 auto-compact 触发点误当成模型硬输入上限。当前 Codex core 对缺失 `auto_compact_token_limit` 按 resolved context（`context_window`，缺失时回退 `max_context_window`）的 90% 推导，并把上游显式阈值钳制到该上限，因此 Helm 的 key-filtered `/v1/models?client_version=...` 物化相同的有效值（372K → 334,800）。真正超过模型 context 的整链耗尽继续复用既有 compaction-compatible `400 invalid_request`，而不是在 90% 处提前拒绝仍可执行的请求。
- **传输故障边界**：Codex fetch 在同账号短连接重试耗尽后，将原始 `TypeError: fetch failed` 归类为无 HTTP status 的 `UpstreamError`，并在脱敏后的 `provider_raw` 保留有界嵌套 `name/code/message`（例如 `UND_ERR_SOCKET`），使 OAuth pool 能对无状态请求尝试兄弟账号。客户端 abort 与显式 provider timeout 保持原分类；带 `previous_response_id` 或已知 `x-codex-turn-state` 的有状态 continuation 仍严格绑定原账号，不能跨账号重放。
- **fallback 协议边界**：含 native/custom/caller-linked 或未知 Responses input sequence 的请求，只能交给 `codex_responses` profile；`generic_openai_responses` provider 在调用前按能力 profile 跳过，避免把 Codex 私有 items 发给 xAI 等兼容端点后得到确定性 422。判断不依赖 provider 名字，后续新增 generic provider 自动继承相同保护。

## 历史条目摘要（最新要点）

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

2026-07-07–09 压缩条目包括 self-service portal 完整实现与多语言、视觉压缩后的 cache-control 收敛和 Anthropic 兼容路径 CCH 稳定化。

2026-07-06 压缩条目还包括 Anthropic native passthrough 稳定 Claude Code billing `cch`、Admin 模型搜索预计算列、payload 分段懒加载、纯工具 turn 去空 header/默认展开，以及 Claude Code 风格 inline tool peek。2026-07-04 更早条目还包括 cheap-model 当前轮低风险降级、视觉上下文压缩 observe/off 接入、Memory stats 队列索引优化、OAuth 会话亲和调度、idle-flush 碎片段优先压缩最大连续段、memory worker 受控并发追赶、记忆页只读运行状态面板、Claude scoped weekly quota 只影响对应模型、跨协议 reasoning-history 候选级跳过、memory idle-flush 防饥饿、策略级 reasoning_effort 覆盖 lane 默认值、cron monitor 低成本规则等。2026-06-30 及以前的工作主要围绕 Helm API 的协议面、路由执行、admin 可观测性与自托管部署逐步成型：补齐 Gemini/OpenAI/Anthropic/Responses 双向转换、SSE 流式正确性、tool-call/JSON schema/思考参数保真、per-model reasoning effort、模型别名与能力/成本目录、provider fallback 与熔断语义、OAuth subscription providers、多账户池与 quota 处理、memory observe/inject/forgetting/admin/MCP、请求 payload 捕获与 request detail UI、API key 治理、admin 表格/过滤/分页/i18n、Docker/CI/release/deploy 验证，以及早期 Phase 0 的 Hono + SvelteKit static admin + Store 端口 + SQLite/Supabase 架构决策。更早细节不再逐条保留在本文件；需要精确背景时回查 git history。
