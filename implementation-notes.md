# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-09-18 · DeepSeek 回放前补上缺的 function_call_output.call_id（Provider / 协议互译，docs/05，原则 3/8）

- **现象**：`28bacfd4` 先打 `gpt-5.6-sol` 上游 `server_error`，落到 `deepseek-flash` 后 400：`missing field call_id`。历史第 31 项是 Codex desktop 心跳 `function_call_output`（`name: automation_update`, `namespace: codex_app`），有 `id` 无 `call_id`。OpenAI 收；DeepSeek 反序列化更严。
- **修复**：`deepseek-responses` 增加 opt-in `fillMissingFunctionCallOutputCallId`。缺 `call_id` 时用非空 `id` 补上，已有 `call_id` 不动。不发明新 id，不改 rung。第一条候选的 OpenAI 5xx 是上游故障，不是这次 shape 问题。

## 2026-09-18 · Lite 把 DeepSeek 明文折进 summary，content 必须空（Provider / 协议互译，docs/05，原则 3/8）

- **现象**：v0.29.25 剥掉 `d8b7…8a-0` 后，同会话 `ffc6d4d6` 仍 400：`Invalid 'input[483].content': array too long. Expected … 0, but got … 1`（`array_above_max_length`）。mutation 已有 `foreign_encrypted_content_stripped`，失败项仍带着 DeepSeek 的 `reasoning_text`。Lite 不允许 reasoning `content` 非空；OpenAI 自己的项 `content` 是 `null`，明文只在 `summary`（`summary_text`）。
- **修复**：剥外源密文后，把 leftover `reasoning_text` 折进空的 `summary`，再把 `content` 清成 `[]`。已有 `summary` 不覆盖。Lite canonicalizer 对无 `gAAAAA` 的 reasoning 走同一折法；OpenAI blob 仍只清 content、不动 summary。不发明明文，不改 rung。

## 2026-09-18 · Codex 回放前剥掉外源 encrypted_content（Provider / 协议互译，docs/05，原则 3/8）

- **现象**：DeepSeek 成功后再打 `openai-codex/gpt-6-astra`，上游 400 `invalid_encrypted_content`。生产 `a8b37bb9`：历史 107 条 reasoning 里 106 条是 OpenAI 的 `gAAAAA…`，恰好 1 条是 DeepSeek 的 `d8b79690-…-0`，并带明文 `reasoning_text`。OpenAI 解不开别家密文。
- **修复**：Codex 发送前（`sanitizeCodexResponsesNativeBody` + Lite canonicalizer）删掉**不以 `gAAAAA` 开头**的 `encrypted_content`，保留明文 `content` / `summary`。没有明文的外源 reasoning item 整条丢掉。OpenAI 自己的 blob 不动。不发明明文，不改 rung。
- **为何只认 `gAAAAA`**：那是 OpenAI Fernet 密文的稳定前缀；DeepSeek 回的是 UUID 形。Lite 旧规则是「有密文就清空明文」——对这条 DeepSeek 项会把唯一可读的思考清掉、把外源密文留下，正好把 400 钉死，所以剥密文必须在那条规则之前。

## 2026-09-18 · 取消 Responses 首帧 15s 超时（Provider execution，docs/04/05，原则 5/8）

- **现象**：v0.29.23 上线后，真实 Codex 请求在 `response.created` 之后、第一帧真实输出之前被切掉。Admin 显示「错误 15s 通道不可用」，`response_create_outcome_unknown` / `after_response_created_before_output`。15s 对思考或工具准备过短。
- **修复**：执行层不再默认 `firstOutputTimeoutMs: 15_000`。生产路径不设这个上限；测试缝仍可显式传入（单测用 40ms）。`guardPreOutputFailure` 本身的 deadline 能力保留，省略或 ≤0 即关闭，与原先契约一致。
- **保留**：in-band 前导错误仍会 fallback；Responses 的 `response.created` 后不明结果仍禁止重放。不改 rung。

