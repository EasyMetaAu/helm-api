# 实现笔记（Implementation Notes）

> 记录 spec 未覆盖、不得不自己做的决定，被迫的修改、权衡取舍，以及用户应当知道的坑与 TODO。
> **新条目追加在最上方**，格式：`## YYYY-MM-DD · 标题`，并注明所属 spec 章节。
>
> **体积控制规则（必须遵守）**：本文件只保留**最近 10 条**可追踪记录。新条目入栈时，保留顶部最新完整记录与历史摘要中最新的一行要点；超过 10 条的更早历史压缩进文末「更早历史总览」的一段概括。完整原文可经 git history 回溯。

---

## 2026-10-29 · OpenAI API key 账号池与月度恢复（docs/04、06、11）

- **范围**：同一 OpenAI provider 下配置多个项目／服务账号 key；Chat、Responses 共用账号状态。默认按独立请求轮询，支持手动优先级；保留流式首输出与续接绑定规则，不接余额查询或 Admin key 费用同步。
- **存储决定**：复用 `config_kv` 单行与 AES-GCM，加上 SQLite／Postgres 原子比较更新；凭证及状态整包加密，不新增表或迁移。配置未初始化时兼容环境变量 key；一旦管理账号，删除最后一个账号也不回退到旧 key。
- **恢复规则**：按配置时区（默认北京时间）每月 1 日允许一次真实业务请求验证。跨实例通过持久化租约避免重复验证；验证失败至少等待 24 小时。月初不是余额已恢复的证明，不发付费定时探测、不购买或消耗订阅重置额度。
- **身份边界**：管理 ID 稳定，路由 ID 包含凭证代次；换 key 后旧续接拒绝发送，旧请求不能覆盖新凭证状态。手动暂停和失效凭证不在月初自动恢复。
- **界面修正（2026-10-30）**：按 Opus 的布局建议复用现有响应式账号表、状态标签与操作菜单，移除重复卡片和未定义颜色变量；页面标题覆盖订阅与 API key。保留账号池在上方便于管理，使用既有金额精度格式，避免小额费用显示为零。桌面与窄屏验收使用合成账号，不传输生产截图或凭证给设计模型。
- **逐 Key 测试（2026-10-30）**：管理界面可选择已配置且符合账号允许列表的文本模型，以当前 Key 发起最长 30 秒、最多 256 输出 token 的固定短请求。直连对应 provider，不参与轮换或失败转移；暂停、额度及失效状态不因诊断而改变。记录实际用量，错误仅返回安全代码，取消弹窗中断请求；测试会消耗上游额度，不能证明剩余余额。真实上游验收发现 GPT-6 Luna 不支持 `minimal`，固定短测试改用其支持的 `none`，并增加回归测试。
- **发布准备**：v0.30.62 已执行 `pnpm release:prepare 0.30.62`，官方稳定快照仍为 Grok 1.0.70、Claude Code 2.1.312、Codex 0.165.0 及同 tag 模型目录，无快照差异；补齐其余五种管理界面语言，修复完整 CI 的词条一致性失败。
- **限制**：轮询次数在单个 gateway 的协议池内均衡，不保证多副本全局严格均匀；用量仅覆盖 Helm 观察到的流量，金额为估算。策略可在后台覆盖 YAML 默认值，时区仍由配置控制。


## 2026-10-28 · Sonnet 5.5 强制工具选择能力过滤（docs/02、04、05、07）

