# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

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

## 2026-09-17 · ~~撤回 DeepSeek 的 lane 兜底：它不说 Codex 的工具协议~~（结论已被上一条推翻）（Config / 路由，docs/04，原则 3/5）

- **现象**：Codex 会话里出现了直接打印给用户的 `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="exec">`（注意是**全角** `｜`，DeepSeek 私有的 DSML 标记）。命令根本没执行，只是被当成聊天文本渲染。
- **定位**：查 Codex rollout 日志，该段落的 `role` 是 `assistant`、`type` 是 `output_text`——不是 tool call。再查 helm 遥测，那一轮（13:38:28）请求 `gpt-6-astra`，GPT-6 过载后 fallback 落到 `deepseek-responses/deepseek-flash`。同一分钟内有 5 条请求落到该 rung（含从 `claude-opus-4-8` 转来的）。
- **根因不在 helm**：透传是对的，是**模型不会用 Codex 的工具协议**。DeepSeek 接受 Codex 的 tools 定义，却不按 `function_call` item 返回，而退化成自己训练时的文本标记。（此前实测过裸 `function_call` 是正常的，所以这是 Codex 特定工具形状下的退化，不是完全不支持。）
- **为什么必须撤**：这是**静默失败**——上游返回 200、status completed、内容看着像在干活，实际什么都没做。比起客户端会重试的 502，一个"假装干完了"的 200 严重得多，而且只有人眼看到原始标记才会发现。承载重度工具调用的 Codex 流量不能挂这种兜底。
- **撤的范围**：只撤 6 条 GPT lane 的自动 rung，回到 v0.29.17 的链路。`deepseek-responses` provider 与 capabilities/pricing **全部保留**——显式 `allow_custom_model` 仍可指定（纯对话场景没有工具协议可搞错），且历史必须保持可重新计价。
- **教训**：同协议（openai_responses）只保证**请求能被解析**，不保证**响应遵循同一套工具语义**。给工具型客户端选兜底，协议兼容是必要条件而非充分条件，得实测工具往返而不只是单轮文本。此前我把"live 测试验证了 custom_tool_call 被接受"当成了"工具链路可用"，这一步跳得太快。
- 配置注释里留了完整原委与那段 DSML 原文，防止将来有人只看到"同协议兜底"的好处又加回去。

## 2026-09-17 · 过载预算耗尽不再中断候选链（Provider execution，docs/04，原则 5）

- **现象**：v0.29.18 上线 DeepSeek 兜底后，线上 15 条过载请求里 10 条 `fallback_count: 0` —— 12 个候选只试了第一个，后面连 skip 记录都没有，直接 `all_providers_failed`。堆栈指向 `execute.ts` 的候选循环在首次失败后就退出。
- **根因**：`if (overloadRetry.exhausted) break;`（#840，2026-09-06 引入）。它 `break` 的是**整个候选链循环**。原意合理——不要在换模型后重启过载退避、把等待时间累加成几十秒——但实现把"不要再等"写成了"不要再试"。
- **两件事本就该分开**：预算约束的是**单个请求累计 sleep 多久**，而候选推进是另一个问题。下一个候选往往是完全不同的上游（本例是静态 DeepSeek），头部 Codex 过载对它毫无预测力，跳过它没有任何依据。
- **等待上界没有被削弱**（关键核查）：删 `break` 后重新确认了两道真正的防线 ——（1）`overloadRetryDelayMs` 只按共享的 `budget.attempt` 计算，backoff 表仅 2 项，第 3 次起恒为 null，而 `attempt` 是**跨候选累加**的，所以后来的候选继承的是已花光的预算，无法重启退避表；（2）`pool.ts` 的 `if (budget.exhausted) throw err;` 在池内直接抛出。两者都与链推进无关。
- **意外发现**：`waitForOverloadRetry` 根本不读 `exhausted` 标志，只看 `attempt`。所以 `{attempt:0, exhausted:true}` 仍会 sleep —— 该标志只是给调用方读的**结果**，不是输入开关。我最初按标志写的测试因此断言失败，改为按 `attempt` 断言才是真实契约。
- **测试**：`execute.test.ts` 原有那条 `it.each([false,true])` 正是钉住 bug 行为的（`exhausted` 时断言 `attempts` 只有 1 条），改为两种情况都必须推进到第二个候选；另在 `retry.test.ts` 补两条，把"耗尽后不再 sleep / 后来的候选不能重启退避表"这个 #840 的真实本意钉在它该在的那一层。

