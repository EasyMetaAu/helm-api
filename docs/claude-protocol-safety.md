# Claude 协议兼容与账户边界

核验日期：2026-10-12。此文记录兼容性和授权边界，不承诺防止账号封禁。

## 使用范围

官方 [网关指南](https://code.claude.com/docs/en/llm-gateway#subscriptions-and-gateways)允许未修改的 Claude Code 在仅设置 `ANTHROPIC_BASE_URL` 等场景下继续使用用户自己的订阅登录。不能由“经过代理”直接认定违规。

这与 Helm 保存订阅令牌、替换鉴权、聚合账户并服务任意客户端的行为不同。官方 [认证与凭证规则](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)限制第三方收集/保存/中转 Claude.ai 凭证和代用户中转订阅使用。通用产品集成应使用 Anthropic API key 或官方支持的云服务。

本次修复不扩充官方身份模拟。现有转换路径仍包含旧的 Claude Code system、UA 和 CCH 兼容逻辑，因此不能把这些修复视为该接入方式获得官方授权。也不建议通过改时区、复制指纹或伪造归因字段来应对封禁。

## 账户身份校验与迁移

OAuth 登录与刷新从认证响应的 `account.uuid` 保存 `anthropicAccountUuid`。组织 UUID、Helm 内部账号名称以及客户端自行填写的值均不能充当验证来源。现有令牌存储支持 metadata，无数据库结构迁移。

刷新未携带账户信息时保留已验证 UUID；响应明确变更账户时拒绝采用新凭证，并按永久凭证故障处理，要求重新连接。不会把异账户的新令牌写入原账号记录。

原生或转换请求中，`metadata.user_id` 的 JSON 字符串含非空 `account_uuid` 时：

- 账户池先仅选择已验证 UUID 匹配的账户；匹配账户不可用时不会换到另一个 UUID。
- 最终发送前先取得当前凭证，再读取身份核对。JSON、SSE、token counting、401 刷新重试共用此校验。
- 转换到 Anthropic 协议时保留原始账户声明，并单独携带到最终发送校验，不能被正文优化或兼容转换抹去。带明确账户声明的 Claude 请求禁止跨到其他协议，避免转换丢失身份后继续发送历史。
- 身份缺失、非法或不匹配时在本地拒绝。不会修改客户端 UUID/device/session 来掩盖不匹配，也不会把身份拒绝当成上游健康故障。
- 网关将身份拒绝返回为 `invalid_request`，停止外层模型/provider fallback；遥测没有虚构的上游 HTTP 状态。

**已有账号的迁移限制：**旧令牌记录可能没有账户 UUID。它们仍可读取，但带明确 UUID 的请求将被拒绝，直到重新连接或正常刷新返回真实账户 UUID。修复不会自动请求用户账户 profile，也不会自动操作线上账号。

空账户字段或普通 opaque `user_id` 保持兼容。它们不提供历史所属账户的证明，本次 UUID 校验不能宣称解决了所有无身份会话的跨账户历史隔离。API key 路径不套用订阅 UUID 规则。

## 请求头处理

Helm 使用 `fetch`，并没有使用 Claude Code 内嵌的 Stainless SDK。因此转换路径不再自行生成 `X-Stainless-*`：此前 package version 使用 CLI 版本、OS 未按 SDK 枚举规范化、timeout/retry 写固定值，均不能准确描述实际 SDK 行为。真实原生客户端提供的 SDK 字段继续保留。

原生客户端提供的 `anthropic-version`、`anthropic-beta`、`x-app` 保留原值。缺失字段仍使用既有 provider 默认值；beta 不再被静默加入另一组值。网关主动改写正文所需的协议扩展仍须由调用方和配置正确声明，不能把这解释成任意正文改写都安全。

本次明确审查并加入以下可选字段。只转发实际收到的值，不补造值：

| 字段 | 用途及边界 |
|---|---|
| `x-claude-code-prompt-id` | 关联一个 prompt，可与正文归因信息对应。 |
| `x-claude-code-request-class` | 区分 main、subagent、compaction、auxiliary 等工作类型；不推测缺失值。 |
| `x-claude-code-agent-type` | 区分内置、自定义或 teammate agent；可能透露工作流类型。 |
| `x-claude-code-compaction` | 压缩相关请求标记。 |
| `x-claude-code-context-compacted` | 上下文压缩相关状态。 |
| `x-claude-code-prev-tool-durations` | 前一轮工具耗时信息，用于请求关联/诊断。 |
| `x-client-app` | 实际调用应用的归因，不改成官方应用名。 |
| `x-anthropic-additional-protection` | 官方客户端在对应环境选项启用时请求额外保护；服务端精确语义未公开，不应删除它来减弱保护。 |

这些字段不是官方公布的“防封秘钥”。[协议兼容指南](https://code.claude.com/docs/en/llm-gateway-protocol#request-headers)允许网关消费一些 session/agent 关联信息；不能把缺失可选字段直接认定为封禁原因。

Helm 可能把请求路由到第三方 relay，因此仍保留凭证/租户隔离和已审核字段白名单。未知 `anthropic-*` 不会因为名字相似就自动信任；这比官方针对受信 Anthropic 上游建议的开放字段列表更保守，是明确的兼容性限制。远程容器/会话、签名/attestation 等字段本次不自动放行。新增必要协议头需审查其目的地、凭证含义和隐私影响。

## 协议审核与发布门禁

`config/claude-protocol-review.json` 记录经检查的 CLI 发布版本、平台包 SHA512 integrity、二进制 SHA256、观测到的 SDK 版本和已审查字段。SDK 版本仅作为研究证据，不会被复制为 Helm 发出的身份。

本次审查官方 `@anthropic-ai/claude-code@2.1.295` 的 darwin-arm64 发布包，内嵌 SDK 为 `0.128.0`。二进制 SHA256 为 `0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70`；在本地下载包并核对 npm SHA512 integrity，且本机安装文件与官方二进制一致。分析仅使用可读内嵌 JavaScript，没有执行下载的 CLI，也没有访问账号。

2026-10-12 增量审查官方 `@anthropic-ai/claude-code-darwin-arm64@2.1.296`，核对 npm SHA512 integrity，二进制 SHA256 为 `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937`，内嵌 SDK 仍为 `0.128.0`。仅静态检查可读 JavaScript，没有执行下载的 CLI，也没有访问账号；此前 2.1.295 的安装文件一致性结论不延伸至此版本。

相较 2.1.295，新增 `x-claude-code-wiggly-dove`，由默认关闭的 `tengu_wiggly_dove` 开关控制，生成过程涉及 query/permission 上下文，并进入 default headers（已校验二进制偏移分别为 191091637、191095319、191106429）。服务端语义未公开，不能据此认定它是必要字段或可以向 relay 转发。Helm 保持白名单不变，继续删除该未知字段，不生成或仿造其值；定向测试明确验证删除行为。既有 `x-anthropic-additional-protection` 保留规则不变。这是已知兼容性限制，本次审核不证明完整的 2.1.296 协议兼容或生产账户验收。

2026-10-14 增量审查官方 `@anthropic-ai/claude-code-darwin-arm64@2.1.299`。下载包通过 npm SHA512 integrity 校验，二进制 SHA256 为 `ba5ab7b8c195fa03ab8d5bf3915c76153b576a2c40e79a5c46e265e7ed9744b3`，内嵌 SDK 仍为 `0.128.0`（偏移 197470796）。同时重新验证 2.1.296 包及二进制哈希并比较可读字段；全程只做静态分析，没有执行下载的 CLI 或访问账户。

- [官方发布记录](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21299)说明 Claude apps gateway 的归因块新增字段。二进制确认 `cc_gateway=1/env` 位于原生 system 归因文本（偏移 197364116）；Helm 原样保留客户端提供的文本，不生成或仿造该字段。定向测试验证原生正文保留。
- 相较 2.1.296，扫描到新增 `x-claude-code-upload-lane`；它出现在 OAuth `/api/oauth/file_upload` 的 multipart 请求头构造中（偏移 229306824），不是 Messages 请求的新增必需字段。Helm 不扩展上传接口或头白名单，定向测试验证该字段不会转发到 Messages 上游。
- `x-claude-code-wiggly-dove` 仍受默认关闭的开关控制（偏移 197792242），保护字段仍由客户端选项生成（偏移 197798438）。维持既有未知字段、远程租户凭证及签名隔离，不扩大信任边界。官方协议文档本次访问返回 403；以上增量结论基于官方发布记录与完整性校验后的包，不能视为完整协议兼容或生产账户安全证明。

2026-10-15 增量审查官方 `@anthropic-ai/claude-code-darwin-arm64@2.1.300`。重新核对 npm SHA512 integrity，二进制 SHA256 为 `475517caa611e3318a2f298fa071287ec98955538df78c58f709ecc01e5ae2d3`，内嵌 SDK 仍为 `0.128.0`（可读 JavaScript 偏移 198503091）。同时重新校验 2.1.299 包并比较 `x-claude-code-*`／`x-anthropic-*` 字符串集合，未发现新增或删除；字符串集合相同不等于完整协议相同，因此继续核对实际构造位置。

- [官方 2.1.300 发布记录](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21300)包含遥测、代理与会话修复；Helm 不复制客户端遥测，不扩展信任头白名单。`x-claude-code-upload-lane` 仍位于 multipart 上传头构造（229385806）；`x-anthropic-additional-protection` 仍由客户端配置生成（198874727）；`cc_gateway` 仍位于 system 归因文本（198333610）。原生保留／未知字段删除策略及其定向回归保持有效。
- 本次环境时区检查确认 user 消息中的日期 reminder、Codex 环境块与 Grok 日期前缀；相关转换只作用于已验证环境字段。Claude `output_config.timing.now` 实现受 `nr.CLAUDE_CODE_PER_TURN_TIMING` 控制（197473594），调查制品中未启用，不据此增加 beta 或伪造字段。完整边界见 `docs/subscription-timezones.md`。
- 全程只读取官方发布材料及二进制中的 JavaScript，没有执行下载的 CLI、访问账号或扩大凭证转发范围。此审核不是完整协议兼容或账号安全保证。

2026-10-20 增量审查官方 `@anthropic-ai/claude-code-darwin-arm64@2.1.304`。平台包通过 npm SHA512 integrity 校验，二进制 SHA256 为 `b9ac5374839f14abf3f1f45610637c332b5daee5ce0d1634726cef87aab78e6a`。与重新校验的 2.1.300 比较，内嵌 SDK 仍为 `0.128.0`（JavaScript 字节偏移 218950886），可读 JavaScript 中三组 Claude/Anthropic/remote 请求头名称集合未变。整个二进制中的新片段 `x-anthropic-E`（105103616）没有可读请求头构造证据，不加入白名单。

- [官方 2.1.304 发布记录](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21304)与静态构造确认原生 system 新增 `cc_project`、`cc_project_src`（218853298），受有效 tagged ID/source 和功能开关约束。Helm 仅保留实际客户端文本，不生成这些归因；既有原生正文测试补充精确保留验证。
- 自定义 `ANTHROPIC_BASE_URL` 默认启用 tool search，并可在部分 400/422 后回退（226461352）；context management 拒绝后的恢复与条件请求字段位于 225255814、226496158、226477254。沿用现有请求往返与流式回归，不新增网关重试或推断能力。
- 保护字段（219295838）、远程标识（219294800–219295470）、默认关闭的未知遥测（219284320）、上传字段（250585538）边界保持不变。凭证、签名、未知和远程字段仍不放行；SSE 定向检查保留 text/citation/JSON-input/thinking/signature/compaction delta 分支（219137900），不声称完整等价。
- 审查全程只读官方制品，没有执行下载的 CLI 或访问账号。这是有限静态兼容审查；生产真实账号验收另行记录。

2026-10-21 增量审查官方 `@anthropic-ai/claude-code-darwin-arm64@2.1.306`：校验 npm SHA512 integrity 后，只读检查 ARM64 Mach-O 制品，二进制 SHA256 为 `b5d795b7760032d79954b55a9cd1876dcf3a8dc9608fd6bb9f618593f69fd44b`。重新校验 2.1.304 制品后，对比可读 JavaScript 中 19 个 `x-claude-code-*`、`x-claude-remote-*`、`x-anthropic-*` 引号内字段名，集合未变；内嵌 SDK 仍为 `0.128.0`（字节偏移 220250997）。

- [官方 2.1.305/2.1.306 发布记录](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21306)包含网关拒绝 tool search 后的客户端回退、MCP 工具较多时保留原始 API 错误，以及云会话凭证加载修复。静态构造确认客户端在对应拒绝后移除 deferred tools 重试，并记住该会话的拒绝状态（227776391–227777469）；Helm 不新增重试或推断上游能力。
- 保护字段仍由客户端选项生成（220596152），上传字段仍属于 multipart 上传（253627807），项目归因仍受有效 tagged ID/source 与功能开关约束（220140691）。继续只保留实际客户端提供的已审查字段和正文；未知遥测、远程身份与凭证字段不扩大放行。
- SSE 静态分支仍包含 text、citation、JSON-input、thinking、signature 和 compaction delta（220436100–220437100）；沿用定向原生正文、请求头隔离、身份、流式与发布门禁回归。全程未执行下载的 CLI、未访问账号；以上是有限静态兼容审查，真实账户验收在发布后另行记录。

2026-10-26 增量审查官方 `@anthropic-ai/claude-code-darwin-arm64@2.1.310`：旧 2.1.306 与新包均通过 npm SHA512 integrity 校验；新二进制 SHA256 为 `ffb64331bc0ee1b69efb7c2c428bd3ab516bc31b75bf60886b356c97c1c25ffd`，内嵌 SDK 仍为 `0.128.0`（字节偏移 220268369）。仅静态读取公开发行制品，没有执行下载的 CLI 或访问账号。

- [官方 2.1.307–2.1.310 发布记录](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21310)包含自定义网关 beta 发送修正，以及 effort beta／对话中 system 消息被拒后的客户端回退。Helm 不据此新增重试、猜测能力或放宽协议字段。
- 引号内 `x-claude-code-*`、`x-claude-remote-*`、`x-anthropic-*` 字段从 19 个增至 20 个。新增 `x-claude-code-route-final-answer` 在路由错误处理中读取响应头（220610170、227886520），并非新增的必需推理请求身份；Helm 不生成或新增转发。
- 扩大到所有引号内 `x-*`／`anthropic-*` 字符串的比较后，另见自托管来源 IP／签名（220626950）、runner capability（230494649）、MCP（256874603）、工具隧道（238689235）和账号设置 OS 标记（236224544）；均不进入 Messages 入站头白名单。新增定向测试验证这些字段仍被剥离。另有额度响应状态字符串及 signed-key 脱敏规则 ID，不能误当成推理身份头。
- 保护字段仍由客户端配置产生（220629824），上传 lane 仍属于 multipart（249608217），gateway／project 归因仍留在原生 system 文本（219983990）。SSE 文本、citation、JSON-input、thinking、signature、compaction 分支仍存在（220467150–220470700）。保留已有原生正文、身份隔离、协议和流式测试；本次有限静态审查不表示支持全部新客户端功能，也不能替代真实账户验收。

2026-10-27 增量审查官方 `@anthropic-ai/claude-code-darwin-arm64@2.1.311`：旧 2.1.310 与新平台包均通过 npm SHA512 integrity 校验，新二进制 SHA256 为 `85d8c08707fcfd1e78ffa0204eefbc6ec9e4fe22f375fb2767ef85d957ed3161`，内嵌 SDK 仍为 `0.128.0`（字节偏移 221636107）。独立只读审查使用官方制品与可读 JavaScript，没有执行下载的 CLI 或访问账户。

- 新增 `x-claude-code-sandy-plover` 是受 feature gate、first-party 条件限制的 `/v1/messages` 工具使用列表（222016494、222052661），并非已证实的必需身份。`x-cowork-enrollment` 来自 host launch 配置（217098680、222045647），服务端契约未知。两者继续剥离，不生成替代值。
- `x-ccr-upload-attempt` 属于远程 worker 上传（244144107、244178178）；`x-gateway-upstream-cloud-request-id` 是网关从 `apim-request-id` 派生的响应关联字段（247456573），均不加入推理入站头白名单。新增四个定向剥离断言，已审查可信字段清单不扩展。
- 账号归因构造（旧 223417922–223418611／新 224732589–224733278）、保护字段（222035212–222035673）及 SSE 文本、citation、JSON-input、thinking、signature、compaction 分支（221868377–221869917）在审查片段中结构一致。保留既有账号隔离和流式测试；有限静态审查不证明全部客户端兼容，也不代替真实上游验收。
- [官方发布记录](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21311)中的 `x-should-retry:false`、隐藏推理空闲检测和断连说明，不构成本次修改 Helm 重试或协议策略的理由。

2026-10-28 增量审查官方 `@anthropic-ai/claude-code-darwin-arm64@2.1.312`：下载包通过 npm SHA512 integrity 校验，二进制 SHA256 为 `6b5ec691195e551b02c41df9f7d723f4ea61eaa03c2df90acefe3736f1aeb620`，内嵌 SDK 仍为 `0.128.0`（字节偏移 221854498）。复核旧 2.1.311 哈希，并由独立只读审查核对以下路径；未执行下载的 CLI 或访问账户。

- 新增 `x-ccr-ticket-rev`、`x-ccr-ticket-session`、`x-ccr-ticket-seq`（244312476、244312495、244312518）来自远程 worker 响应。票据缓存随 Authorization 改变而清除，并在 worker 的 `sessionBaseUrl` 请求上注入（244353867）；没有证据表明它们是 Messages 必需身份。保持头白名单不变，补充三个剥离断言。
- 账号归因构造（225045363–225046052）、额外保护字段（222254813）以及 Messages 请求主体（229525700–229526650）在已检查片段中保持原有结构；不复制票据或扩大身份模拟。
- SSE 发出与累积逻辑（222087080–222091053）仍处理文本、citation、工具 JSON 增量、thinking、signature 和 compaction，并保留压缩块的 `encrypted_content`。未发现需要修改协议实现的新增 P0/P1 问题；有限静态片段不覆盖动态展开的全部字段，也不能代替真实上游验收。

2026-10-30 增量审查官方 `@anthropic-ai/claude-code-darwin-arm64@2.1.314`：新旧 2.1.312 平台包均通过 npm SHA512 integrity 校验，新二进制 SHA256 为 `21d6e7b9a6f07b4cfcb7df13760b3b72aa25e084e13a5354413382987ba832ed`，内嵌 SDK 仍为 `0.128.0`（字节偏移 224763582）。独立只读审查仅检查官方公开制品，没有执行下载的 CLI 或访问账户。

- 新增 `x-ccr-ticket-mcp`（255525974）属于按 URL、Authorization 与 10 秒有效期绑定的 MCP 票据；`x-ccr-sse-long-poll-seconds`（247030078）读取远程 SSE 响应设置；`x-served-file-page-count`（257850208）读取附件页数；`X-Amzn-Bedrock-Trace`（249952410）属于已配置网关的 Bedrock 护栏诊断。这四个字段均不加入 Messages 信任白名单，身份边界测试显式验证剥离。
- 账号归因构造（227901174）、主 Messages 请求的 metadata 调用（232376714）、附加保护头（225150743）以及 SSE 发出与累积分支（224980287–224984270）在审查片段中保持原有结构，包括 compaction 的 `encrypted_content`。未发现需要调整 Helm 协议实现的 P0/P1 问题；有限静态审查不代表全部 CLI 行为一致，也不替代真实上游验收。

发布/同步流程在写版本快照前要求：

1. 新发现的 Claude CLI 版本必须等于已审查版本。新版本不能通过单改生成文件获得“协议兼容”状态。
2. 官方平台包元数据的 integrity 必须与审核记录一致。同版本发布包发生变化也拒绝。
3. 离线构建验证审核记录格式；定向协议测试从记录读取字段清单，验证它们确实保留，同时验证凭证和未知秘密仍被删除。

这是一道人工协议审核门禁，不是自动逆向全部协议的工具。未来更新需先检查官方协议/发行资料和经完整性校验的发布包，更新审核记录与有意义的请求/SSE 回归用例，再运行 `pnpm sync:client-versions`。不要绕过门禁或自动扩大信任列表。现有固定版本快照可继续离线构建；需要最新版本的发布会执行上述独立检查。

验收以定向 mock 请求、凭证持久化、账户池、外层 fallback 和流式回归为准。不使用真实被封账号做重复探测，不把单次成功请求或测试通过视为生产账户安全证明。

2026-10-09 本地验收：11 个定向测试文件、652 项测试通过；core、gateway、客户端同步脚本类型检查通过；修改范围的 Biome 检查以及 shared/core/gateway 构建通过。离线版本快照校验、官方 2.1.295 平台包元数据完整性复核通过。以上为本地验证记录，远程 CI 与部署状态需分别核验。v0.30.38 发布准备已运行 `pnpm release:prepare 0.30.38`，将 Claude Code 固定快照同步至已审查的 2.1.295，同时按发布契约同步 Grok 1.0.50、Codex 0.162.0 及同 tag 模型目录。


## 账号套餐显示

管理后台从官方 `GET /api/oauth/profile` 的 `organization.organization_type` 读取每个账号的套餐，显示 Pro、Max、Team 或 Enterprise。没有有效返回时显示“套餐未知”，不根据使用额度、邮箱或模型列表推断。请求使用该账号的代理及凭证，不改变请求路由身份。

点击账户列表的刷新按钮可重新核验。列表本身只读取持久缓存，不触发上游访问；标签悬停提示最近核验时间。凭证变化使旧缓存失效，刷新失败清除旧套餐显示。历史缓存代表最近一次成功读取的套餐，不代表实时账单状态。
