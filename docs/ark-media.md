# 方舟媒体接入 / Ark media integration

本地实现与离线验收完成；真实调用已有 Seed3D 成功产物，其他三项受上游额度限制，尚未发布。任务证据见 [开发计划](ark-media-development-plan.md) 与 [集成验收](ark-media-integration-evidence.md)。

Configure `ARK_API_KEY` in the gateway environment, then restart Helm. The optional `type: ark` provider uses the official OpenAI Node SDK **7.33.0**, with custom `post/get` for Ark task endpoints. No Python/Go runtime or additional Ark SDK is needed. Requests use the configured provider proxy and bounded response reader. Never put credentials in YAML.

在网关环境中设置 `ARK_API_KEY`，重启后启用。四个独立通道没有付费创建 fallback。未设置密钥时不影响其他 provider；请求这些模型会返回不可用。后台使用现有配置与模型目录显示这四个 alias，`outputImage`、`outputVideo`、`outputThreeD` 分别表示输出能力。它们不参加聊天执行，也不能使用聊天连通性测试来验证账号。

| Public lane | Model alias | Upstream model | Endpoint |
|---|---|---|---|
| `seedream-flash` | `ark/seedream-5.0-flash` | `doubao-seedream-5-0-flash-260915` | `/v1/images/generations` |
| `seedream-pro` | `ark/seedream-5.0-pro` | `doubao-seedream-5-0-pro-260628` | `/v1/images/generations` |
| `seedance-video` | `ark/seedance-2.5` | `doubao-seedance-2-5-260628` | `/v1/videos/generations` |
| `seed3d` | `ark/seed3d-2.0` | `doubao-seed3d-2-0-260328` | `/v1/3d/generations` |

Use a Helm key in `Authorization: Bearer $HELM_API_KEY`. Lane calls honor `allowed_lanes`; direct Ark aliases and exact upstream IDs require `allow_custom_model`. An upstream ID must map to exactly one configured Ark alias. Blocked models, client policy, concurrency, rate limits and request budgets still apply. The provider credential is never a client credential.

所有请求使用 Helm key。无法验证 USD 费用上限时，有金额预算的 key 会在发往上游前被拒绝；人民币价格不会当作美元，也不会把未知成本写成 0。请求数预算按创建请求记录，轮询不重复结算。本期没有新增媒体金额结算系统。

## Seedream Flash / Pro

POST `/v1/images/generations`：

```json
{"model":"seedream-flash","prompt":"白色背景上的红苹果产品照片","size":"2K","watermark":false}
```

Pro 多图参考也通过这个 JSON 入口发送；单图编辑将 `image` 改成一个 URL。

```json
{"model":"seedream-pro","prompt":"保留第一张图的主体，采用第二张图的配色","image":["https://example.com/object.png","https://example.com/style.png"],"size":"2K"}
```

自动图层拆分可以省略 prompt。普通生成返回一张图；图层模式保留 `data[]` 的图层元数据，不能只取 `data[0]` 当作完整结果。

```json
{"model":"seedream-pro","image":"https://example.com/poster.png","layer_decomposition":true,"size":"auto","output_format":"png"}
```

Seedream editing/reference inputs use `/images/generations`, not multipart `/images/edits`. Flash/Pro streaming, sequential group generation and search are rejected. See the [strict contract](ark-media-contract.md) for image limits and metadata. Input URLs are validated syntactically; Helm does not fetch the assets. Actual dimensions, duration and encoding are validated upstream.

## Seedance 2.5

POST `/v1/videos/generations`。这段是图、视频、音频组合参考示例；`reference_image` 不等于严格首尾帧。严格首尾帧使用 `first_frame` / `last_frame`，按契约单独选择模式。组合参考须显式填写 `omni_reference_task_type: reference`，避免上游自动选择本期未支持的编辑/延长任务。

```json
{"model":"seedance-video","content":[{"type":"text","text":"全程采用视频的第一人称视角，用参考音频作背景音乐，制作苹果果茶广告"},{"type":"image_url","image_url":{"url":"https://example.com/apple.jpg"},"role":"reference_image"},{"type":"image_url","image_url":{"url":"https://example.com/tea.jpg"},"role":"reference_image"},{"type":"video_url","video_url":{"url":"https://example.com/view.mp4"},"role":"reference_video"},{"type":"audio_url","audio_url":{"url":"https://example.com/music.mp3"},"role":"reference_audio"}],"omni_reference_task_type":"reference","duration":11,"ratio":"16:9","generate_audio":true,"watermark":false}
```

创建成功返回 `request_id`，然后 GET `/v1/videos/{request_id}`，使用原 Helm key。`queued` → `in_progress` → `done`，成功结果有 `video.url`；其他终态为 `failed`、`cancelled`、`expired`。不要重复创建来代替查询。

## Seed3D 2.0

POST `/v1/3d/generations`：

```json
{"model":"seed3d","content":[{"type":"image_url","image_url":{"url":"https://example.com/object.png"}}],"file_format":"glb","subdivision_level":"medium"}
```

Then GET `/v1/3d/{request_id}` using the same Helm key. A successful response is shaped as follows (illustrative ID and expiration):

```json
{"request_id":"helm-owned-uuid","status":"done","file":{"url":"https://example.com/assets.zip","format":"zip","model_format":"glb"},"artifact_expires_at":1792000000000}
```

下载结果是 **包含 GLB/PBR 资源的 ZIP**，不能把 ZIP 当作 GLB 文件。Helm 不托管、复制或延长产物寿命。视频和 3D 的任务归属持久化保存 7 天并支持重启恢复，未过期任务不受普通 Responses 条数清理提前淘汰（数据库总行数可超过 10,000，仍按 TTL 清理）；产物链接通常只保留 24 小时，`artifact_expires_at` 使用 Unix 毫秒。过期产物不会继续作为可用链接返回。

## Failures and acceptance limits

- Paid POSTs have **zero automatic retries**, including timeout/503/connection errors. `outcome_unknown` means the provider may have accepted the task; reconcile before any manual new create. A failed local ownership write must not trigger replay.
- `SetLimitExceeded` means the upstream account generation limit was reached. It does not mean the integration can fix the quota. Do not silently change safe experience settings, recharge or retry.
- 本期不支持 Seedance 编辑/延长、Draft、webhook、账户任务列表/删除。现有 Grok 视频扩展接口仍按原契约运行。
- 2026-10-14 经批准四模型各测一次：Seed3D 成功返回有效 ZIP/GLB/PBR；Flash、Pro、Seedance 均 `SetLimitExceeded`，无成功图片或视频。Seed3D 的 low 请求被上游报告为 medium，档位语义尚未通过一致性验收。详见 [真实验收记录](ark-media-live-acceptance.md)。未核对实际账单或部署生产。

官方协议来源：[Images](https://ark.volcengine.com/region:cn-beijing/docs/ark/image-generation-api?lang=zh)、[Video create](https://ark.volcengine.com/region:cn-beijing/docs/ark/create-video-generation-task-api?lang=zh)、[3D create](https://ark.volcengine.com/region:cn-beijing/docs/ark/create-3d-generation-task-api?lang=zh)。SDK 选型与传输限制见 [SDK evidence](ark-sdk-transport-evidence.md)。
