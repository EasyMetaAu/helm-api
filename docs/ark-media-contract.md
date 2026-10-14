# 方舟四模型输入与结果契约（T01）

版本：2026-10-14。源码基线：`f0d962692f97b18fb8ed118c3c1991fbfe0d1770`。
本文件与 `packages/shared/src/request/ark-media-schema.ts` 冻结本期允许的协议子集。
当前 schema 已接入路由、模型配置、权限、预算拒绝、任务持久化和结果归一化；离线证据见 [集成验收记录](ark-media-integration-evidence.md)。不是上线或付费实测验收。

## 模型与入口

| 模型 | 精确上游 ID（本 schema 的 model） | 计划中的 Helm 入口 | 上游入口 |
|---|---|---|---|
| Seedream Flash | `doubao-seedream-5-0-flash-260915` | `POST /v1/images/generations` | `POST /images/generations` |
| Seedream Pro | `doubao-seedream-5-0-pro-260628` | 同上 | 同上 |
| Seedance 2.5 | `doubao-seedance-2-5-260628` | `POST /v1/videos/generations`，`GET /v1/videos/{request_id}` | `POST /contents/generations/tasks`，`GET /contents/generations/tasks/{id}` |
| Seed3D 2.0 | `doubao-seed3d-2-0-260328` | `POST /v1/3d/generations`，`GET /v1/3d/{request_id}` | 同一原生任务 API |

上游基址为 `https://ark.cn-beijing.volces.com/api/v3`。所有 model 都是完整枚举；拒绝旧版本、`auto`、Endpoint ID 和未解析 alias，绝不自动替换模型。公开别名的名称和配置映射仍由主控 T04 决定；应先按权限解析到已配置 alias/精确 ID，再进入本 schema，不得借此绕过 `blockedModels` 或 `allowCustomModel`。

## 共同边界

所有请求对象及其嵌套对象均为严格 Zod 对象：未知字段报错，不剥离、不透传、不强制转换、不自动补默认值。已省略的默认值交由上游处理。类型统一 `z.infer`。响应同样严格；未来字段或状态需显式评估，不能误报成功。响应解析失败不允许重发创建请求。

本期输入统一只接受 **HTTPS DNS 主机名 URL**，允许 query（例如签名 URL）。拒绝 HTTP、data/Base64 输入、素材 ID、相对地址、IP 字面量（含 URL 规范化后的十进制 IP）、localhost/`.local`/`.internal`/`.lan`/`.home`/`.invalid`、自定义端口、userinfo、fragment、空白和反斜线。该限制是 Helm 本期约束，方舟官方还支持部分 Base64/素材输入。`b64_json` **输出**仍受支持。

URL schema 只做语法准入，不做 DNS 解析、不声称证明地址公网可达，也不检测 DNS 重绑定。Helm 不下载输入媒体或代理输出。DNS 指向、媒体大小/时长/编码/透明通道由上游校验；集成不得引入未授权远程探测。若以后在 Helm 下载，须另加连接时 IP/重定向验证与大小限制，不能依赖此 schema 防 SSRF。

## Seedream Flash / Pro

字段来源：[图片 API][images] 的请求参数、模型能力与非流式响应；本轮直接核对页面，更新时间 2026-10-10。

| 字段 | 本期契约 | 合法 / 非法例子 |
|---|---|---|
| `prompt` | 普通生成必填且非空白；图层拆分可省略；保留原文，不 trim | `"湖面"` / `" "`；图层模式可不传 |
| `image` | 可选 URL 字符串或 1–10 项数组；普通输入 0 图文生图、1 图编辑、2–10 图参考 | URL、`[URL,URL]` / `[]`、11 项、`{url}` |
| `layer_decomposition` | 可选 boolean；true 时恰好 1 图 | 单图且无 prompt / 缺图或多图 |
| `size` | 普通：`1K/1.5K/2K` 或 `宽x高`；像素积 921600–4624220，宽高比 1:16–16:1；图层：仅上述档位或 `auto` | 普通 `2048x1024` / `512x512`、`4K`、`auto`；图层 `auto` / `2048x1024` |
| `output_format` | `png/jpeg`；图层模式只控制底图，其他层始终 PNG | `png` / `webp` |
| `background` | `opaque/transparent`；transparent 要求恰好 1 图，不能显式 jpeg；省略 output_format 时上游默认 PNG | 单图+transparent / 无图、多图或 jpeg |
| `response_format` | `url/b64_json` | `url` / `base64` |
| `watermark` | boolean | `false` / `"false"` |
| `stream` | 仅可省略或 false，不支持流式 | `false` / `true` |
| `optimize_prompt_options.mode` | `standard`；只有 Pro 还允许 `fast` | Pro fast / Flash fast |