- **根因**：生产请求被 Sonnet 5.5 以不支持 `tool_choice: tool/any` 拒绝；执行器把上游 400 当作整个请求无效，因此没有尝试后续候选。Anthropic 当前官方文档确认该限制也适用于 count_tokens。
- **决定**：新增可选能力 `supportsForcedToolChoice`，为 `anthropic/claude-sonnet-5-5` 显式设为 false。执行器在 token 计数与发送前跳过不支持的模型，记录 `no_forced_tool_choice_support`，并保留客户端原有强制工具要求供后续模型执行；全部候选不兼容时沿用 422。auto/none 不受影响，不把真实无效请求的 400 改成通用重试。
- **兼容与限制**：未配置新字段的模型维持现有行为；不推断其他模型的限制。定向回归覆盖原生 Anthropic 入站规范化、流式／非流式、零上游调用、fallback 参数保留及不计熔断故障。本条记录本地修复，生产需部署代码及能力配置后才能生效。
- **发布准备**：按发布工具准备 v0.30.59，固定 Grok 1.0.70、经独立静态审查的 Claude Code 2.1.312、Codex 0.165.0 及同 tag 模型目录；新的远程 worker 票据头继续剥离。仅补齐官方目录中的 Terra 元数据，不修改 lane 默认路由。计划分别核验 remote 原生执行和 192.168.8.4 串联路径；LAN 的 remote-helm lane 代表远端候选链，不能误标成单个 Sonnet 模型不支持强制工具。

## 2026-10-27 · GPT lane 去版本化并按优先档位排序（docs/04、06、11）

- **命名**：`gpt-6-astra`、`gpt-6-luna`、`gpt-6.1-sol`、`gpt-6.1-terra` lane 分别改成 `gpt-astra`、`gpt-luna`、`gpt-sol`、`gpt-terra`；lane 配置先按 `economy`、`balanced`、`premium` 排列，其次是 coding、JSON、tool use、vision、transcription 等功能 lane，最后是厂商／模型 lane；功能组与厂商组分别保留原有相对顺序。旧模型名、日期及 `openai.` 客户端别名继续映射到新 lane。
- **边界**：只改 lane 名和引用，不改真实上游 model ID、价格、能力、reasoning effort 或 fallback 顺序。Admin、Portal 与模型发现继续读取配置；192.168.8.4 的 Helm 串联模型与目录键同步改名，避免把新 lane 名直接发送给真实模型上游。
- **部署**：检查所有配置引用与现役 key 的 lane 作用域，保留无关自定义配置。v0.30.58 按发布工具同步稳定快照，分别读回两台服务器的排序与路由，并验证新名称及旧别名的真实流式响应。后续显示顺序修正直接更新现役配置，保持 v0.30.58 镜像与路由内容不变。

## 2026-10-27 · 恢复 Sol 默认路由并保留独立 Terra lane（docs/04、06）

- **用户修正**：保留 `gpt-6.1-sol` 与 `gpt-6.1-terra` 两个独立 lane；balanced、json、vision 及旧 Sol／GPT-5.6 Terra 客户端别名恢复指向 Sol。只有明确请求 `gpt-6.1-terra` 及其命名变体时进入 Terra lane，不把 Terra 作为其他 lane 的候选。
- **范围**：Sol、Terra 的 provider、能力和价格均保留，原 reasoning effort 与 fallback 顺序不变。此次是 v0.30.56 默认路由选择的修正，不删除 Terra 支持、不更改账户权限或数据库结构；发布工具准备 v0.30.57 并重新核验稳定客户端快照。
- **部署**：remote 保留订阅优先链；192.168.8.4 保留经过 remote Helm 的串联结构，分别恢复 Sol lane 并保留 Terra lane。部署时检查最新配置和 key 作用域，不覆盖无关运营设置。v0.30.56 已验证的 Codex 流式约束与 12 小时缓存计费限制继续适用。

## 2026-10-27 · GPT-6.1 Terra 替换 Sol lane（docs/04、06、07）