## 2026-09-17 · DeepSeek 缺明文 reasoning 时关掉思考，不伪造思考内容（Provider / 协议互译，docs/05，原则 3/8）

- **现象**：Codex 从 OpenAI 落到 `deepseek-responses/deepseek-flash` 后 400：`The reasoning_text in the thinking mode must be passed back to the API.` Lane rung 不动。
- **实测（真打 api.deepseek.com，用抓下来的上行体）**：历史里只有 OpenAI 的 `encrypted_content`，网关解不开。设 `reasoning.effort: "none"` 后成功返回工具调用、无 DSML；`thinking: {type:"disabled"}` 无效。
- **修复**：`deepseek-responses` 增加 opt-in 契约 `disableThinkingOnOpaqueReasoningHistory`。仅当同时满足「有工具历史 + 有 reasoning item + 至少一条没有明文 `reasoning_text`」时，把顶层 `reasoning.effort` 写成 `"none"`，其余字段原样保留。不发明明文，不改没有工具历史的请求，已有明文的也不动。
- **兜底**：执行层识别 `reasoning_text` + `thinking mode` 的 400，与既有 `reasoning_content` 一样记 `reasoning_history_incompatible`、不熔断、继续下一条候选。契约修掉了主路径；这条是漏网时的安全网。

## 2026-09-17 · 首字节超时：卡住的 Responses 前导算熔断，禁止重放不明结果（Provider execution，docs/04/05，原则 5/8）

- **现象**：过载上游 HTTP 200 开流，只吐 `response.created` + keepalive，几分钟才在流内报 `server_is_overloaded`。生产一条候选烧掉 103s / 104s 请求；熔断要等尝试结束才记账，5 次跳闸前用户已经等了好几分钟。池内过载退避本就有界（1s、3s），连通性测试用 no-op breaker 是刻意的。
- **修复**：`guardPreOutputFailure` 增加 `firstOutputTimeoutMs`。只卡**第一帧真实输出**；提交后拆除，慢生成的尾巴不切。到期抛 `errorClass: "timeout"`，Responses 带 `response_create_outcome_unknown`（请求可能已在上游执行，禁止重放到下一条候选），同时 `onTimeout` abort 上游。执行层曾默认 15s；2026-09-18 已取消该默认，见上方条目。
- **熔断**：post-send 不明结果原先 `recordAbort`。首字节超时是健康故障，即使不能重放也要 `recordFailure`，这样卡住的 Codex 别名会在几次后跳闸。
- **不改 rung**。测试缝 `firstOutputTimeoutMs` 只给单测把 15s 收到 40ms。

## 2026-09-17 · Lite 回放加密 reasoning 时清空明文 content（Provider / 协议互译，docs/05，原则 3/8）

- trace `4b84107d-1431-4cbc-afd7-4809dea790b5` 的上游 400 为 `input[5].content` 最大长度 0、实际长度 1。原请求带非空 `instructions`，Lite 插入 `additional_tools` 和 developer instructions 两项后，原始 `input[3]` 的 reasoning 变为 `input[5]`；此前将其判为 commentary 是索引误判，已撤回相关改动。
- 在 Codex 共用的发送前 canonicalizer 中，仅对 Lite 的 `type:reasoning` 且带非空 `encrypted_content` 的项将非空 `content` 清为 `[]`，保留密文、summary、ID、commentary 与工具关联。无密文时保留原项，避免无依据删除唯一的推理上下文；legacy 和 generic Responses 不受此规则影响。
- 使用生产请求的脱敏结构验证完整发送体及索引，覆盖 HTTP 流式/非流式、WebSocket 增量续接和无密文边界。本地验证不代表生产已部署或上游已验收。

## 2026-09-17 · 候选链只有一个候选时说明原因（Admin / 请求详情，docs/07，原则 5）