`sequential_image_generation` 即使 `disabled` 也拒绝：官方明确 Flash/Pro 不支持配置此字段。拒绝 `sequential_image_generation_options`、`tools`（含空数组）、搜索、`n`、`seed`、guidance 参数等旧模型/其他协议字段。

普通输入文件上游限制：jpeg/png/webp/bmp/tiff/gif/heic/heif、≤30 MB、每边 >14 px、196–3600 万像素、宽高比 1:16–16:1。图层输入仅 png/jpeg、262144–3600 万像素。透明模式要求有 alpha 通道的单图；URL 后缀不可靠，schema 不根据 `.png` 猜测真实格式。

成功响应使用 `ArkImageGenerationResponseSchema`：`model/created/data` 必填；普通恰好 1 项；图层最多 17 项（底图+16层），按 `z_index=0..N` 排序。每项有 `size/output_format`，且恰好一种 `url/b64_json`。普通和底图无需图层名称；正整数层必须有 PNG、`name/description/bounding_box`。

`bounding_box.absolute` 为 `[left,top,right,bottom]` 像素整数，宽高正数；`normalized` 为同一顺序的 0–1000 整数，可因舍入产生相等边界。二者完整保留。`usage` 若出现，保留 `generated_images/output_tokens/total_tokens` 和可选 `input_images`，不按聊天 token 价格结算。顶层错误使用 `ArkMediaErrorSchema` 表示 `code/message`，不当作成功图像响应。图层不支持部分成功。

## Seedance 2.5

字段来源：[创建视频任务][video-create]、[2.5 教程][video-guide]、[查询视频任务][video-get]；本轮核对模型专属限制。

| 字段/组合 | 本期契约 | 合法 / 非法例子 |
|---|---|---|
| `content` | 1–51 项（最多1文本+50素材）；保留顺序 | 1文本 / 空列表、多个文本 |
| 文本项 | `{type:"text",text:非空白}`，可省略；纯文本模式需至少此项 | 自然语言 / 空文本、命令式 `--dur 3` |
| 图像项 | `{type:"image_url",image_url:{url},role}`，role 必填 | `first_frame/last_frame/reference_image` / 未知或缺省角色 |
| 视频/音频项 | 对应 `video_url/audio_url` 对象，角色固定 `reference_video/reference_audio` | 类型与角色匹配 / 错配角色 |
| 首帧模式 | 恰好 1 first_frame；最多1 last_frame；`ratio:"adaptive"` 显式必填；不可混入参考素材或 task_type | 首帧或首尾帧 / 单尾帧、重复首帧、首帧+参考音频 |
| 参考模式 | ≤30图、≤10视频、≤10音频，总≤50；至少1参考素材；必须显式 `omni_reference_task_type:"reference"` | 图片+视频+音频、仅音频 / 31图、11视频、11音频、auto/edit/extend |
| `duration` | 可选整数 4–30 或 -1 | 4、11、30、-1 / 3、31、4.5 |
| `ratio` | `16:9/4:3/1:1/3:4/9:16/21:9/adaptive` | 21:9 / Grok 的 3:2 |
| `resolution` | `480p/720p/1080p` | 1080p / 4k |
| `generate_audio/watermark` | 可选 boolean | true / 字符串 |
| `output_format` | 本期仅省略或 `mp4` | mp4 / mov |

明确采用的 Helm 子集：强制角色和参考模式；不接受默认 `auto`，避免意外被解释成编辑/延长；最多1文本；拒绝提示词中的 `--英文参数` 第二参数通道（上游可弱校验这些参数，会绕开结构化边界）。自然语言意图仍可能导致上游 `InvalidParameter.TaskTypeMismatch`，不能承诺创建即成功。

本期不包含 MOV 专业输出、返回尾帧选项、Draft、webhook、frames、service_tier、priority、execution_expires_after、tools、列表/删除、编辑/延长。`seed/camera_fixed` 是官方限定旧 1.0 模型的字段，2.5 拒绝。返回 metadata 中出现的已知只读字段可保留，并不意味着开放相应创建能力。

上游校验视频总时长≤30秒、音频总时长≤30秒，及实际格式/分辨率/帧率；URL schema 不能证明这些性质。1080p 编码的播放器兼容性需实际产物验收。参考图写“首尾帧”仅是提示词，不等于 API 的 first_frame/last_frame 约束。

## Seed3D 2.0

字段来源：[创建3D任务][3d-create]、[查询3D任务][3d-get]，本轮直接核对页面（2026-09-28/29）。

| 字段 | 本期契约 | 合法 / 非法例子 |
|---|---|---|
| `content` | 恰好一个 `{type:"image_url",image_url:{url}}`，无 role | 单图 / 文本、两图、first_frame |
| `file_format` | 仅 `glb` 或省略（上游默认 glb） | glb / obj、usd、usdz |
| `subdivision_level` | `low/medium/high` 或省略（默认 medium） | medium / ultra |

