# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-09-21 · Codex 工具历史恢复声明中的 namespace（Provider / 协议互译，docs/05）

- **证据**：生产请求 `6422fb44-043b-4f5e-a07a-ea124cc4e94b` 的原始 `input[492]` 是 `function_call`，`name=mcp__cua_repl::js`，没有 namespace；OpenAI 拒绝 name 中的冒号。相同请求内已声明 `mcp__cua_repl` namespace 下的 `js`，早期调用也使用拆分字段。
- **处理**：复用 Codex 原生请求 sanitizer，仅把能精确匹配当前工具声明的 `namespace::name` 拆回两个字段。支持顶层 tools 和 Lite additional_tools；保留参数、call_id、输出和 item ID，不原地修改客户端历史。记录 `qualified_function_names_normalized` mutation。
- **边界**：仅修复 function_call；未声明、namespace 冲突或其他非法名字仍交给原有校验拒绝，不猜测工具身份。generic Responses 透传不改。无需改库；本地验证不代表生产部署。

## 2026-09-20 · DeepSeek 缺失思考历史降级与管理端原生重放（Provider / Admin，docs/05）

- **已确认的缺口**：工具历史完全没有 reasoning item 时，旧保护未关闭 DeepSeek 思考；管理端 Retry 丢失原生 Responses carrier，经 IR 往返会丢掉 reasoning/custom tool 历史，已实测触发 reasoning_text 400。
- **修复**：复用原有请求合同，将「有工具历史但无 reasoning」纳入 `reasoning.effort: none`；有明文的完整 reasoning 历史继续保留原设置，不编造思考。Responses Retry 复用 live route 的 carrier helper，保留原始 body，headers 为空，不转发管理端鉴权。
- **验证与限制**：三项回归先红后绿，相关两文件共 284 测试通过，core/gateway 类型检查通过；真实 DeepSeek 接受无 reasoning 工具历史配合 effort none。原失败 `a374e50b` 的原生请求当前经公开网关重放成功（`b5b2de1c`，单 token 上限），因此本次补齐两个已证实缺口，不把它们断言为该历史失败的根因。

## 2026-09-19 · DeepSeek 工具图片保留结构并压缩（Provider / 协议互译，docs/05，原则 8）

