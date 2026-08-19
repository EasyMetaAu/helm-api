# Grok 视频时长与扩展接口开发方案

> 状态：**代码与离线验收已完成；本机账号真实 15 秒纯文本、单图与多图生成均通过，30 秒与扩展真实验收未通过**
> 评估日期：2026-08-19
> Helm 证据基线：`967b9f9f8ee22e39f21aec9ac8d11376b44a4aed`
> Sub2API 证据基线：`49504adc98d2b6d539491e865a340e644548979e`（本地 `main` 与 `origin/main` 一致）

## 实施状态

- [x] 纯文本、单图、多图与 extension 统一接受 `duration: 6 | 10 | 15 | 30`。
- [x] 单图兼容 stable/preview 及对应 `xai/` alias，并继续使用 `image`。
- [x] 多图只使用 stable 1.5 模型；客户端兼容 `reference_images` 与 `images`，两者严格互斥，`images` 在付费 POST 前统一转成上游 `reference_images`。
- [x] 增加 `POST /v1/videos/extensions`、严格 schema、OpenAPI 与上游 provider 方法。
- [x] generation 与 extension 共用付费单写、reservation、telemetry、registry 和固定账号 poll。
- [x] provider、OAuth serialize/pool、gateway route、OpenAPI 与离线 e2e 定向测试通过。
- [x] 30 秒四种请求形状均有原样转发测试，extension 已覆盖跨 key、账号亲和与重启恢复。
- [x] 本机当前账号真实 15 秒纯文本生成仅 POST 一次，取得 receipt 后经 18 次只读轮询到 `done`；结果 URL 有效，媒体实际时长为 15.041667 秒。
- [x] 本机当前账号真实 15 秒单图生成使用 `grok-imagine-video-1.5-preview + image` 仅 POST 一次，经 8 次只读轮询到 `done`；下载结果实测 15.041667 秒。
- [x] 按 Grok Build 当前合同使用 `grok-imagine-video-1.5 + reference_images` 完成本机真实 15 秒多图生成；一次有效鉴权的付费 POST 取得 receipt，随后经 6 次只读轮询到 `done`，下载结果实测 15.041667 秒、1280×720。修正前的 `grok-imagine-video + reference_images` 请求曾返回 `503 outcome_unknown` 且无 receipt，未重放。
- [ ] 使用真实支持 30 秒的最高级账号完成付费 canary 与部署后终态回读；2026-08-19 本机当前账号的 30 秒纯文本生成仅 POST 一次，返回 `503 outcome_unknown` 且无 receipt，未重试；用户确认该账号不支持 30 秒，扩展 POST 为 0 次。

## 1. 目标与范围

本次只扩展现有 Grok/SuperGrok OAuth 视频链路，不新增通用媒体队列或第二套 provider 架构：

1. 所有视频写入模式统一使用 `duration: 6 | 10 | 15 | 30`，不再按纯文本、单图、多图或扩展维护不同枚举。
2. 为纯文本、单图、多图和视频扩展分别增加一条 30 秒原样转发测试。
3. 增加视频扩展入口；Helm 客户端入口为 `POST /v1/videos/extensions`，上游请求为 `POST https://api.x.ai/v1/videos/extensions`。

视频生成的三种模式使用同一个 Helm 入口，但请求形状不同，不能只按模型名区分：

| 模式 | Helm 入口 | 常用模型 | 图片字段 |
|---|---|---|---|
| 纯文本生成视频 | `POST /v1/videos/generations` | `grok-imagine-video` | 无 |
| 单图生成视频 | `POST /v1/videos/generations` | `grok-imagine-video-1.5-preview` 或 `grok-imagine-video-1.5` | `image` |
| 多参考图生成视频 | `POST /v1/videos/generations` | `grok-imagine-video-1.5` | 上游 `reference_images`；客户端兼容 `images` |

保持不变：

- 已有 6/10/15 秒继续兼容；30 秒是 Grok 最高级账号当前支持的统一上限，Helm 不主动注入或改写 duration。
- Helm 继续只公开既有的 `POST /v1/videos/generations`。Sub2API 的 `/v1/videos` 是兼容别名，不作为本次新增范围。
- 付费视频 POST 最多调用一次；结果不明时返回 `503 outcome_unknown`，不重试、不换 OAuth 账号。
- create 成功仍必须取得非空 `request_id`，再持久化 owner、key、provider 与 OAuth account 绑定。
- 新任务仍通过现有 `GET /v1/videos/{request_id}` 轮询；本次不增加 `/content` 代理、编辑接口或无版本前缀别名。
- 不支持尚未审计的 `output.upload_url` 等 ZDR 字段。