上游 low/medium/high 对应 10万/50万/100万多边形面。图片格式 jpeg/png/webp/bmp/tiff/gif，宽高比 0.4–2.5，每边300–6000像素，单张<30MB，上游请求体≤64MB。实际文件属性由上游验证。

官方通用创建页列出纯文本与文本+图片，但批准计划只开放单图GLB。本期拒绝所有文本项，包括官方示例中的 `--subdivisionlevel ... --fileformat ...`；使用已核对的结构化字段。不把通用页面能力等同于本期模型承诺。

查询使用 `content.file_url`，元数据拼写为 `fileformat/subdivisionlevel`；不能按创建字段下划线拼写读取。**file_url 指向 ZIP，里面才是所选格式的文件。官方明确24小时后清理**。因此 T13 应验证 ZIP 内 GLB 及纹理/PBR，不能用 URL 后缀或 HTTP 200 验收。此前研究中“3D URL寿命未核实”的空缺已由当前官方页补齐。

## 异步状态、错误与预算

`ArkTaskCreateResponseSchema` 验证非空白 `id`，创建成功只表示受理。两类查询必须验证精确 model 和本地 task kind。`ArkVideoRetrieveResponseSchema` 支持 `queued/running/cancelled/succeeded/failed/expired`；`ArkThreeDRetrieveResponseSchema` 仅支持前五种，3D 当前文档未列 expired。旧 Python 0.12.0 枚举也未列视频 expired，以当前视频 API 为准。

| 上游 | 计划中的 Helm 对外状态 | 条件 |
|---|---|---|
| 创建 `{id}` | `{request_id}` | 主控分配公共 ID 并持久化 owner/key/provider/credential/task-kind 后返回 |
| queued/running | queued/running | 保留 provider_status；不是成功 |
| succeeded | done | 视频必须有 `content.video_url`→`video.url`；3D必须有 `content.file_url`→`file.url` |
| failed | failed | 结构化 `error.code/message` 必须存在 |
| cancelled | cancelled（终态） | 不能继续视作处理中；Grok 现有行为不变 |
| expired（仅视频） | expired（终态） | 不与链接过期或任务记录TTL混淆 |
| 未知状态 | 上游协议错误 | 不当作成功；不自动重发创建 |

查询的 `error:null` 与省略均表示无错误；succeeded + error 对象拒绝。非 succeeded 不暴露结果。查询可保留创建/更新时间、usage 和已知只读元数据。上游成功结果没有产物字段是协议错误，不是 done。

任务记录保留7天（从创建起算），取消状态可能24小时清理。图片链接24小时有效；视频链接24小时、最多100次下载；3D ZIP24小时清理。Helm ownership TTL 需与上游任务窗口配套，不能沿用产物URL TTL。

错误处理由主控实现：schema/组合不合法在付费 POST 前拒绝；已确认上游拒绝保留安全的错误 code；超时、断连、创建成功但本地归属持久化失败应为 `outcome_unknown` 并禁止自动重试/fallback。异步 `SetLimitExceeded`、`InvalidParameter.TaskTypeConstraint`、`InvalidParameter.TaskTypeMismatch` 保留可识别 code，message 脱敏后输出。凭据及用户标识不得写入常规日志。

未知成本不是0。图片按输入数量、像素档与实际输出层计费；异步 usage 仅终态可用。USD硬预算无法准确证明上界时，在上游调用前返回 `media_pricing_unavailable` 等明确错误，CNY不得直接记为USD。轮询不得重复计数/扣费。T01不实现预算预占、归属存储、传输大小限制或错误映射；这些是后续集成验收项。

## 四个公开调用 fixture

以下是计划入口的 JSON 请求体，使用公开精确模型 ID，T04仍须配置模型映射并执行权限校验。示例域名是占位符，替换为用户有权使用的公开素材；不包含真实密钥。测试直接从四个 `json request` 代码块读取并验证，示例不宣称入口已接通。

Flash：`POST /v1/images/generations`，文生图。

```json request
{
  "model": "doubao-seedream-5-0-flash-260915",
  "prompt": "清晨湖面的水彩插画",
  "size": "1.5K",
  "output_format": "png",
  "response_format": "url",
  "watermark": true
}
```

Pro：同一入口，自动图层拆分（无 prompt）。

```json request
{
  "model": "doubao-seedream-5-0-pro-260628",
  "image": "https://media.example.com/poster.png",
  "layer_decomposition": true,
  "size": "auto",
  "output_format": "jpeg",
  "response_format": "url"
}
```