- **不是 bug，是缺解释**。Lukin 报"通道候选链只有一个模型，展开有问题"。查 box 记录 `5a0e80ed`：`policy.reason` 是 `stateful Responses continuation`，`candidate_chain` 恒为 `["openai-codex/gpt-5.6-terra"]`。`route-request.ts` 的 stateful 分支（最高优先级）**故意**只给一个候选——对话状态存在上游那个 `resp_...` 里，换 provider 兜底只会 400 + 丢上下文；`pool.ts` 里 `if (statefulContinuation …) throw lastErr` 连同池内换账号都不做，同理。近 24h box 上这类 2137 次（成功 2040 / 失败 97），全部单候选。
- **真问题在 UI**：卡片副标题写"按顺序尝试各通道；首个模型调用成功的通道会处理请求"，读起来像本该有多个；唯一的解释 `policy.reason` 被埋在下面 `request_meta` 的 JSON 里要展开才看得见。
- **最小改法**：`policy_reason` 从 `request_meta` 提成 `RequestDetail` 的正式字段（后端零改动，值一直都在记录里），`DecisionChain.svelte` 在**候选数 === 1** 时才渲染一行说明。三种钉死场景（stateful 续接 / explicit model / image 模型）各有文案，未知 reason 原样显示不留空白，`title` 挂原始串备查。多候选不显示——那行会是噪音。
- **没跑 `pnpm i18n:sync`**：它会重排整个 locale 文件并把隔壁 session 的未提交 WIP 卷进 diff（实测 63 行噪音）。7 个 locale 按字典序手工插入 3 条，每个文件只 +3 行。`extraction-anchors.svelte` 必须同步登记——`$t(变量)` 的 key 不挂锚点会被 `i18n:sync` 剪掉（这是已知坑）。
- **本机坑（与本改动无关）**：`better-sqlite3` 原生模块是 Node 24 编译的，本机已升 Node 26，e2e webServer 起不来（`NODE_MODULE_VERSION 137 vs 147`）。`pnpm rebuild` 无效（无输出不重编），要 `npx prebuild-install -r node` 才拉到对应版本。

## 2026-09-17 · DSML 泄漏修复补完：工具声明在 `additional_tools` 里，v0.29.21 的修复是 no-op（Provider / 协议互译，docs/05，原则 3/8）

- **v0.29.21 上线后仍然泄漏**（Lukin 在 21:32 复现，box 21:28:29 启动，新代码确实在跑）。遥测证实那轮 `gpt-6-astra` 过载后落到 `deepseek-flash`，而 attempt 的 `mutations` 是**空的** —— 翻译一次都没触发。
- **漏掉的地方**：翻译只扫请求**顶层 `tools`**。抓下真实上行体（box request `0e2ad9d9`）才看见，Codex code-mode 客户端**根本不在那里声明工具**：
  ```
  tools: null                              ← 顶层是空的
  input: [
    { type: "additional_tools", role: "developer", tools: [
        { type: "namespace", name: "functions", tools: [ {type:"custom", name:"exec", format:{lark…}}, … ] },
        { type: "namespace", name: "clock",     tools: [ … ] },   // 共 4 个 namespace / 13 个工具
    ]},
    …36 条 custom_tool_call + 36 条 output
  ]
  ```
  DeepSeek 把 `additional_tools` 当未知 item **静默忽略**，所以它看到的是"36 条对未声明工具的调用"——正是触发 DSML 退化的那个状态。
