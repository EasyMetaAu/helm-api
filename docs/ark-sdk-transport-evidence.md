# T02：Ark SDK 传输交付证据

日期：2026-10-14。状态：**独立交付可供主控集成审查**，不代表整体功能、CI 或生产验收完成。

- 基线：`f0d962692f97b18fb8ed118c3c1991fbfe0d1770`。
- Codex 托管工作区：`/Users/lukin/Projects/.worktrees/ark-media-transport/helm-api`。
- 分支：`codex/ark-media-transport`；所有成果未提交。
- 固定依赖：`openai@7.33.0`，包声明支持 Node `>=22.0.0`；本轮实际执行 Node `v26.5.0`、pnpm `10.25.0`。未单独运行 Node 22 二进制。
- 全部请求均为离线 mock，未访问 Ark、未读取真实凭证、未产生付费请求。

## 已交付接口

`packages/core/src/provider/ark.ts` 导出 `createArkMediaClient(deps)`，直接复用 `OpenAIClientDeps`、`ProviderConfig` 与 `ProviderCallOptions`。不实现聊天接口，不修改已有 provider 或公共 exports。

| 方法 | SDK 调用 | 上游路径 |
| --- | --- | --- |
| `imageGeneration(body, opts?)` | `images.generate(...).asResponse()` | `POST /images/generations` |
| `videoGeneration(body, opts?)` | `post(...).asResponse()` | `POST /contents/generations/tasks` |
| `threeDGeneration(body, opts?)` | `post(...).asResponse()` | 同上 |
| `videoRetrieve(id, opts?)` | `get(...).asResponse()` | `GET /contents/generations/tasks/{encoded id}` |
| `threeDRetrieve(id, opts?)` | `get(...).asResponse()` | 同上 |

输入及输出均为记录对象，保留 Ark 原始字段。测试覆盖两个 Seedream 模型及 Seedance/Seed3D fixture 的完整 body，图片图层信息、usage、task id/status、video_url/file_url 不归一化。schema、模型选择、任务归属及计费由主控接入。

## SDK 依据与边界适配

采用已下载的官方 npm 包 `openai@7.33.0`（Apache-2.0），无需复制官方实现。可在安装后的包目录或研究目录 `node-sdk-probe/node_modules/openai/` 核查：