## 2026-09-17 · 接入 DeepSeek 原生 Responses 透传（Provider / 协议互译，docs/02/05，原则 3/8）

- **动机**：DeepSeek 上线了自己的 `/v1/responses`（<https://api-docs.deepseek.com/zh-cn/guides/responses_api>）。此前 `deepseek` provider 只是 `type: openai`（`openai_chat` 线路），Codex 请求打过去必须经 `Responses→IR→Chat` 翻译；而 DeepSeek 恰恰**要求把 reasoning 项原样回传**，翻译必然丢掉它们。新增 `deepseek-responses` provider（同 host、同 `DEEPSEEK_API_KEY`，`type: deepseek-responses` → `openai_responses`）后，Codex 走字节透传。
- **实测（2026-09-17，真打 api.deepseek.com）**：逐条验证而非照抄文档。verbatim Codex body（instructions/tools/store/include/`custom_tool_call`/reasoning 回传）**200**；不支持的字段（`previous_response_id`/`metadata`/`service_tier`/`stream_options`/`context_management`）**静默忽略**；未知 item 类型（`mcp_call`/`local_shell_call`/`totally_unknown_item`）**200**。两个真会 400 的点：①tool-call 历史缺 reasoning → `The reasoning_text in the thinking mode must be passed back to the API.`（只带 `encrypted_content` 无明文 `content[]` 同样 400）；②回显的 `web_search_call`/`file_search_call` 被严格反序列化 → `missing field queries/action`（带不带 `action` 都 400）。
- **不新增 profile 枚举**（关键权衡）：`execute.ts` 的 `needsCodexResponsesShim` 判定是 `nativeProtocolProfile !== "generic_openai_responses"` 取反，新枚举会让 DeepSeek 误吃 Codex shim（砍掉它明确支持的 `temperature`/`max_output_tokens`）。因此沿用 `generic_openai_responses`，另加一个**能力位** `ProviderClient.supportsResponsesNativeItems`，只在两个降级判定点（透传闸门 `targetIsGenericResponsesProfile` 与 `candidateGuardSkipReason`）放行。默认 absent ⇒ xAI/Grok 的降级行为**完全不变**。
- **xAI 的降级对 DeepSeek 有害**：Grok 那套"带 Codex items 就降级去翻译"在这里会稳定产出 400（翻译丢 reasoning），所以 DeepSeek 必须反向选择 —— 字节透传是唯一可行路径，不是优化。
- **两个语义拆成两个 flag**：`dropBuiltInSearchCallItems`（wire 怪癖，剥 `web_search_call`/`file_search_call`）与 `acceptsResponsesNativeItems`（能力声明）分开，避免把"要剥搜索项"和"能吃 Codex items"耦成一个开关。
- **`serialize-client.ts` 同步转发新字段**：该文件只逐个复制方法，数据字段不列进去就会被悄悄丢掉（此前 `nativeProtocolProfile` 就这样导致多账号池判定失效）。
- **capabilities**：`jsonOutput: schema` 已实测（Responses 的 `text.format` 支持 `json_schema`，与 Chat 端 `response_format` 不同，故与 `deepseek/*` 的 `object` 有别）。vision 只给 `deepseek-flash` 开：`deepseek-v4-pro` 传图不报错，但官方文档只列 flash 真正处理图片，**按 fail-closed 标 false**，避免 vision 请求被静默忽略图片。
- **live 测试**：`packages/core/src/provider/live-deepseek-responses.test.ts` 默认 skip（`HELM_LIVE_DEEPSEEK=1` 开启），把上述四条真上游断言固化下来，CI 不会打真上游。
- **~~已进 lane~~（当天即撤回，见上方 2026-09-17 条目：DeepSeek 不说 Codex 的工具协议，会静默失败）**：曾给 6 条 GPT family lane（`gpt-6-astra` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.4` / `gpt-5.4-mini`）各加一条 `deepseek-responses/*` rung，排在同族订阅 slug 之后、通用 lane 之前；pro 配高质量档，flash 配廉价档。理由同上：这些 lane 承载 Codex 流量，而通用链里的 grok（同协议但会被降级翻译）与 claude（跨协议常被 skip）对带 Codex items 的请求往往不可用，`deepseek-responses` 是配置中**唯一的静态同协议 rung**。
- **连带效果（已确认并接受）**：`premium`/`balanced`/`economy` 的 primary 本身就是 `gpt-5.6-sol`/`terra`/`luna` 这三条 lane，所以 DeepSeek 自动出现在**每条通用 lane 的第二位**——订阅一挂，全部流量（不止 Codex）先落 DeepSeek，claude/grok 顺延。Lukin 明确接受：延迟与成本更优，且同协议兜底最可靠。`rules-routing.test.ts` 的 premium 链断言已同步。
- **e2e 未受影响**：routing/protocol/smoke 共 37 例全过。e2e 用 `HELM_PROVIDER_BASE_URL` 把所有 provider 指向同一 mock，其入站是 openai_chat，`deepseek-responses` 因协议不匹配被跳过，故"无订阅时实际执行模型"的断言仍落在 `openrouter/deepseek-*` 上。

## 2026-09-17 · 记录上游回显的 safety_identifier（Responses 路由 / Admin，docs/05/07/11，原则 7/8）

- **动机**：`safety_identifier` 一直在转发给上游、也被 `pool.ts` 当账号亲和键用，却从不落库（线上 50 条 0 命中）。无法回答"上游到底认了哪个终端用户标识"。
- **记回显值而非发送值**（Lukin 拍板）：回显才证明上游确实接受；两者不一致即暴露上游改写或忽略。
- **零新增解析**：流式中继的 `responseSnapshotFromStreamFrame` 本就逐帧 `JSON.parse` 取 `response` 对象拿 id/status，`safety_identifier` 在同一对象上，多读一字段即可。字节中继不受影响（原则 8），`raw` 路径原样写出，并有专门用例锁住转发字节。
- 非流式共用 `echoedSafetyIdentifier`，避免两处读法漂移。两条路径都只在值存在时写入：缺失保持 absent，**不退化成空字符串**（空串像一个真实身份，比没有更糟）。流式取最后一个非空值，`response.completed` 比 `response.created` 前导帧权威。
- 顶层字段 optional，旧记录 round-trip 不变，**无需迁移**。
- **后续修正（同日，Lukin 指出）**：Admin 详情页原本把它放进「请求」面板（`buildRequestMeta`），位置错了——记的既然是**上游回显值**，它就是响应侧事实（上游接受了该 id 的证明），应当在「响应」面板。已挪到 `response_meta`。客户端**发送**的那个值本就在抓取的请求正文里可查，不需要在请求元数据里重复。存储字段 `DecisionRecord.safety_identifier` 不动，仅改展示分组；两侧都用通用 `JsonViewer` 渲染，无硬编码标签与 i18n 键需要同步。注意 `response_meta` 在 `status==='error'` 时为 `null`，但该值只在 served 路径写入，不会因此丢失。

## 2026-09-17 · 记录真正发送上游的 Codex installation id（Provider / Routing / Admin，docs/05/07/11，原则 7）

- **动机**：#856 把 installation id 重绑为每账号独立值后，真正上到上游的那个值没有任何留存，只有 `body_shims_applied` 里一个"改写过"的布尔标记。账号被风控时无法回答"这次用的是哪个 id"，也无法验证重绑生效。
- **粒度**：按 attempt 记在各自的 mutation ledger（fallback 链跨账号，id 各不相同，这是唯一不丢信息的粒度），另把服务成功那次的值提升到顶层 `DecisionRecord.codex_installation_id` 供详情页「请求」面板直接展示；全链路失败时退回最后一次记录到 id 的 attempt。
- **`source` 三态**：`rebound`（我们改写过，此时才额外留客户端原值）/ `client`（客户端自带且已等于账号绑定值）/ `absent`（请求没带 id）。此前这三种情况在遥测里无法区分。
- **未新增传播通道**：`prepareRequest` 已有 `Object.assign(input.mutations, prepared.carrier.mutations)` 把 provider 内部 ledger 写回调用方 carrier，`execute.ts` 抓的正是同一引用。原计划的回调机制经验证属多余，已撤销。`execute.test.ts` 新增用例专门守这条链路。
- 三个字段均为不透明标识符，不含正文或密钥；全部 optional，旧记录 round-trip 不变，**无需迁移**。
- **顺带修正**：v0.29.15（#861）误把发布条目拼进了文件头部的格式说明行，导致模板被覆盖，本次恢复。

## 2026-09-17 · 修复 provider 字段兼容 400（docs/04/05，原则 3/8）

- Codex legacy `store:false` input 删除已由生产证实被拒绝的 `status`；`phase` 没有拒绝证据，保留其历史语义。Lite input 身份、加密 reasoning、tool call 关联均不改动。
- Claude Sonnet 5 在转换与 native 发送边界移除已弃用的 `temperature`；strict thinking 可能重新注入 `temperature=1`，因此序列化前再次应用同一模型规则。其他模型维持原行为。
- 不扩大通用 400 fallback，也不重放已提交输出；已知字段在首次发送前修正，后续临时 provider 故障继续走既有 fallback。仅 Sonnet 5 有生产拒绝证据，本次不推测扩大到其他 Claude 模型。

## 2026-09-17 · 无消息上游失败暴露原始事件（Provider / Admin，docs/05/07/11，原则 3/8）

- **真实触发**：生产两个 ChatGPT Pro 账号（`gongjin843677@` / `smithmark3673@`）全模型失败，连通性面板只显示 `codex responses stream error` 一句，**无法判断是封号、风控还是配额**。同时刻另两个账号正常，排除了通道与网络因素。
- **根因**：`responseEventError` 的兜底分支——上游 `response.failed` 事件里 `message` 与 `error.message` 都缺失时，直接返回那句固定文案，**原始事件既不进日志也不传前端**，诊断信息在此处彻底丢失。
- 现在兜底消息保留原句作稳定前缀，追加 `code=<code>` 与事件 JSON（`summarizeUpstreamEvent`，截断 400 字符防刷屏）；完整事件仍在 `UpstreamError.providerRaw`。有 message 的上游错误路径**完全不变**。
- 连通性测试 SSE 的 error 事件新增 `upstreamStatus` + `providerRaw` 两个**可选**字段，仅 `UpstreamError` 携带；其他错误事件形状不变，前端旧行为兼容。管理面板加可展开的「上游详情」块（7 语言均已补译，CI 的 locale 对齐门禁会卡）。
- **坑**：测试里用 `async function*` 写"只抛不产出"的 iterator 会被 biome `useYield` 拒绝；改为直接实现 `Symbol.asyncIterator` + `next: () => Promise.reject(...)`，语义上也更贴近"首次拉取即失败"的真实场景。
- 截断上限 400 字符是拍板值，无配置项——理由同原则 2：会撒谎的旋钮比没有旋钮更糟，完整内容本就在 `providerRaw` 里。

## 2026-09-16 · 下线 gpt-5.5：断路由但保留价目（Config / OAuth discovery，docs/04，原则 2/6）

- **与 Codex Spark 先例（`33c1f799` + `9e3bfb67`）的有意偏离**：Spark 的 config 条目被删干净，gpt-5.5 不能照做。box 上 `served_model='gpt-5.5'` 有 349,050 条、$28,828.83（2026-06-12 起）。`historical-cost-reprice.ts` 按 alias 查 catalog，查不到就 `skip(alias,"pricing_entry_missing")`——删掉价目等于永久放弃这批记录的重算能力。故采用**只断路由**：移除 lane / alias / provider 条目 / curated list，`pricing.yaml` + `capabilities.yaml` 保留并加退休注释说明为何不是孤儿。Spark 从未有过价目条目（`git log -S` 确认），所以它没有这个取舍。
- **alias 删除必须与 lane 同步**：`validateModelAliasTargets` 在启动时 fail-closed，只删 lane 会拒绝启动。删掉 `"gpt-5.5"` 映射后，pin 该 id 的客户端由 `"gpt-5*": premium` 接住——优雅降级而非 400。
- **坑：manual 模式的 allowlist 绕过了退休过滤。** `RETIRED_OPENAI_CODEX_MODELS` 覆盖 live discovery 与 bundled/cached 目录，但 `selectAccountModels` 对 manual 模式**原样返回** `enabledModels`，退休前存下的账号设置会让该模型复活为可路由 alias。已在该 chokepoint 补过滤（仅 openai-codex；manual 保留自定义 id 的语义不变）。这是新写的测试实际抓到的，不是预判。
- `codex-models.json` 仍含 gpt-5.5 slug——它由 `pnpm sync:codex-models` 从上游生成，手改会被覆盖，保证来自 `parseModels` 的过滤（沿用先例）。
- gpt-5.5 无独立 quota limit family（Spark 有 `codex_spark` / `-codex-spark` 后缀），故 `isRetiredOpenAICodexLimit` 与 admin `.svelte` 均无需改动。
- 顺带修正 docs/04 的 lane 计数（13→12 vendor-family；总数标称 22 实为 26，gpt-6-astra / grok / media lane 加入后未更新）。

## 历史条目摘要（最新要点）

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