- **范围与兼容**：所有原 `gpt-6.1-sol` lane 名称及引用改为 `gpt-6.1-terra`，原 Sol 客户端别名转到 Terra，保留 Sol 显式 provider 配置和价格。档位、reasoning effort 与 fallback 顺序不变；新 Terra 官方 API 注册到 Responses，避免 Chat Completions 不支持工具调用。
- **官方依据**：[模型页](https://developers.openai.com/api/docs/models/gpt-6.1-terra)与[价目表](https://developers.openai.com/api/docs/pricing)，2026-10-27 核对：API context 1,050,000、最大输入 922,000、最大输出 128,000；reasoning 为 none/low/medium（API 默认）/high/xhigh/max。标准每百万 token 输入 $1、输出 $5、缓存读取 $0.05，30 分钟写入 $1.25；超过 272K 输入时整次请求输入/缓存 2 倍、输出 1.5 倍；Flex 半价、Fast 两倍，区域处理 1.1 倍。
- **订阅边界**：[官方 Codex 目录](https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json)同日含 Terra：默认 context 500K、最大 context 872K、默认 low、Responses Lite。静态能力取 500K，账号实时目录继续决定可用性、推理等级、上下文与协议。当前固定 Codex 0.164.0 离线快照不含 Terra，本次不手改官方快照；只有离线旧目录时会走现有 fallback，manual 清单也需由运营方启用 Terra。未调用真实账号验证权限。
- **计费限制**：订阅价格为 API 等价估算。现有 schema 不区分 OpenAI 12 小时缓存写入（标准短上下文 $2.50/MTok），也没有独立 max-input 字段；本次不扩展计费或请求模型，不将 12 小时价冒充 1 小时缓存价。发布准备按用户后续授权升级至 v0.30.56；Claude 2.1.311 已通过独立静态协议检查，新增四个字段继续剥离，详见 `docs/claude-protocol-safety.md`。Grok、Codex 稳定版按发布工具同步；部署与真实上游结果另行核验。

## 2026-10-26 · Codex 旧 turn-state 发送前换账号（docs/04、05、06、07）

- **原因与边界**：原账号冷却时，即使 HTTP 请求携带完整历史，旧 `x-codex-turn-state` 仍强制绑定原账号。本次只在零发送、原账号已知且不可调度、有其他可用账号时恢复：验证完整 input 与工具配对，删除该请求副本的旧 header，保留所有正文并重新选择账号；不清除账号配额或修改用户设置。
- **状态更新**：请求级 reset 跳过所选账号的旧 turnKey 缓存，上游返回的新状态正常回传并记录。后续携带新状态继续绑定新账号；旧客户端对象、其他会话与原账号续接映射不批量清空。变更在 mutation ledger 记录 `codex_turn_state_recovered`。
- **限制**：`previous_response_id`、conversation、item/file 引用、不完整工具对、未知 input 类型以及内部 WebSocket session 不走本次恢复；继续要求完整历史或原会话恢复。POST 后结果未知、已有输出及容量三次重试耗尽不触发此类换号。
- **发布准备**：v0.30.55 已通过 `pnpm release:prepare 0.30.55`，客户端与模型目录保持已验证的 Grok 1.0.70、Claude 2.1.310、Codex 0.164.0 快照。
- **真实协议证据**：通过公网发送三轮极短合成请求，生产读回账号 A → B → B；第二轮无旧状态但保留历史，收到新 turn-state，第三轮携带新状态成功且不必再次获得状态头。没有重放用户原始任务或主动修改生产账号冷却；测试 Key 均撤销。

## 2026-10-26 · Codex 容量重试、账号冷却与断流证据（docs/02、04、05、07）

- **容量拒绝**：仅对 Codex 在产生实际输出前明确返回的 `Selected model is at capacity. Please try a different model.` 重试同账号、同模型；首次加最多 3 次重试，共享现有 HTTP/SSE 重试预算，默认等待 1、3、5 秒，沿用有界 Retry-After。耗尽后返回 `codex_model_capacity_exhausted` 并建议手动更换账号，不自动切换账号或后续候选。
- **不可重放边界**：文本、推理或工具工作已经出现、发送结果不明、认证/配额/请求错误均不因容量文案重试；覆盖流式首输出守卫、WebSocket 缓冲与非流式聚合。请求取消会中断退避，账号在等待中失去可用资格时提前停止。
- **账号冷却**：只对可信的发送前 `oauth_affinity_unavailable` 返回 HTTP 429、向上取整的 `Retry-After` 和原恢复字段；真实 pipeline 在提交流响应头前暴露路由失败。错误仍记录遥测，准入资源释放一次；不放宽续接账号约束，不保证外部客户端遵循等待时间。
- **断流证据**：DecisionRecord 新增可选 `stream_diagnostics`，记录部署 revision、HTTP/WS、取消来源、上游终态、写出结果、阶段、事件计数及允许的传输错误码；不记录任意取消原因、正文或凭证，无数据库迁移。写入成功不证明客户端收到，历史 `client_abort` 也不能据此反推为用户主动取消。
- **发布准备**：v0.30.54 已执行 `pnpm release:prepare 0.30.54`，官方稳定快照仍为 Grok 1.0.70、Claude Code 2.1.310、Codex 0.164.0 及对应 tag 模型目录；没有扩展协议或身份白名单。
- **验证与限制**：先复现失败再修复，并以真实 pipeline、模拟上游和协议回归验证；此条记录本地修复，不代表生产部署或网络故障消失。无终态且执行结果不明的请求继续拒绝自动重放，完整历史恢复继续遵循现有协议。

## 2026-10-26 · Codex 客户端身份与版本解耦（docs/06、07）

- **决定**：Codex 入站限制只匹配完整产品标记，忽略大小写；Desktop 的空格、下划线、连字符写法归为同一客户端。版本是可选的 HTTP token，不按数字、日期或 semver 判断准入，不维护版本白名单。
- **边界**：App 与 CLI 仍分别授权；未知产品、标记前后缀冒充、空版本、控制字符、超长 UA 和多客户端冲突继续拒绝。鉴权、模型列表过滤、路由、跨协议 fallback 和出站订阅身份不变，不迁移或改写现有 key 策略。
- **证据与限制**：报告的历史拒绝发生在模型发现，日志只保留 unknown_client，没有原始 UA，无法确认当时的具体格式；当前安装客户端的隔离模型发现请求能通过旧规则，因此不能把更新版本本身认定为已复现根因。新增回归证明已知产品名及版本格式变化不再误拒；不记录任意 UA 原文。
- **发布前置**（docs/10）：v0.30.53 按既有发布契约同步官方稳定客户端快照；Claude 2.1.310 的路由响应标记、签名与远程身份字段经静态检查后继续隔离，不扩大转发白名单。该出站快照更新与入站准入识别相互独立，详见 `docs/claude-protocol-safety.md`。
- **验证**：先确认新格式识别与 HTTP／流式 fallback 测试失败，再修改规则；覆盖模型发现、Realtime 鉴权、错误客户端、无效凭证和损坏策略，发布后使用临时受限 key 验证允许／拒绝边界。

## 2026-10-21 · DeepSeek 工具转换与完整历史恢复（docs/04、05、06、07）

- **根因与修复**：完整历史会把 Codex custom 工具改为 function；只有工具结果的下一轮缺少声明，原实现漏掉反向对应关系。按响应保存待转换工具名与未完成 call_id，续接恢复后同时转换输入结果、流式事件及终态 output；不删除真实工具结果。
- **持久化与隔离**：复用原响应的 key、账户、provider 和有效期约束。SQLite v55 / PostgreSQL v54 仅新增可空列；映射不含参数或结果，最多 256 个工具名和 1024 个未完成调用。各请求、分支独立复制，收到结果后移除对应 pending ID。
- **真实验收补充**：v0.30.50 实际已保存状态，但共享 messages pipeline 漏传到 InternalRequest，第二轮因此本地安全拒绝。后续补丁通过同一 Zod schema 校验并透传，新增 HTTP → pipeline → executor 的三轮 unary/streaming 集成回归和客户端伪造状态覆盖检查；需要真实线上续接验收后才算完成。
- **上游能力与最终修复**：真实原生 DeepSeek 请求即使指定 `store:true` 也返回 `store:false`，原生 function 工具仅携带结果和 `previous_response_id` 同样失败；映射恢复本身不足以支持服务端续接。DeepSeek 客户端在工具映射校验和网络发送前抛出可信 `response_create_not_sent`，WebSocket 桥复用 1012 断连恢复，让客户端重发完整历史；HTTP 客户端收到结构化错误后也需要重发完整 input。此恢复同样覆盖没有映射的旧响应，不猜测调用或重执行工具，其他提供方行为保持不变。
- **最终补丁验证**：先以缺失映射的 unary/streaming 增量请求复现错误，再验证 DeepSeek provider wiring 在零网络调用时返回可信恢复信号；完整历史保留真实工具结果。线上已证明完整历史三轮成功，最终版本仍需验证两次 1012 恢复及三轮结果。
- **验证边界**：回归覆盖三轮流式/非流式、重建客户端、并行分支、原生 apply_patch 结果保留、数据库持久化及 key 隔离、网关保存时机与真实执行器两轮续接。SQL 性能、数据一致性、安全三角色均批准旧迁移仅在隔离合成数据库中执行；生产已确认版本 54，只运行新增单表 ALTER。测试孤儿校验改用已有单表快照。

## 2026-10-20 · 图片串联客户端身份与明确拒绝（docs/05、06、07）

- **请求身份**：仅 `type: helm` 的 OpenAI 图片转发保留入站 User-Agent；按调用传递，不写入共享账号状态，不替换认证头，也不向第三方图像 provider 传递客户端身份。
- **错误边界**：上游明确返回 `403 client_not_allowed` 或 `404 model_not_found` 时保留状态和有限错误码，不泄露原始正文、不重试、不切换 provider、不计为熔断故障。真正结果不明的写入仍返回 `outcome_unknown`，保持单次发送。
- **配置限制**：Codex auto 模式严格跟随官方目录，不自动补图片工具模型。要使用 `gpt-image`，可在一个可调度账号的 manual 清单中明确加入 `gpt-image-2` 并保留原文本模型；该账号后续新增文本模型需手动维护。上游仍裁决实际支持，不从套餐推断图片权限。
- **图片驱动模型**：移除已被上游拒绝的固定 `gpt-5.4-mini`，使用 `HELM_CODEX_IMAGE_CONTROLLER_MODEL`（默认 `gpt-6-luna`），由 Zod 验证；与图片工具模型 `gpt-image-2` 分开，切换驱动模型无需改代码。
- **发布前置**（docs/10）：v0.30.49 同步 Claude 2.1.304、Codex 0.163.0 与同 tag 目录、Grok 1.0.62；Claude 经完整性校验及独立静态审核，保留原生项目归因但不扩展头白名单。审核限制见 `docs/claude-protocol-safety.md`。
- **正式链路补充**：Luna 官方目录标记 `use_responses_lite=true`，通用 Lite 转换会移走顶层图片 `tools`，上游返回 400。Images API 强制标准 Responses 方言并保留其余目录元数据；文本路径继续遵循目录。新增生成/编辑回归，确保工具、tool_choice 与请求头一致。

## 更早历史总览

2026-10-15：订阅时区只改已验证环境字段，保留工具／正文语义、账号代理和续接隔离；完整记录见 git history 与 docs/subscription-timezones.md。

2026-10-14 模型目录超时与 Helm 串联握手的边界保持原有约定；完整记录见 git history。

2026-10-14：原币媒体价卡覆盖 25 个模型、57 个分档，保留原币和地域语义，未扩展结算或汇率换算；完整记录见 Git 历史及 docs/media-pricing.md。

2026-10-14：阿里与 MiniMax 媒体任务保留异步 operation ID、权限与下载边界；真实验收修正 Qwen3 OSS HTTPS 和固定 IP 连接，详见 Git 历史及 docs/media-provider-task-tracker.md。

2026-10-14：Ark 多媒体按提供商契约处理图片/视频/语音输入、费用与异步任务，任务身份和数据边界不变，完整实现决定见 Git 历史。

2026-10-13：API key 客户端策略在鉴权后按入口校验，模型发现按家族过滤；损坏策略拒绝且保留账号、权限与续接隔离，UA 不作为可信身份，完整范围与决定见 Git 历史。

2026-10-12：Grok 价格目录按官方模型卡区分缓存与高上下文档位；媒体费用与历史重计价仍按既有边界处理，完整记录见 Git 历史。

2026-10-12：Grok 固定首尾帧与声线组合只扩展明确支持的参数约束，不推断上游账号支持；完整规格与客户端快照决定见 Git 历史。

2026-10-10：Claude 套餐只取官方 profile 并缓存，凭证变化失效；该展示不影响权限和调度，完整记录见 Git 历史。

2026-10-09：Claude 协议与 OAuth 账户边界的完整决定保留在 Git 历史中；现有协议、凭证和权限约束继续有效。

2026-10-07：发布时同步订阅客户端版本，保留官方版本检查、可追踪快照及发布前验证（完整记录见 Git 历史）。

2026-10-01：Helm 级联握手协商结构化 before-send 恢复，保留冷却时间与不明结果禁止重放边界；完整记录见 Git 历史。

2026-09-30：Codex 连通性测试复用账号运行配置、客户端版本和持久身份，合成端点验收通过；详见 Git 历史。

2026-09-30：Codex 账号详情只展示周额度周期，完整背景见 Git 历史。

2026-09-30：GPT-6.1 Sol 接入与 Sol 配置迁移；旧 GPT-6 Sol lane 指向新模型，具体协议与发布证据见 Git 历史。

2026-09-29：Claude Sonnet 5.5 接入；完整变更与验证见 Git 历史。

2026-09-28：原生透传取消模型准入名单，兼容规则归入 capabilities 配置，保留边界校验；完整记录见 git history。

2026-09-28：GPT lane换代、线上配置保留及别名回收；完整部署边界见git history。

2026-09-28 的 GPT-6 Sol / Luna 接入与目录兼容记录已归档于 Git 历史。

2026-09-27：原生辅助接口兼容、重放边界和计数路由权限补修；完整记录见 git history。

2026-09-26：Admin UI 走查整改、DeepSeek 零余额 key 验证兼容与请求详情路由导出修复；完整记录见 git history。

2026-09-26：Portal 用量、请求详情与布局审计，复用 key 隔离数据源，缺失字段兼容及真实页面验证；完整记录见 git history。

2026-09-26：DeepSeek fallback 保留 opaque reasoning 降级，request-contract mutation ledger 回写执行器；未据此宣称历史上游 400 已修复。完整记录见 git history。

2026-09-26：订阅重连复用 OAuth 流程及原账号代理、标签，解密和账号匹配失败时拒绝，详见 Git 历史。

2026-09-25：Claude OAuth 手动重置额度，含组织/额度校验、二次确认、结果不明禁止重试与权威读回，详见 Git 历史。

2026-09-25：Replay 分块落盘、已接收请求防重放与响应内存边界，详见 Git 历史。

2026-09-24 · 流式累计内存与读取生命周期：累计预算覆盖协议/管理读取、完整终止语义及取消释放，保留原生 usage 与 key 隔离。完整记录见 git history。

2026-09-24 · Responses 内存准入与 Codex 恢复诊断：进程级并发上限默认关闭，保留 key 租约、公平排队、取消与预算边界，并增加无正文恢复诊断；生产启用须单独验收。完整记录见 git history。

2026-09-23 · Codex 整轮暂存与同账号恢复：可选缓冲整轮，严格限定同账号重放一次，保留取消/预算/容量和结果不明保护；上游可能重复计费，需独立线上验收。完整记录见 git history。

2026-09-23 · WebSocket 断线时保留已接收响应：先消费已到达的文本、工具和完成帧再报告断流；不自动重放已接收请求，保留容量和取消保护。完整记录见 git history。

2026-09-23 · 远端 Helm 建连重试与 WebSocket 降级：`UND_ERR_CONNECT_TIMEOUT` 加入严格连接错误白名单并复用两次短退避；首轮发送前 WebSocket 失败改走 HTTP/SSE（401/403/429、增量续接、发送后结果不明不重放）；保留带 continuation ID 的单条 `function_call_output`；自产错误移除与 `status` 冲突的 `status_code`。完整记录见 git history。

2026-09-23 · Claude Opus 5.5：新增原生 `anthropic/claude-opus-5-5`（1M 上下文/128K 输出），思考默认开启走 `output_config.effort` 五档；标准 $4/$20 每百万 token；旧 computer_20251124/强制工具/assistant prefill 不支持。完整记录见 git history。

2026-09-22 · Helm 上游通道转发：静态 `type: helm` + `target_provider_protocol: openai_responses` 复用 Responses 客户端并支持 WebSocket 续接；视频 lane 需显式 Helm provider；328 项定向测试通过，0.30.7 派生镜像验收。完整记录见 git history。

2026-09-22 · E2E 的 main 与 PR 使用同一隔离 runner（CI / 部署，docs/10）：完整记录见 git history。


2026-09-22：Grok 4.7 与 Build Fast 配置沿用订阅能力边界，按官方标准和长上下文价格计费，历史型号保留。

2026-09-21：WebSocket 降级到 HTTP 后禁止发送无法恢复上下文的增量 continuation；完整记录见 git history.

2026-09-19—20：DeepSeek 工具图片保留结构并有界压缩，缺失 reasoning 历史时关闭思考；Admin Responses 重放保留原生 carrier。分类器 Jev 有序回退复用总超时与严格校验。完整记录见 git history。

2026-09-18 Codex 短冷却在原账号等待，长冷却原样返回，禁止换账号和误触发重连；完整记录见 git history。

2026-09-18 OAuth 退出与刷新共锁，撤销缓存凭证并同步禁用 live pool，避免删除后刷新写回；完整记录见 git history。

2026-09-18 Grok 版本化 chat 别名进入稳定 lane，Imagine/video 按最长字面量区分；完整记录见 git history。

2026-09-18 DeepSeek 回放为缺少 call_id 的 function_call_output 使用非空 id，已有值保留；完整记录见 git history。

2026-09-18 Lite 将 DeepSeek 外源 reasoning 明文折入空 summary 并清空 content，已有 summary 和 OpenAI 密文不改；完整记录见 git history。

2026-09-18 Codex 回放前剥掉非 `gAAAAA` 外源 encrypted_content，保留可读正文，空项丢弃；完整记录见 git history。

2026-09-18 取消 Responses 默认首帧 15s 超时，保留 in-band 错误 fallback 与结果不明禁止重放；完整记录见 Git history。

2026-09-17 的外源 reasoning 缺明文时关闭 DeepSeek 思考、首字节超时、Lite reasoning、候选链解释、DSML 工具兼容、DeepSeek Responses、观测字段等记录已压缩，完整原文可从本次变更之前的 Git 历史回溯。

2026-09-06：Codex 模型发现使用上游 client_version 和可选 base_instructions；订阅模型自动/手动列表统一依据官方目录与数据库权威，完整记录见 Git history。

2026-09-05 Fable 5.1 目录/价格、2026-09-02 HTTP 结果不明禁止重放（保留明确拒绝的有界重试）、2026-09-01 超大历史发送前保护已并入历史；完整内容见基线 `8a7df80c6684b10bfa7ff7f4f07f237a92f95d58`。2026-08-30 及更早工作涵盖订阅图片/视频/TTS 的 entitlement、单写与价格边界，Responses HTTP/WebSocket 生命周期、发送前恢复证明、账号与 transport 亲和、超大历史与压缩，OAuth 模型发现、额度窗口、Retry-After、冷却、轮转和缓存，协议互译与 SSE/tool-call 保真、能力/价格目录、路由/分类/fallback/熔断，Memory observe/inject/反思/压缩/保留与并发治理，payload/session 分段持久化、失败记录、SQLite/Postgres 数据完整性与资源保护，Admin/Portal/i18n/可访问性、key 权限/预算/计量，以及构建、CI、Docker、发布和生产验收。具体默认值、兼容限制与历史实测均以对应提交为准；本次压缩前的完整条目可从基线 412c7cde02288d9b33d54a87f93b43925177b294 的本文件及 Git 历史回溯。

2026-09-21（docs/05、06、07）：Jev Decisions 独立协议面保留权限与请求数原子预留，强制无正文审计，采用 32 KB 请求、256 KB 响应与 30 秒上游边界。完整记录见 Git 历史。


2026-09-27 原生协议、缓存与重放边界修复保留发送后结果不明禁止重放、provider 字段保真及权限检查；完整记录见 git history。

2026-10-18 的订阅刷新期限与恢复规则已归入历史，完整记录见 Git history。