- **只翻译 `additional_tools` 内部不够**（实测 3/3 仍泄漏）：既然上游压根不读这个 item，改写它等于没改。**必须把工具提升到顶层 `tools`**。实测 hoist 后 3/3 干净。
- **hoist 所有工具，不只翻译的那个**：只提 `exec` 会让它的 namespace 同伴（`wait`/`sleep`/`send_message`…）继续不可见，而历史里也replay 了对它们的调用。保留原 `additional_tools` item 不删（上游忽略它，没理由动客户端数据）。
- **去重时机有讲究**：flatten 阶段**不能**按名去重，否则 `custom exec` + `function exec` 的冲突会被提前抹掉，导致本该跳过的翻译又跑起来；去重挪到改写阶段（上游拒绝重名）。
- **上游校验每个 hoist 上去的 schema**：`parameters: {}` 直接 400（`schema must be a JSON Schema of 'type: "object"'`）；省略 `parameters` 或给合法空对象都可以。这条是写 live 夹具时踩出来的，真实 Codex 工具带的是合法 schema。
- **我的验证方法第二次骗了我**：上一轮我"端到端验证通过"用的是自己构造的顶层 `tools` body —— 形状不对，所以测出来是绿的。**教训升级为硬规则：涉及客户端 body 形状的修复，夹具必须从 `request_payloads` 抓真实上行体，不能手写。** 本次 live 用例 `CODE_MODE_ADDITIONAL_TOOLS_BODY` 就是按抓下来的结构写的（含 lark `format`）。

## 2026-09-17 · DSML 泄漏的真根因与修复：翻译不被支持的 custom 工具（Provider / 协议互译，docs/05，原则 3/8）

- **推翻当天早些时候的结论**（见下一条）。那条笔记把 DSML 泄漏判成"模型不会用 Codex 的工具协议"并撤了 lane rung。**判断错了**，因为只测了单轮，没重放真实长历史。
- **取证方法**：从本机 Codex rollout 日志（`~/.codex/sessions/.../rollout-*.jsonl`）取出泄漏那一轮之前的 **480 条** `response_item`，原样重放到 live endpoint。**5/5 稳定复现**，触发条件干净：
  | 条件 | 结果 |
  |---|---|
  | 长历史（含 `custom_tool_call`）+ 声明了任意工具 | 干净的 `function_call`，0/6 泄漏 |
  | 长历史（含 `custom_tool_call`）+ 无工具 / `tools:[]` | **DSML 泄漏，5/5** |
  | 短历史 + 无工具 | 正常 |
  | `deepseek-v4-pro` 同条件 | 同样泄漏（非 flash 独有） |