## 2. 三名专家的独立诊断

### 2.1 协议与 API 语义专家

- 当前单图 schema 位于 `packages/shared/src/request/videos-schema.ts`，要求 `image` 且只接受 6/10 秒；15/30 秒会在 provider 选择和付费 POST 前被严格拒绝。
- 当前多参考图 schema 要求 `reference_images`；还不接受 Sub2API 已兼容的 `images`。单图的 `image` 与多图的 `reference_images/images` 必须保持互斥，避免请求被错误分型。
- 当前 Helm 只注册 `grok-imagine-video-1.5-preview` 单图别名；还需把 `grok-imagine-video-1.5` 作为同一 1.5 能力族的兼容输入，同时保留客户端选择的 stable/preview 上游 wire model，不能仅靠改模型名判断请求模式。
- 当前纯文本 schema 已接受 6/10/15 秒；多图仍只有 6/10，extension 尚无 Helm schema。目标状态是四种模式统一复用同一个 6/10/15/30 schema。
- 实施后的转发层保留 `image`、`reference_images`、`duration` 与 `resolution`；仅把兼容入参 `images` 规范成 Grok Build 已证明的上游 `reference_images`，不做单图/多图升降级。
- Helm 当前没有 `/videos/extensions` 路由、schema、provider 方法或 OpenAPI 合同，不能只加一个 Hono 路由就宣称完成。

### 2.2 视频执行链与 Sub2API 对照专家

- 更新后的 Sub2API 在同一个 `videoGenerationHandler` 上注册 `/v1/videos` 与 `/v1/videos/generations`；两者最终都转发到上游 `/videos/generations`。
- Sub2API 会分别识别 `image`、`images` 与 `reference_images` 中的 URL 载体，但保留调用者选择的顶层字段和 model；它不能单独证明上游多图 wire 合同。
- 当前 Grok Build `reference_to_video` 的客户端输入名为 `images`，实际 POST 固定使用 `model: grok-imagine-video-1.5` 和 `reference_images: [{ url }]`，并允许 1–15 秒；Helm 以这个直接上游证据收紧多图 model，并在付费 POST 前规范兼容字段。
- Sub2API 另行注册 `/v1/videos/extensions` 与 `/videos/extensions`，并把请求转发到上游 `/videos/extensions`。
- 其测试样例为：

```json
{
  "model": "grok-imagine-video",
  "prompt": "continue",
  "video": { "url": "https://example.com/in.mp4" },
  "duration": 6
}
```

- Sub2API 会保留 `video` 对象并替换账号级 model mapping，但它没有严格校验扩展请求：本地 parser 不解析 `video`，已有 duration clamp 主要用于计费归一化，不是 API 能力来源；Helm 按已确认的高级账号 30 秒能力定义自己的严格合同。
- 可复用的是行为语义：扩展是异步 POST、使用 `/videos/extensions`、返回新任务 receipt、任务绑定创建账号后再轮询。不可复制的是宽松 body 透传、duration clamp、多账号失败切换及 Go/Gin 实现。

### 2.3 测试与兼容性专家

- 统一 duration 是公共输入域的单调扩展，不改变默认值或响应形状；测试重点是四种请求形状都能把 30 原样转发，不能降级成 15/10/6。
- 单图和多图必须分别测试正确图片字段；多图的 `reference_images` 与兼容字段 `images` 各有一条正向测试，并拒绝二者同时出现。
- 扩展接口必须拥有独立 Zod schema 和独立 provider 方法，不能塞进 `VideoGenerationRequestSchema`，也不能复用指向 `/videos/generations` 的 `videoGeneration()`。
- 最低验证层为 shared schema Vitest、gateway route Vitest、core provider Vitest 和一次离线 buildServer/e2e；不需要浏览器 UI 测试。
- 已知 Grok 最高级账号支持 30 秒；离线 mock 负责证明 Helm 的校验、URL、body、调用次数和账号亲和，部署后的业务验收仍以最高级账号的 receipt 与终态回读为准。

## 3. 统一结论与 Go/No-Go