- 官方 [OpenAI Node SDK README](https://github.com/openai/openai-node/tree/v7.33.0#readme)，本地 `README.md:606–612`：`.asResponse()` 不读取成功响应正文。
- 同一 README 本地 `696–726`：文档支持 `client.post/get` 自定义路径及额外 body 字段；SDK 不按 TypeScript 类型做运行时字段裁剪。
- `src/resources/images.ts:88–105`：`images.generate` 使用标准 SDK POST，保留 body；其 `ImageGenerateParamsBase.prompt` 静态类型为必填，Ark 图层拆分允许省略。仅在 SDK 调用处作局部 `unknown` 类型转换；离线测试证明没有填充或丢弃字段。
- `src/client.ts:1829–1911`：SDK 会在 HTTP 非 2xx 时自行读取 `response.text()`，即使调用方使用 `.asResponse()`。因此错误体必须在注入的 fetch 内先消费；用每次请求私有变量保存结构化错误，避免 SDK 包装后泄露原始 cause。

成功响应与 HTTP 错误均调用 Helm 既有 `consumeResponseTextWithinBudget`：读取过程计数，Content-Length 仅用于提前拒绝，JSON 解析仍在共享 lease 内。成功上限来自 `ResponseWorkAdmission.capacityBytes`；错误上限为其与既有 64 KiB 错误预算的较小值。容量占用、伪造长度、无长度、超限和中止都会 fail-closed，并释放本次 lease。超时覆盖 fetch 和响应体读取。

SDK 客户端与每次调用均设置 `maxRetries: 0`；不调用连接重试、过载重试、401 刷新或 fallback。`redirect: manual` 防止付费重放和跨目标转发 Authorization；实际目标必须等于配置 base URL 与固定 endpoint 拼接结果。受控 `deps.fetch` 原样保留代理 dispatcher，`resolveBaseUrl` 视为主控注入的可信配置。HTTP 代理测试使用真实 `makeProxyFetch` 与 mock undici fetch，没有建立代理连接。

凭证只从运行时 config 注入，extraHeaders 不能覆盖最终 Authorization。错误保留已脱敏 Ark body 和安全 headers，已发送 bearer、static key、`currentSecrets` 中的 refresh/access token 均替换；丢弃原始 SDK cause。SDK `logLevel: off` 明确覆盖环境 DEBUG 设置。`captureUpstream` 得到 SDK 实际序列化的正文，观察器异常 fail-open；`onResponseMeta` 收到安全且已脱敏的 headers。

## 错误结果与集成约束

`ArkMediaError` 继承现有 `UpstreamError`，保留 `errorClass`、`httpStatus`、`upstreamStatus`、`providerRaw` 与 `upstreamHeaders`，额外提供 `outcome`：

| outcome | 含义 | 示例 |
| --- | --- | --- |
| `not_sent` | 未进入受控 fetch | 本地校验失败、预先取消 |
| `rejected` | 完整读取了明确 HTTP 4xx 拒绝，408 除外 | 400、401、403、429 |
| `unknown` | 已进入 fetch，不能证明创建失败 | 408、5xx、重定向、断连、超时、正文超限/读失败、畸形成功响应 |

客户端取消以 `name: AbortError` 的错误返回，携带上述 outcome，丢弃可能含凭证的调用方 reason，保持“客户端断连不是 provider 故障”的边界。即使已收到成功 headers，只要正文未可靠读完，创建结果仍是不明。

主控集成时必须：

1. 增加必要 exports/provider composition，将 T01 schema 校验后的记录传入本客户端；传入已配置代理的 fetch 与共享 response admission。
2. 对媒体创建禁用 Helm 外层 fallback/retry，不因 `UpstreamError`、503 或 `outcome: unknown` 自动重发。明确拒绝也不会由本客户端重试；GET 默认同样单次尝试，轮询节奏由网关负责。
3. 负责模型 allowlist、请求体准入、所有权/账号绑定、task normalization、预算校验与公开错误映射；本层不解释 `id`、`status` 或新增公共状态定义。
4. 将本节关键决定按需汇入根 `implementation-notes.md`。按写入契约，本任务未修改该文件及中央台账。

## 红绿验证

研究目录：`/Users/lukin/Documents/Codex/2026-10-14/helm-seedance-research/`。日志均在该目录，未纳入源码。

- 红：`CI=true pnpm exec vitest run packages/core/src/provider/ark.test.ts`。先写测试，`t02-red.log` 记录缺少 `./ark.js` 导致 suite 失败，随后才创建实现。
- 绿：同命令，`t02-green-final.log`：**37/37 通过**，1 个定向文件，约 0.7 秒。含全部路径、字段保真、503/超时/连接失败每次仅 1 次、取消前后、畸形响应、成功/错误超限、占用准入、动态脱敏、代理传递及零 SDK 日志。
- 类型：`CI=true pnpm --filter @helm/core typecheck`，`t02-typecheck-final.log`，通过。
- 格式/lint：`pnpm exec biome check --write packages/core/src/provider/ark.ts packages/core/src/provider/ark.test.ts`，`t02-lint-final.log`，最终无修复、无诊断。
- `pnpm install --frozen-lockfile` 通过；lockfile 最终仅增加 openai importer、package 与 snapshot，未升级其他依赖。
- `git diff --check` 通过。Vitest 因未生成 admin `.svelte-kit/tsconfig.json` 有提示，不影响本轮 node 定向套件；没有运行 UI 或全仓测试。

日志 SHA-256：

```text
e2bf088abdb4669a8266f757b9ce64fd2f5670a43da9302ac60c265b14c20775  t02-red.log
b13b55a733c51c9fa1081f81226f6dec0f129f5c602df41a38d4c22ceb533c70  t02-green-final.log
2808cbbee9f07e54a25c8395ab06272fc69770af6c2cfeb24a0ce9f8d81b6ef0  t02-typecheck-final.log
25147e6f4a722df9fb652be4e9574ae396d13c6b081ca936e39e92b15250e70a  t02-lint-final.log
```

## T03 判断

**本次范围不触发 T03。** 图片接口及 task create/get 都能由兼容 SDK 与文档支持的扩展调用完成。已证明的差异是静态类型和错误体读取边界，可用局部类型桥接及 Helm 既有有界读取器解决；没有证据表明需要另写方舟协议实现、复制官方 SDK 或增加 Python/Go 服务。真实上游生成、计费和网关端到端验收仍由后续任务完成。