- **真根因**：DeepSeek 的 Responses 只接受名为 `apply_patch` 的 `custom` 工具，其余一律硬 400（`Unsupported custom tool: 'exec'. Only 'apply_patch' is supported.`）。而 Codex 的 code-mode 会话主力工具正是一个叫 `exec` 的 custom 工具（那次会话 143 次调用，input 是 JS 代码）。于是工具无法声明，历史里却还留着 143 条 `custom_tool_call` —— **模型看见"过去一直在用 exec"、当前菜单上却没有**，就不再走协议，改用训练时的 DSML 标记把调用写成文本。这是**声明与历史不一致**导致的退化，不是协议不兼容。反证很有力：只要**声明了任何工具**（哪怕是不相干的 `sleep`），泄漏就消失。
- **修复**：新增请求契约 `translateUnsupportedCustomTools`（`deepseek-responses` 打开）。上行把不被支持的 custom 工具改写成等价的单 string 参数 function 工具，历史里的 `custom_tool_call` / `custom_tool_call_output` 一并改写成 `function_call` / `function_call_output`；下行把模型的 `function_call` 翻回 `custom_tool_call`。live 实测在原本泄漏的那条 transcript 上 **3/3 干净**。
- **流式取了个上限明确的捷径**（`ponytail:` 注释已标）：`function_call_arguments.delta` 是 `{"input":"..."}` 这个 JSON 的**字节切片**，一个切片可能劈开转义序列，要逐字符转发就得写增量 JSON 字符串解码器（50+ 行易错代码）。改为**缓冲到 `.done` 再一次性吐出** `custom_tool_call_input.delta` + `.done`（约 10 行，转义交给 `JSON.parse`）。代价纯 UX：客户端在调用完成时整块看到工具入参，而不是逐字滚动。升级路径写在注释里。
- **lane rung 已恢复**（6 条 GPT lane），并重写 `lanes.yaml` 注释块记录这次误判与真根因。
- **顺带修好两条一直是坏的 live 断言**：`live-deepseek-responses.test.ts` 里两处 `rejects.toThrow(/reasoning_text/)` 之类**从来不可能通过**——`UpstreamError.message` 是通用的 `upstream returned 400`，上游原文在 `providerRaw`。已加 `upstreamMessage()` 辅助函数从 `providerRaw` 读，三条断言统一改正。（在 main 上验证过它们同样红，不是本次引入。）
- **教训修订**：上一条写的"协议兼容是必要非充分条件"仍然成立，但**排查方法**才是真教训 —— 判定一个模型"不支持某协议"之前，必须用**真实 transcript 重放**，而不是构造单轮探针。单轮探针在这件事上两头都骗了我：它显示 `function_call` 干净（所以 rung 当初敢上），也永远复现不出泄漏（所以根因判错）。
- **事后对照官方 Codex 集成文档**（<https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/>，Lukin 指出）。文档独立印证了实测结论，并补上一块推不出来的信息：它给 Codex 下发的 `models.json` 里两个模型都声明 `apply_patch_tool_type: "freeform"` —— 即 DeepSeek **明确只为 `apply_patch` 这一个 freeform custom 工具做了适配**，`experimental_supported_tools: []`。这解释了 400 里那句"Only 'apply_patch' is supported"为何是设计而非遗漏，也确认我们**不翻译 `apply_patch`** 是对的（已补 live 用例钉住它的 freeform 往返：返回 `custom_tool_call`，input 是 `*** Begin Patch` 补丁文本而非 JSON）。
- **据文档补测的边界，全部宽容**：`reasoning.effort` 虽只声明 low/high/max，实测 minimal/medium/xhigh 也照收并原样回显（与 helm 的 clamp 策略相容，无需特判）；`text.verbosity` 三档全收；`parallel_tool_calls: true` 正常。**唯一真会 400 的是 `reasoning.summary: "none"`** —— 文档把它写成默认值，但请求侧只接受 auto/concise/detailed，照着文档默认值回传就是确定性 400。已补 live 用例记录。
- **`tool_choice` 指定具体工具在思考模式下一律 400**（`Thinking mode does not support this tool_choice`），custom 与 function 两种形态都一样。这与本次翻译无关（翻译前后都 400），但值得知道：Codex 若 pin 某个工具，这条 rung 必然失败并走链上下一个。
- **修掉一个翻译引入的 gap**：客户端同时声明 `custom exec` 和 `function exec` 时，翻译会撞上 `Tool names must be unique.`，把上游准确的 `Unsupported custom tool: 'exec'.` 换成一句误导性错误（两种情况都失败，但后者看不出真问题）。已改为**名称已被 function 工具占用时跳过翻译**，让诚实的错误浮出。

## 历史条目摘要（最新要点）

- **2026-09-17 · ~~撤回 DeepSeek 的 lane 兜底~~**：曾因 DSML 泄漏（全角 `｜` 文本标记）撤回 6 条 GPT rung；同日工具翻译条目恢复。完整原文见 git history。

- **2026-09-17 · 过载预算耗尽不再中断候选链**：`overloadRetry.exhausted` 曾 `break` 整个候选链。等待上界仍由跨候选 `attempt` 与池内 `budget.exhausted` 守住。

- **2026-09-17 · 接入 DeepSeek 原生 Responses 透传**：新增 `deepseek-responses` 字节透传；不新增 profile 枚举，用 `acceptsResponsesNativeItems`。两个真 400：缺明文 reasoning、回显 search call。lane 当天加过又撤，后由工具翻译条目恢复。