| 项目 | 代码开发 | 离线验收 | 生产能力结论 |
|---|---|---|---|
| 所有视频模式统一 6/10/15/30 秒 | Go | 可完整证明原样转发 | 最高级账号支持 30 秒；部署后回读确认 |
| 单图/多图字段判别与 `images` 兼容 | Go | 可完整证明 | 不改变上游端点 |
| `/videos/extensions` | Go，但先冻结严格请求合同 | 可证明路由、单写、receipt 与轮询绑定 | 当前 No-Go；Sub2API 本地实现不能替代真实上游验收 |

主方案采用最小增量：复用现有视频 create 的鉴权、限流、预算、telemetry、双 registry 写入和固定账号 poll；只增加一个扩展 schema、一个 provider 能力和一个新的 POST 入口。不新建 `MediaTaskStore`、通用 operation framework 或内容下载代理。

## 4. 公共 API 合同

### 4.1 单图生视频

单图必须使用 `image`，不能换成 `reference_images` 或 `images`：

```json
{
  "model": "grok-imagine-video-1.5-preview",
  "prompt": "让画面缓慢运动",
  "image": {
    "url": "https://example.com/source.png"
  },
  "duration": 30,
  "resolution": "720p"
}
```

保持现有 prompt、image 与 resolution 合同，duration 使用统一 schema：

```ts
duration: 6 | 10 | 15 | 30
```

- 适用 model 为 `grok-imagine-video-1.5-preview`、`grok-imagine-video-1.5` 及对应 `xai/` concrete alias。
- stable/preview 名称共用同一 1.5 capability/account pool，不新增重复 lane/catalog；provider wire body 与 telemetry 都保留客户端选择的具体名称。
- `prompt` 继续允许空字符串。
- `resolution` 继续仅允许 `480p | 720p`。
- 除 6/10/15/30 以外的数值、小数和字符串仍在本地返回 400 `invalid_request`，且上游写次数为 0。

### 4.2 纯文本生视频

保持现有字段，复用同一个 duration schema：

```ts
duration?: 6 | 10 | 15 | 30
```

- 适用 model 继续为 `grok-imagine-video` 与 `xai/grok-imagine-video`。
- 不传 duration 时保持现有上游默认行为，Helm 不注入默认值。
- 6/10/15 秒现有合同及测试保留；30 秒增加相同级别的 schema 与原样转发覆盖。
- 除 6/10/15/30 以外的数值、小数和字符串仍拒绝。

### 4.3 多参考图生视频

多参考图与单图使用同一个 endpoint，但必须使用数组字段。规范字段为 `reference_images`：

```json
{
  "model": "grok-imagine-video-1.5",
  "prompt": "让 <IMAGE_0> 中的纸船平滑移动到 <IMAGE_1> 的机位",
  "reference_images": [
    {
      "url": "https://example.com/one.png"
    },
    {
      "url": "https://example.com/two.png"
    }
  ],
  "aspect_ratio": "16:9",
  "duration": 30,
  "resolution": "720p"
}
```

兼容请求可把 `reference_images` 改为 `images`，其余合同相同：

- 两个字段都要求 2–7 个严格 `{ url }` 对象。
- 一次请求只能出现 `reference_images` 或 `images` 其中一个；同时出现、两者都缺失或误用单个 `image` 均返回 400 `invalid_request`，上游写次数为 0。
- Helm 把兼容入参 `images` 统一转换为上游 `reference_images`；不会把单图 `image` 自动提升为数组，也不会把多图数组压成单图。
- model 只接受 `grok-imagine-video-1.5 | xai/grok-imagine-video-1.5`；prompt 建议用 `<IMAGE_0>`、`<IMAGE_1>` 对应引用。duration 继续复用 Helm 的 6/10/15/30 合同。

### 4.4 视频扩展

客户端入口：

```http
POST /v1/videos/extensions
Authorization: Bearer <helm-key>
Content-Type: application/json
```

第一版沿用 Sub2API 测试已经证明的 model/prompt/video 字段形状，duration 则使用 Helm 统一的 30 秒上限：

```json
{
  "model": "grok-imagine-video",
  "prompt": "continue the camera movement",
  "video": { "url": "https://example.com/source.mp4" },
  "duration": 30
}
```

约束：

- `model`：`grok-imagine-video | xai/grok-imagine-video`。
- `prompt`：非空字符串。
- `video`：严格对象，只接受非空 `url`。
- `duration`：与其他视频写入统一接受 6/10/15/30；不复制 Sub2API 的计费 clamp，也不为 extension 单独维护枚举。
- 未知字段 fail-closed；不接受原任务 ID 代替 source video URL，除非实施前取得明确上游合同与测试证据。
- 成功响应复用 `VideoGenerationResponseSchema`，必须有非空 `request_id`；其他上游字段原样保留。
- 返回的新 `request_id` 写入现有 `video:{request_id}` registry，随后仍用 `GET /v1/videos/{request_id}` 轮询。

