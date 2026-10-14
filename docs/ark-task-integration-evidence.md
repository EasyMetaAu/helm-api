# Ark 视频与 3D 任务路由：T06/T07/T10 独立交付

日期：2026-10-14。状态：**本地定向交付完成，待主控装配与整体验收**。没有生产、付费或外部网络调用。

## 工作区与依赖

- 工作区：`/Users/lukin/Projects/.worktrees/ark-media-transport/helm-api`。
- 分支：`codex/ark-media-transport`。
- 已有 T02：`b22ed646158d5085019de478a408a979c8f06403`。
- 已 cherry-pick T01 `b801e18b529e1840c58fcea7d4714dc69cbec91e`，本地对应 `90c853507b03b7899c4dbd50d870bf16b46e37d8`。主控已有原始 T01，只需 cherry-pick 本轮路由提交，不要重复合入该本地 T01 提交。
- 写入范围：`videos.ts/test.ts`、`three-d.ts/test.ts`、小型任务绑定/归一化 helper `ark-media-task.ts` 和本证据文件。没有修改 server、shared、barrel、ProviderClient、配置或台账；T02 传输无需新增修改。

## 主控装配接口

`VideoCreateTarget` 在原有字段上新增：

```ts
providerType?: "ark";
laneName?: string;
registryTtlMs?: number;
```

- Ark target 必须设置 `providerType: "ark"`，`providerModel` 是真实 wire ID；`providerAlias/providerName/providerAccount` 为最终选中的持久身份。
- `laneName` 只在通过 lane 解析时提供，值为实际请求 lane。`seedance-video`、`seed3d` 是本期支持 lane 名；alias 和 wire ID 不填此字段。lane 会受 `identity.caps.allowedLanes` 限制，空列表表示无许可。Ark 直连 alias/wire ID 均要求 `allowCustomModel: true`；不再只看是否包含 `/`。
- `registryTtlMs` 默认 7 天，Ark 显式提供更短或非安全整数的值会在付费创建之前拒绝。旧 Grok 保留原来的 24 小时规则。
- `client.create(body, signal, onAccountSelected?)` 原样返回 Ark `{id}`，禁止在 resolver/client wrapper 添加 retry/fallback；如实际账号后选，调用 `onAccountSelected`，先持久化账号再创建。

`VideosRouteDeps.resolver.poll(record)` 现在返回：

```ts
{
  providerType?: "ark";
  providerModel?: string;
  retrieve(upstreamId: string, signal: AbortSignal): Promise<Record<string, unknown>>;
} | null
```

Ark poll 必须设置 type 和与持久记录一致的 wire model，并按记录中的 providerName/providerAccount 选择原 provider/凭证身份；route 会把持久化上游 task ID 交给 retrieve，绝不会把公共 UUID 传给 Ark。

3D 入口：`registerThreeDRoute(app, deps: ThreeDRouteDeps)`，deps 类型与 VideosRouteDeps 相同。主控将 `client.create` 接到 `threeDGeneration`，`retrieve` 接到 `threeDRetrieve`。路径为 `POST /v1/3d/generations`、`GET /v1/3d/:requestId`；没有 3D extensions。视频仍使用现有 `/v1/videos/generations` 与 `/v1/videos/:requestId`，旧 Grok extensions 保留。

共享的 `registerMediaTaskRoutes` 只是现有视频 admission、reservation、telemetry、budget 与 poll 流程的有限复用，不是新的通用任务系统。

## 必须由主控完成的公共导出切换

按独占范围，本任务不能改 shared barrel。`ark-media-task.ts` 暂时从 `../../../../packages/shared/src/request/ark-media-schema.js` 直接读取 T01 的独立 schema，方便离线测试验证真实契约。

**主控导出 T01 的 schema 后，必须把这一处 import 改为 `@helm/shared`。** 当前标准 gateway typecheck 会仅因该跨包源文件触发 TS6059 `rootDir` 限制；这不是通过完整仓库构建的交付。使用 `--rootDir ../..` 的有界类型检查已通过，证明本轮代码的其他类型均正确。主控应在切换 import 后运行正常 typecheck/build 与 HTTP/SQLite 测试。

所需 exports：`ArkTaskCreateResponseSchema`、`ArkThreeDGenerationRequestSchema`、`ArkThreeDRetrieveResponseSchema`、`ArkVideoGenerationRequestSchema`、`ArkVideoRetrieveResponseSchema`。

## 任务持久化方案

每个 Ark 创建返回独立公共 UUID，注册表查询键分别是 `video:{uuid}`、`three-d:{uuid}`。即使两个 provider 返回同一个上游 ID，也不会相互覆盖。创建预留键仍使用 `{kind}-create:{Helm request ID}`，预留、账号固定或最终映射失败时均不重发付费请求。

`ResponsesRegistryRecord.providerProtocol` 是封闭枚举，现有 SQLite/legacy parser 不接受任意字符串；`responseId` 又必须等于查询键，无法同时承载不可逆 UUID 和上游 ID。因此本轮选择**现有开放字符串 status 字段中的版本化绑定 envelope**，没有扩展记录字段，也没有篡改 provider 身份字段：

```text
status = "ark-media-task:v1:" + base64url(JSON.stringify({
  kind, publicId, upstreamId,
  providerAlias, providerName, providerModel, providerAccount,
  laneName, state
}))
```