Seedance：`POST /v1/videos/generations`，保留两图+视频+音频参考意图；要强约束首尾帧时改用独立首尾帧模式，不混用素材。

```json request
{
  "model": "doubao-seedance-2-5-260628",
  "content": [
    { "type": "text", "text": "参考图片1和图片2的场景变化，借鉴视频构图，配合参考音频生成连贯镜头。" },
    { "type": "image_url", "image_url": { "url": "https://media.example.com/start.png" }, "role": "reference_image" },
    { "type": "image_url", "image_url": { "url": "https://media.example.com/end.png" }, "role": "reference_image" },
    { "type": "video_url", "video_url": { "url": "https://media.example.com/reference.mp4" }, "role": "reference_video" },
    { "type": "audio_url", "audio_url": { "url": "https://media.example.com/reference.mp3" }, "role": "reference_audio" }
  ],
  "omni_reference_task_type": "reference",
  "ratio": "16:9",
  "duration": 11,
  "resolution": "720p",
  "generate_audio": true,
  "output_format": "mp4"
}
```

Seed3D：`POST /v1/3d/generations`，单图GLB。

```json request
{
  "model": "doubao-seed3d-2-0-260328",
  "content": [
    { "type": "image_url", "image_url": { "url": "https://media.example.com/object.png" } }
  ],
  "file_format": "glb",
  "subdivision_level": "medium"
}
```

视频和3D获得 `{request_id}` 后，分别查询 `/v1/videos/{request_id}` 或 `/v1/3d/{request_id}`。公共 ID 不得跨类型读取。上游原始成功 fixture：

```json
{"id":"cgt-video-fixture","model":"doubao-seedance-2-5-260628","status":"succeeded","content":{"video_url":"https://media.example.com/result.mp4"},"error":null}
```

```json
{"id":"cgt-3d-fixture","model":"doubao-seed3d-2-0-260328","status":"succeeded","content":{"file_url":"https://media.example.com/result.zip"},"fileformat":"glb","subdivisionlevel":"medium","usage":{"completion_tokens":30000,"total_tokens":30000},"error":null}
```

## 主控集成清单

1. 添加 barrel exports 和路由联合 schema 前，按已配置模型解析 alias，保留 Grok 原 schema；本任务未修改既有文件。
2. 将严格上游结果与公共任务结果分开，落实上表字段映射、未知状态错误和 message 脱敏；不把本文件中的映射说明当成已实现函数。
3. 对结果模型/格式与创建请求做关联验证：schema只校验单个包，不能证明响应属于原请求；持久化 owner、key、provider和 task kind。
4. 支持图层后再开放金额受限 key；执行图片层数/像素计费，视频/3D维持已批准的未知金额拒绝策略。
5. 所有 POST 零自动重试/fallback，响应边界/取消/大小准入由 T02/路由保证。T12再做 HTTP hermetic 闭环与 Grok回归，T13另获费用授权。
6. 官方3D示例把时间戳写成字符串，但字段表和 SDK 是 integer：当前 schema不做强制转换，采用字段表；未来真实响应若冲突，应提供证据后明确适配。

## 官方来源

仅访问免费公开文档；没有向外部服务发送仓库、账户数据或密钥，没有付费请求。2026-10-14直接核对 [images]、[video-create]、[video-guide]、[video-get]、[3d-create]、[3d-get]。模型ID也由批准研究所核对的模型列表和当前各API示例交叉支持。SDK仅作协议参考，没有复制其实现。

[images]: https://ark.volcengine.com/region:cn-beijing/docs/ark/image-generation-api?lang=zh
[video-create]: https://ark.volcengine.com/region:cn-beijing/docs/ark/create-video-generation-task-api?lang=zh
[video-guide]: https://ark.volcengine.com/region:cn-beijing/docs/ark/seedance-2-5?lang=zh
[video-get]: https://ark.volcengine.com/region:cn-beijing/docs/ark/get-video-generation-task-api?lang=zh
[3d-create]: https://ark.volcengine.com/region:cn-beijing/docs/ark/create-3d-generation-task-api?lang=zh
[3d-get]: https://ark.volcengine.com/region:cn-beijing/docs/ark/get-3d-generation-task-api?lang=zh

- [官方模型列表](https://ark.volcengine.com/region:cn-beijing/docs/ark/model-list?lang=zh)
- [官方 Python SDK 0.12.0](https://pypi.org/project/arkruntime/0.12.0/)
- [官方 Python SDK 源码](https://github.com/volcengine/ark-runtime-python)

## 2026-10-14 实测字段补充

Seed3D 查询实测 running 响应包含 `service_tier`、`execution_expires_after`、`draft`、`priority`。这些公共任务字段已加入严格响应 schema；请求字段与未知字段拒绝保持不变。真实模型状态见后续 T13 验收记录。