第一版只提供标准 `/v1` 客户端入口。Sub2API 的无版本前缀别名、`/videos/extensions/{id}` 查询别名和 `/content` 代理不属于本次核心价值；客户端使用 Helm 已有的统一 task poll 即可。

## 5. 最小实现设计

### 5.1 Shared schema

在 `packages/shared/src/request/videos-schema.ts`：

- 把 `VideoDurationSchema` 统一定义为 `6 | 10 | 15 | 30`，纯文本、单图、多图和 extension 全部复用；删除各 shape 上额外拼接 literal 的写法。
- 单图 model schema 增加 `grok-imagine-video-1.5` 及对应 `xai/` alias；resolver 复用现有 1.5 capability/account pool，但 provider wire body 保留 stable/preview 名称。
- 多参考图拆成两个严格、互斥的请求 shape：`reference_images` 或兼容 `images`；两者都保持 2–7 张、只接受 stable 1.5 model 并复用统一 duration schema。
- 新增并导出 `VideoExtensionRequestSchema` 与 `VideoExtensionRequest`。
- 扩展响应复用现有 `VideoGenerationResponseSchema`，不重复定义同形 schema。

### 5.2 Provider client 与 OAuth pool

在 `packages/core/src/provider/openai.ts`：

- `ProviderClient` 新增可选 `videoExtension()`。
- 新增 URL 构造 `${base}/videos/extensions`。
- 使用与 `videoGeneration()` 相同的 `mediaWriteRequest` 单写语义和 `request_id` 响应校验，但不能调用 generation URL。

同时在 OAuth serialize/pool 中透传该可选能力：

- pool 在请求发出前只选择一个账号；
- 发出后不进行 401/503/529 transport retry、冷却重试或 sibling failover；
- 通过 `onAccountSelected` 把选中的账号写入 registry reservation。

### 5.3 Gateway route

在现有 `routes/videos.ts` 内提取一个仅供 generation/extension 共用的私有 paid-create 流程，参数只包含：

- operation 名；
- path；
- Zod schema；
- 对应 provider create 方法。

两条 POST 共用鉴权、memory admission、限流、预算、blocked model、telemetry、reservation、receipt 映射和 `outcome_unknown` 处理。不要复制整段 handler，也不要抽象成通用媒体工作流。

建议 reservation key 分开命名：

- generation：保持 `video-create:{helm_request_id}`；
- extension：`video-extension:{helm_request_id}`；
- 两者成功后都映射为 `video:{upstream_request_id}`。

telemetry 的 policy reason/operation 应区分 `video_generation` 与 `video_extension`，但常规日志仍不得记录 bearer、完整 prompt、source video URL 或签名 URL。

### 5.4 Server wiring 与 OpenAPI

- `resolveVideoTarget(model, operation)` 根据 operation 选择 `videoGeneration` 或 `videoExtension`，继续只允许可用的 `xai/*` OAuth `outputVideo` alias。
- resolver 对 stable/preview 名称复用同一个 1.5 capability/account pool，同时把客户端选定的名称作为 provider wire model；不复制 capabilities、pricing 和 lane 配置。
- xAI OAuth media client 继续固定 `https://api.x.ai/v1`；静态 API-key/generic video provider 不能成为隐式凭证路径。
- OpenAPI 增加 `/v1/videos/extensions`、`VideoExtensionRequest` 和已有 response 引用。
- `docs/grok-imagine-media-spec.md` 中原有 6/10 秒和“不支持 extension”的历史合同，在实现 PR 中同步改成当前事实；根 `implementation-notes.md` 按仓库规则记录合同扩容与发布限制。

## 6. TDD 与验收顺序

严格按红 → 绿 → 重构执行。

### P0.1：先锁定统一 duration 合同

1. Shared 红测：
   - 纯文本、单图、`reference_images` 多图、`images` 多图和 extension 均接受同一组 6/10/15/30；
   - preview/stable 及对应 `xai/` 单图 alias 均接受 `image + duration: 30`，并保留图片字段和值；
   - 多图分别接受 `reference_images + duration: 30` 和 `images + duration: 30`，拒绝两个字段同时出现、都不出现或误用 `image`；
   - 保留上述非法边界值拒绝测试。