- **2026-09-17 · 记录上游回显的 safety_identifier**：记回显值而非发送值；流式取最后一个非空。Admin 放在「响应」面板。无迁移。

- **2026-09-17 · 记录真正发送上游的 Codex installation id**：按 attempt 记 mutation ledger，成功值提升到 `DecisionRecord.codex_installation_id`；`source` 三态 rebound/client/absent。未新增传播通道。
- **2026-09-17 · 修复 provider 字段兼容 400**：legacy `store:false` 删已证实被拒的 `status`；Sonnet 5 发送前再剥 `temperature`。不扩大通用 400 fallback。
- **2026-09-17 · 无消息上游失败暴露原始事件**：`response.failed` 缺 message 时连通性面板只剩固定文案。兜底消息追加 `code=` 与截断事件 JSON；完整事件仍在 `providerRaw`。测试用 `Symbol.asyncIterator` 避开 biome `useYield`。
- **2026-09-16 · 下线 gpt-5.5：断路由但保留价目**：与 Codex Spark 先例（条目删干净）有意偏离——box 上 `served_model='gpt-5.5'` 有 349,050 条 / $28,828.83，`historical-cost-reprice.ts` 查不到价目就 skip，删价目等于永久放弃重算能力。故只移除 lane / alias / provider 条目 / curated list，`pricing.yaml` + `capabilities.yaml` 保留并加退休注释。坑：`validateModelAliasTargets` 启动 fail-closed，alias 必须与 lane 同步删（删后由 `"gpt-5*": premium` 接住，优雅降级非 400）；**manual 模式的 `enabledModels` allowlist 绕过了退休过滤**，已在 `selectAccountModels` chokepoint 补上（测试抓到的，非预判）。`codex-models.json` 由 sync 生成不手改，过滤在 `parseModels`。顺带修正 docs/04 的 lane 计数。
- **2026-09-16 · Codex installation id 按账号重绑**：上游 `installation_id` 是 `$CODEX_HOME/installation_id` 里的纯随机 UUID v4（标识安装而非账号），同机多账号此前共用一个指纹出网。改为每账号确定性派生（`sha256(encKey ‖ "codex-installation:<provider>:<account>")` 前 16 字节整成 UUID v4 形状，永不轮换、免回写 DB）。**三处**必须一起重绑：header `x-codex-installation-id`、`client_metadata` 同名 key、`x-codex-turn-metadata` JSON 内的 `installation_id`——只改 header 则 body 仍泄漏真值。客户端未携带时完全不改写；turn-metadata 非法 JSON 原样透传；`prompt_cache_key` 取自 `session_id`，缓存亲和性不受影响。

- **2026-09-10 · 失败请求保留最终尝试的订阅账号**：`serving_account` 成功时仍是实际服务账号；全链路失败时改记最后一次真正发起上游请求的订阅账号，便于定位账号级故障。候选在选账号前就被熔断/能力门禁跳过则保持 `null`，不伪造分配结果；订阅账号失败后又试了其他 provider 时旧账号不会被误标。未新增 schema、迁移或正文记录。

- **2026-09-06 · 对齐 Codex Lite 身份与流式控制事件**：Lite 完整请求与增量续接保留带前缀的输入项 ID（旧 `store:false` 清理会删掉它们，两条生产失败分别丢了 157/239 个）；`response.metadata` / `codex.rate_limits` / `keepalive` 等控制事件不再提前提交执行尝试，使其后的过载仍能走有界恢复。真实输出、工具调用、加密 reasoning、结果不明断连的禁止重放边界不变。

