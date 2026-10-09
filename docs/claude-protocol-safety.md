# Claude 协议兼容与账户边界

核验日期：2026-10-09。此文记录兼容性和授权边界，不承诺防止账号封禁。

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

发布/同步流程在写版本快照前要求：

1. 新发现的 Claude CLI 版本必须等于已审查版本。新版本不能通过单改生成文件获得“协议兼容”状态。
2. 官方平台包元数据的 integrity 必须与审核记录一致。同版本发布包发生变化也拒绝。
3. 离线构建验证审核记录格式；定向协议测试从记录读取字段清单，验证它们确实保留，同时验证凭证和未知秘密仍被删除。

这是一道人工协议审核门禁，不是自动逆向全部协议的工具。未来更新需先检查官方协议/发行资料和经完整性校验的发布包，更新审核记录与有意义的请求/SSE 回归用例，再运行 `pnpm sync:client-versions`。不要绕过门禁或自动扩大信任列表。现有固定版本快照可继续离线构建；需要最新版本的发布会执行上述独立检查。

验收以定向 mock 请求、凭证持久化、账户池、外层 fallback 和流式回归为准。不使用真实被封账号做重复探测，不把单次成功请求或测试通过视为生产账户安全证明。

本次本地验收：11 个定向测试文件、652 项测试通过；core、gateway、客户端同步脚本类型检查通过；修改范围的 Biome 检查以及 shared/core/gateway 构建通过。离线版本快照校验、官方 2.1.295 平台包元数据完整性复核通过。以上为本地验证记录，远程 CI 与部署状态需分别核验。v0.30.38 发布准备已运行 `pnpm release:prepare 0.30.38`，将 Claude Code 固定快照同步至已审查的 2.1.295，同时按发布契约同步 Grok 1.0.50、Codex 0.162.0 及同 tag 模型目录。