- **根因与修复**：Codex `exec` 的工具结果包含 `input_image` 数组，旧的 custom → function 转换把整个数组 JSON 字符串化，使图片 Base64 被当成文本计入上下文。保留字符串或内容数组；其他旧式对象仍按原逻辑序列化。[DeepSeek 官方 Responses 文档](https://api-docs.deepseek.com/guides/responses_api)明确支持工具结果中的图片数组。
- **压缩与边界**：DeepSeek 合同发送前复用现有图片优化器：最长边 2048、WebP quality 82，仅采用比原图更小的结果；不改调用方原始图片，不下载外部 URL。沿用内存准入、取消信号、单图 1600 万像素、每请求 12 张/累计 3200 万像素上限；超限、资源不足或解码失败保留原图。压缩是有界尽力优化，结构修复始终生效。其他 provider 不启用此处理。
- **验证范围**：流式/非流式回归先红后绿，覆盖图片结构、压缩、原数据保留和普通 Responses 客户端隔离；未将本地验证当成生产部署或真实上游验收。

## 2026-09-19 · 分类器支持 Jev → 聊天模型的有序回退（Classifier，docs/03）

- **配置与兼容**：新增可选 `eval.chain`，逐项配置类型、模型/通道、超时和最低置信度；未配置时保留旧 `eval.model` 行为。分类器页面可添加、排序、删除候选，保存后热更新并清空旧配置缓存，不默认替生产启用 Jev。
- **回退与时间预算**：Jev 错误、超时、无效结果或置信度不足，继续下一分类器；单项超时受整条链 `outer_timeout_ms` 的剩余预算约束。全部失败才进入 `runtime.default_lane`，模型执行层的回退仍独立。
- **Jev 协议**：使用 OpenRouter Decisions 接口和既有 provider 环境凭证；只发送分类缓存使用的五项输入，排除系统提示词、完整历史和账号信息。该接口不支持聊天接口的 temperature/max_tokens，因而不发送这些字段；聊天候选仍保持原有约束。返回分类严格校验，两项 confidence 取较低者。
- **限制**：Jev 请求体保守限制为 32,000 UTF-8 字节，超限继续备用分类器；0.6 是可调整的起始阈值，未声称已通过中文准确率校准。只缓存通过验收的结果和实际模型；已知费用累加，任何一次计费未知则总费用记为未知，避免少报。

## 2026-09-18 · Codex 短冷却等原账号，长冷却原样回错误（Provider / OAuth 池，docs/04，原则 3/5）

- **现象**：`90aa083d` 带 `x-codex-turn-state`，原账号短暂停用约 28s。Helm 立刻抛 `response_create_not_sent`，WebSocket 桥还可能把它改成 1012。Codex 不读 `recovery.retry_after_ms`，12s 连打 6 次。
- **修复**：≤60s 的 sticky 冷却在原请求上等到点，再打原来的 Codex 账号；不换号、不换 DeepSeek。超过 60s 立刻失败，错误码/文案/`recovery`（含 `reason` 与 `retry_after_ms`）原样给客户端。长冷却不再改成 1012。客户端断连仍不算 provider 故障。
- **不改**：lane rung；不把错误改成假的 `rate_limit_exceeded`。

## 2026-09-18 · DeepSeek 丢掉无配对的 function_call_output（Provider / 协议互译，docs/05，原则 3/8）

- **现象**：`776fa8e7` 先打 `gpt-5.6-sol` 上游过载，落到 `deepseek-flash` 后 400：`No tool call found for tool output with call_id fco_01a0a7f2-…`。历史第 7 项是 Codex `automation_update` / `codex_app` 的 `function_call_output`，有 `id` 无 `call_id`，也没有对应的 `function_call`。v0.29.27 用 `id` 填 `call_id` 后，DeepSeek 仍要配对的 call。
- **修复**：`deepseek-responses` 增加 opt-in `dropUnpairedFunctionCallOutputs`，在填 `call_id` 之后丢掉没有 sibling `function_call`/`custom_tool_call` 的 output。配对的工具结果不动。不发明 call，不改 rung。第一条候选的 Codex 过载仍是上游故障。

## 2026-09-18 · 断开 OAuth 账号撤销缓存凭证并阻止刷新写回（Auth / Provider，docs/06、04、05）

- **已复现**：后台断开只删 Store 行，旧 token manager 仍能返回缓存 access token；并发刷新完成后会重新 upsert 该行。pool 重建失败时旧成员也仍可选择。另有流式已输出后出现确定性鉴权失败却未禁用账号的缺口。
- **修复**：删除与刷新复用同一 store/account 锁，删除成功后撤销旧 manager 的内存凭证使用权；管理端同步禁用 live pool 成员并丢弃复用缓存，不依赖后续重建成功。重新登录创建新 manager，旧 manager 永不复活，其断开错误也不会把新登录标为凭证失效。流式已提交后只禁用确定性失效账号并上抛原错误，禁止重放。
- **边界**：锁与缓存失效作用于同一网关进程共享的 Store；不承诺跨进程直接删库的一致性，也不撤回已经发送的上游请求。退出会等待已经开始的刷新完成后再删除；删除提交是退出生效点，重新登录的保证从退出完成后开始。删除失败不撤销现有凭证。普通 403、限流、5xx 与客户端断连不因此永久禁用。
- **证据范围**：回归测试先红后绿；这些代码缺陷已证实，但不能据此断言它们造成了本次截图中另一个账号的 429 冷却。尚未部署。

## 2026-09-18 · 补 grok 兼容别名：版本化 chat id 进 grok lane，Imagine/video 不抢（Config / 路由，docs/04，原则 6）

- **现象**：`bbcd8800` 自定义模型 key 发 `grok-4.6`，400 `unknown model or lane "grok-4.6"`。`grok` lane 已有（primary `xai/grok-4.6`），但 `model-aliases.yaml` 没有 grok glob，版本化 id 既不是 lane 名也不是 provider alias。
- **修复**：`grok-imagine-image*` → `grok-imagine-image-quality`；`grok-imagine-video-1.5*` → `grok-imagine-video-1.5-preview`（grok-build 当前 wire id，兼容 preview 后缀）；`grok-imagine-video*` → 纯文本/续写 lane；最后 `grok*` → `grok`。最长字面量优先。不把 1.5-preview 并进无版本 `grok-imagine-video`（那是另一份合同）。不钉 chat 版本，不改 rung。

## 2026-09-18 · DeepSeek 回放前补上缺的 function_call_output.call_id（Provider / 协议互译，docs/05，原则 3/8）

- **现象**：`28bacfd4` 先打 `gpt-5.6-sol` 上游 `server_error`，落到 `deepseek-flash` 后 400：`missing field call_id`。历史第 31 项是 Codex desktop 心跳 `function_call_output`（`name: automation_update`, `namespace: codex_app`），有 `id` 无 `call_id`。OpenAI 收；DeepSeek 反序列化更严。
- **修复**：`deepseek-responses` 增加 opt-in `fillMissingFunctionCallOutputCallId`。缺 `call_id` 时用非空 `id` 补上，已有 `call_id` 不动。不发明新 id，不改 rung。第一条候选的 OpenAI 5xx 是上游故障，不是这次 shape 问题。

## 历史条目摘要（最新要点）

- **2026-09-18 · Lite 把 DeepSeek 明文折进 summary（Provider / 协议互译，docs/05）**：外源 reasoning 明文折入空 summary 并清空 content，保留已有 summary 和 OpenAI 密文；完整记录见 git history。

## 更早历史总览

2026-09-18 Codex 回放前剥掉非 `gAAAAA` 外源 encrypted_content，保留可读正文，空项丢弃；完整记录见 git history。

2026-09-18 取消 Responses 默认首帧 15s 超时，保留 in-band 错误 fallback 与结果不明禁止重放；完整记录见 Git history。

2026-09-17 的外源 reasoning 缺明文时关闭 DeepSeek 思考、首字节超时、Lite reasoning、候选链解释、DSML 工具兼容、DeepSeek Responses、观测字段等记录已压缩，完整原文可从本次变更之前的 Git 历史回溯。

2026-09-06：Codex 模型发现使用上游 client_version 和可选 base_instructions；订阅模型自动/手动列表统一依据官方目录与数据库权威，完整记录见 Git history。

2026-09-05 Fable 5.1 目录/价格、2026-09-02 HTTP 结果不明禁止重放（保留明确拒绝的有界重试）、2026-09-01 超大历史发送前保护已并入历史；完整内容见基线 `8a7df80c6684b10bfa7ff7f4f07f237a92f95d58`。2026-08-30 及更早工作涵盖订阅图片/视频/TTS 的 entitlement、单写与价格边界，Responses HTTP/WebSocket 生命周期、发送前恢复证明、账号与 transport 亲和、超大历史与压缩，OAuth 模型发现、额度窗口、Retry-After、冷却、轮转和缓存，协议互译与 SSE/tool-call 保真、能力/价格目录、路由/分类/fallback/熔断，Memory observe/inject/反思/压缩/保留与并发治理，payload/session 分段持久化、失败记录、SQLite/Postgres 数据完整性与资源保护，Admin/Portal/i18n/可访问性、key 权限/预算/计量，以及构建、CI、Docker、发布和生产验收。具体默认值、兼容限制与历史实测均以对应提交为准；本次压缩前的完整条目可从基线 412c7cde02288d9b33d54a87f93b43925177b294 的本文件及 Git 历史回溯。