这不是加密，内容不包含密钥。读取时用严格 Zod 校验，再核对公共键、任务类型、provider/模型/账号与记录字段一致。身份由现有 registry `getOwnedLive` 和 route 的 accountId/keyId 检查共同约束。查询必须先通过原 provider/model 绑定检查，随后才允许调用上游；返回结果还要匹配上游 `id/model`。修改终态时保留整个绑定和原 expiresAt。旧 Grok 的 status 字符串、上游 request_id 公开行为及映射结构不变。

注意：全局 registry 的现有 10,000 条容量清理策略仍可能提前回收记录。route 配置了 7 天 TTL，但不能在本独占范围内保证全局容量压力下的 7 天完整保留；主控需评估该既有清理边界。后续 registry 迁移如引入专门任务表，应明确迁移 envelope，不能直接把 status 重写成 `done` 而丢失上游身份。

## 响应、时效与隐私

- 创建仅接受严格 `{id}`；如缺少 ID、ID 无效、映射失败或创建超时/断连/5xx，返回 `outcome_unknown`，不重试。T02 标记 `outcome: rejected` 的确定 4xx（408 除外）返回同一 HTTP 状态与安全 `upstream_rejected`，不转发原始错误文字。
- 查询状态：`succeeded → done`、`running → in_progress`、queued/failed/cancelled/expired 保留。未知状态 fail-closed。所有查询结果均校验 provider model 与 task ID。
- video 成功返回 `video: {url}`；3D 成功返回 `file: {url, format: "zip", model_format: "glb"}`。该 URL 指向 ZIP，GLB 在包内；本次没有下载文件或验证 ZIP/GLB 内容，不能作为真实生成验收。
- T01 的 error 已允许 null；真实 failed/cancelled 响应中的 `content:null`、`usage:null` 在验证前仅按已知可选字段处理为空值，不接受任意结构。3D `expired` 使用与 cancelled 相同的无产物验证，再恢复 expired 公共状态；未改写 shared schema。
- `failed` 必须有结构化 error。仅允许公共错误码 `SetLimitExceeded` 原样表达，其 message 改为固定安全文字；其他错误统一 `task_failed`，防止凭证、prompt 或上游内情泄漏。
- 产物链接期限与任务期限分开：按 `updated_at` 秒时间戳计算 24 小时有效期，缺少该时间时保守使用任务创建时间；过期或未来时间不返回 URL，输出 `expired/artifact_expired`。`artifact_expires_at` 使用 epoch 毫秒。不会下载或刷新链接。
- 正文仍仅由既有 payload capture 机制控制。常规 telemetry/log 不写 raw response/error；上游 task ID 在 DecisionRecord 中保留 SHA-256 引用。

## 权限与费用

复用 auth、clientPolicy、rate/concurrency、body memory admission、budgetGate 与 settled requests 逻辑。创建及查询均检查相关 blockedModels；Ark 持久 lane 还会在查询时重新检查 allowedLanes，direct task 重新检查 allowCustomModel。

视频/3D 在可靠金额计价不可用时，对正 spendUsd 上限直接返回 422 `media_pricing_unavailable`，发生于任何 reservation/create 之前。成功创建只结算一个 request，`costUsd:null` 明确表示未知；GET 不再次结算、不把异步 usage 当创建时费用。图片预算由另一工作项和主控负责，本提交不声称完成三类费用的整体验收。

## 红绿和检查证据

日志目录：`/Users/lukin/Documents/Codex/2026-10-14/helm-seedance-research/`。

1. `t06-red.log`：先添加 Ark 视频行为测试，旧实现 13 失败 / 35 通过。
2. `t07-red.log`：3D 共用闭环已能通过 15 项，专门的 3D 遥测测试失败；随后修正 lane/reason 分类。
3. `t10-red.log`：新增查询权限及 registry 故障案例，2 失败 / 52 通过；随后补充 fail-closed 检查与安全 503。
4. `t10-permissions-red.log`：接到主控 laneName/allowCustomModel 要求后先补权限测试，包含新失败；随后实现。
5. `CI=true pnpm exec vitest run apps/gateway/src/routes/videos.test.ts apps/gateway/src/routes/three-d.test.ts`：最终 **78/78 通过**（video 58、3D 20），约 2.7 秒；见 `t06-t07-t10-final.log`。
6. `CI=true pnpm --filter @helm/gateway exec tsc --noEmit -p tsconfig.json --rootDir ../..`：通过，`t06-typecheck-final.log` 为空、exit 0。标准 rootDir 限制如上所述，未宣称正常 build 通过。
7. 定向 Biome 和 `git diff --check` 通过。没有全仓测试、Playwright、数据库变更或生产操作。

SHA-256：

```text
25ac6b9c506d91b7f11889af4abbf21e06b6c7f963e6b99663a09d2faea5ec92 t06-red.log
b39ae3822867f47e47cbc96c67717fe59b5c39db0ca6966247723152d1f42cf5 t07-red.log
c010020847ecdb0e2004ca7aba130b767701fd15a68b4c8641356965ba1fa918 t10-red.log
c041da720ef2612ce2e5505ac046506f5c802883e490d87acefe335a34bd2a57 t10-permissions-red.log
f534a618fa277629a5a07c7e272fe46be8131df025736892bba742eb9b436db7 t06-t07-t10-final.log
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 t06-typecheck-final.log
```

重启查询用真实 `createResponsesRegistry` 重新构造实例、共享模拟持久 store 验证；它证明跨实例恢复契约，不代替 SQLite 迁移或实际进程重启验收。主控拥有 server+SQLite/HTTP 集成责任。T02 已有离线传输验收不重复运行，本轮没有传输代码改动。