2. Route 红测：
   - 单图 30 秒返回 200，`create()` 只调用一次，收到完整的 `image`、30 和 resolution；
   - stable 1.5 兼容名复用同一 1.5 capability/account pool，上游 body 与 telemetry 均保留 stable 名称；
   - 多图的 `reference_images` 携带 30 原样转发；兼容 `images` 在付费 POST 前转成相同的 `reference_images`，两者均不会改写成单图 `image`；
   - 纯文本 30 秒返回 200，`create()` 只调用一次，收到 30；
   - 非法请求在 reservation 前返回 400，`putIfAbsent` 与 provider create 均为 0 次。

### P0.2：扩展接口单写闭环

1. Shared 红测：最小合法体、两个 alias、30 秒、空 URL/空 prompt/错误 duration/未知字段。
2. Provider 红测：
   - 精确 POST `${base}/videos/extensions`；
   - JSON body 原样；
   - 503、529、transport error 均只调用一次；
   - 2xx 无非空 `request_id` 视为模糊失败。
3. Route 红测：
   - 401、schema、model、budget 拒绝均为 0 次上游写；
   - 合法请求只发一次 extension POST；
   - timeout/断连/5xx/无 receipt 统一 `503 outcome_unknown`；
   - 新 receipt 建立 owner/key/account 映射，跨 key poll 返回 404。
4. OAuth pool/serialize 红测：能力正确暴露，且扩展写不会切换 sibling account。

### P1：离线 integration/e2e

扩展现有 mock upstream capture：

- `/videos/generations` 捕获单图、纯文本和两种客户端多图入参的 duration 均为 30，并确认两种多图最终都以 `grok-imagine-video-1.5 + reference_images` 发往上游；
- `/videos/extensions` 捕获 duration 30、扩展 body、account 和新 `request_id`；
- 同一 OAuth account poll、新任务跨 key 隔离、gateway 重启后 registry 恢复；
- 每个 POST 的捕获次数精确为 1。

建议定向验证命令：

```bash
CI=true pnpm exec vitest run packages/shared/src/request/videos-schema.test.ts
CI=true pnpm exec vitest run packages/core/src/provider/openai.images.test.ts packages/core/src/provider/oauth/serialize-client.test.ts packages/core/src/provider/oauth/pool.test.ts
CI=true pnpm exec vitest run apps/gateway/src/routes/videos.test.ts apps/gateway/src/routes/openapi.test.ts
CI=true pnpm --filter @helm/gateway exec playwright test e2e/videos.spec.ts
```

完成定向测试后再运行 `pnpm typecheck`、`pnpm lint` 和 `pnpm build`；不运行无范围的 Playwright 或裸全量测试。

## 7. 发布门禁与回滚

### 7.1 不消耗额度的完成标准

- 所有新增 schema、route、provider、OAuth pool、OpenAPI 与离线 e2e 测试通过。
- 代码审查确认所有付费 POST 均没有自动 retry/fallback。
- diff 仅覆盖上述最小文件与必要文档，没有新增 Store、migration 或 UI。

### 7.2 真实能力验收

真实请求属于有成本的外部状态写入，不包含在普通实现授权内。只有用户单独批准后才执行，且每项假设至多一次：

1. 纯文本 30 秒：一次 POST，收到非空 receipt 后只做 GET poll。
2. 单图 30 秒：携带 `image` 发一次 POST，收到非空 receipt 后只做 GET poll。
3. 多图 30 秒：使用规范 `reference_images` 发一次 POST，收到非空 receipt 后只做 GET poll；`images` 兼容由离线转发测试覆盖。
4. 视频扩展 30 秒：使用已完成、可访问的测试视频 URL 发一次 POST；新 receipt 必须固定原 serving account poll 到有效终态。

判定：

- 200/201/202 且非空 `request_id`：create 被接受，继续 GET 回读。
- 400/422：合同不被接受，回滚对应 schema 枚举或 extension 字段。
- 401/403：凭证或 entitlement 问题，不据此否定 schema。
- 429：额度问题，不重放。
- timeout、断连或无 receipt 的 5xx：`outcome_unknown`，停止并对账，绝不盲目重试。

回滚是纯代码回滚：从共享 duration schema 移除 30、移除 `images`/stable 兼容输入或 extension route/client capability。没有数据库 migration，也不影响已创建任务的现有 `GET /v1/videos/{request_id}` 轮询记录。