- **2026-09-06 · Responses 空准备事件保留安全恢复窗口**（#840，本次过载修复的源头）：空 item / 空 part / 空 delta 继续缓冲，只有真实内容才提交流，使随后的过载错误仍能进入 OAuth sibling retry 与模型 fallback；EOF/断连结果不明仍禁止重放。OAuth pool 在首个真实输出前对结构化 `server_is_overloaded` 做同账号短退避（1s、3s），与 HTTP 503/529 共用**请求级**两次额外重试预算。当时把"预算耗尽后禁止账号/模型层重新开始"实现成了 `execute.ts` 里的 `break`，2026-09-17 已纠正为只停等待、不停链推进。`provider.overload_retry` 日志只记 trace/原因/次数/等待毫秒/耗尽标志。

- **2026-09-06 · Remote 配置同步后的目录与 e2e 一致性**：通用 lane 改以 `gpt-5.6-*` 子 lane 为主候选并移除官方 DeepSeek 直连候选，e2e 断言随之对齐；修正 `gpt-image-2` 的 capability key（原为旧的 `zenmux/gpt-image-2`，导致图片端点误报 404）。未改运行时代码。
- **2026-09-06 · 记录 Responses 流内上游错误事件**：error detail 增记 `upstream_event`（`error` / `response.failed`）；HTTP status 保持可空（上游可能先开 200 流再报错）。纯增量、保留原始 provider payload，使 Codex 过载失败可与 Helm 自身准入错误区分。
- **2026-09-06 · 将 Remote 运行时配置同步回仓库**：Remote `/opt/helm-api/config` 无 Git checkout，本次读取 11 个正式 YAML（排除 `.bak*`）原样写回；保留 Remote 的 GPT-6 语义（`gpt-6-astra` lane 主候选 `openai-codex/gpt-6-astra`，四个兼容别名指向该 lane）。
- **2026-09-06 · Codex 原生模型列表保留手动自定义 ID**：`GET /v1/models` 对尚未出现在上游目录的手动 ID，借该账号最低 priority 模型的兼容元数据生成条目（改写 slug/display_name）；只为列表展示与协议兼容兜底，不宣称真实能力，自动模式仍只输出上游发现项。
- **2026-09-06 · 订阅账号手动模型允许自定义 ID**：Manual 模式以运维保存的 `enabledModels` 为权威，Codex 自定义 ID 即使未出现在账号目录也保留（只表示“允许尝试”，不伪造 entitlement）；Automatic 仍只跟随上游发现。注意其后 2026-09-16 已为该路径补上退休模型过滤。
- **2026-09-05 · GPT-6 Astra 官方 API 目录与价格**：官方 API capability/pricing 与 reasoning 参数兼容已加入 override，订阅 lane 保留；定价和限制按对应提交回溯。

## 更早历史总览

2026-09-06：Codex 模型发现使用上游 client_version 和可选 base_instructions；订阅模型自动/手动列表统一依据官方目录与数据库权威，完整记录见 Git history。

2026-09-05 Fable 5.1 目录/价格、2026-09-02 HTTP 结果不明禁止重放（保留明确拒绝的有界重试）、2026-09-01 超大历史发送前保护已并入历史；完整内容见基线 `8a7df80c6684b10bfa7ff7f4f07f237a92f95d58`。2026-08-30 及更早工作涵盖订阅图片/视频/TTS 的 entitlement、单写与价格边界，Responses HTTP/WebSocket 生命周期、发送前恢复证明、账号与 transport 亲和、超大历史与压缩，OAuth 模型发现、额度窗口、Retry-After、冷却、轮转和缓存，协议互译与 SSE/tool-call 保真、能力/价格目录、路由/分类/fallback/熔断，Memory observe/inject/反思/压缩/保留与并发治理，payload/session 分段持久化、失败记录、SQLite/Postgres 数据完整性与资源保护，Admin/Portal/i18n/可访问性、key 权限/预算/计量，以及构建、CI、Docker、发布和生产验收。具体默认值、兼容限制与历史实测均以对应提交为准；本次压缩前的完整条目可从基线 412c7cde02288d9b33d54a87f93b43925177b294 的本文件及 Git 历史回溯。
