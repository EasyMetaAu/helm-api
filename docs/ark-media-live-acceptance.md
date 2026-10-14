# T13 四模型真实测试结果

2026-10-14，Asia/Shanghai。用户单独批准四模型各一次创建，合计估算 ¥5.51，知悉 Seedance 无官方硬金额上限。本轮 **4 次 POST，无创建重试**。通过独立本地 Helm 的 HTTP 请求处理、真实 OpenAI SDK 与真实 Ark API，不是直接绕过 Helm 的 curl。未部署生产。

## 结果

| 模型 | 真实结果 | 验收判断 |
|---|---|---|
| Seedream 5.0 Flash | 创建 HTTP 429，`SetLimitExceeded` | 上游安全体验模式额度受限；无图片，未通过生成验收 |
| Seedream 5.0 Pro | 创建 HTTP 429，`SetLimitExceeded` | 同上 |
| Seedance 2.5 | 创建成功，任务随后 `failed / SetLimitExceeded`；Helm 正确返回终态 | 上游额度受限；无视频，未通过生成验收 |
| Seed3D 2.0 | 创建成功，任务 `succeeded`，Helm `done`，ZIP/GLB/PBR 校验通过 | 基础创建、恢复查询、产物链路通过；low 档位未通过一致性验收 |

Seedance 上游任务：`cgt-20261014162412-u0cia`；Helm ID：`92098597-6b96-4bf9-ab8d-e11e034d4daa`。
Seed3D 上游任务：`cgt-20261014162410-54jfg`；Helm ID：`f9589b50-0e39-4f2a-a333-229c22e1a95b`。

## Seed3D 产物

- 上游生成耗时：501 秒（created_at → updated_at）；本轮在 10 分钟观察窗口内读到成功终态。
- `usage.completion_tokens = usage.total_tokens = 30000`；按当日已查公开价 `30000 × ¥0.80 / 10000 = ¥2.40`，**不是实际账单核验**。其他三项没有成功产物，未查账单，不能把“失败”当作已核销证据。
- ZIP：21,248,587 bytes；SHA-256 `86b6909b394e125d55b569c7b5ee8aa34ae30c5bdf8fef30d2bf4dd980cbda1e`。
- ZIP checksum 通过，文件 `pbr/mesh_textured_pbr.glb`，26,121,352 bytes。
- GLB 2.0 header、总长度、JSON/BIN chunk、bufferView 边界检查通过；1 mesh、1 primitive、1 PBR material、2 textures、2 images。
- 本次为文件结构/资源验收，没有做视觉或建模质量评分。
- **参数差异**：批准并发送 `subdivision_level: low`，上游终态却返回 `subdivisionlevel: medium`。发送前 guard 验证实际 SDK Request body 与批准清单（仅 model 解析为 wire ID）一致；未静默替换。官方 Python SDK 参考同样发送下划线字段。原因尚未确认，不能宣称 low 被上游执行，也不能擅自改用提示词参数或再花费创建一次。基础 GLB 链路通过不代表全部参数语义通过。

产物保存在本地：`/Users/lukin/Documents/Codex/2026-10-14/helm-seedance-research/live-acceptance/seed3d-output.zip`。输出 URL 没有写入 Git，避免提交带签名的链接；上游 URL 通常 24 小时有效，本地副本可用于复查。

## 实测发现与修复

首次 Seed3D GET 的真实 `running` 响应带有 `service_tier`、`execution_expires_after`、`draft`、`priority`，原严格 schema 未列出，造成 Helm 502。红灯复现后仅加入这四项的严格类型与边界，没有放开任意字段。

修复提交：`91f7fa1a5c0bd1126d7f31bfc16d73384f6af721`。重新构建 shared 后重新启动本地 Helm，使用同一 SQLite 任务归属记录查询原任务，正常返回 `in_progress`，最终 `done`。本地测试 key 只轮转 hash 保持 key/account ID，不修改生产 key 或上游账户。中间一次只读查询网络失败，没有重新创建任务。

- TDD 真实形状回归：先 1 failed，修复后相关 150 项通过。
- 最终相关 5 个文件 **154/154 通过**：schema、3D route、task normalization、OpenAPI、真实网关+SQLite 离线集成。
- Shared/Core/Gateway typecheck、Shared build、相关 Biome、git diff whitespace 均通过。
- 最初本地启动缺少临时 MCP OAuth 加密配置，发生于所有 POST 之前；补齐仅本地运行配置后执行，启动失败不消耗上游创建次数。

## 状态与恢复条件

T13 **部分完成、其余受阻**。用户可以在方舟控制台核对三个模型的模型开通/安全体验模式额度。我们没有修改额度、关闭保护或充值。额度恢复后的再次创建需要另定范围，不复用本轮已消耗的四次创建授权。

Seed3D 的 low/medium 差异需要核对当前服务的参数语义；在有官方解释或新的明确测试范围之前保留限制。未运行远端 CI，未推送、未合并、未部署。所有实测进程已结束，无后台持续付费任务创建。

## 证据

完整脱敏证据位于 `/Users/lukin/Documents/Codex/2026-10-14/helm-seedance-research/live-acceptance`。密钥仅运行时输入，不保存到脚本、请求清单、日志或 Git。上游账户编号与请求跟踪编号已从保存的错误文本中去除。

| 文件 | SHA-256 |
|---|---|
| `requests.json` | `b9bfaf38645bcc5f6ea67c8ce5f61d22a78425caea38ab22e9c1bd13fd472883` |
| `acceptance-status.json` | `032e09c856caba859df9fbba54a33337405fd07b4445fc23197bf2b65fc3a04a` |
| `seedream-flash.helm-create.json` | `d9407a64732562cdba72d8937126b7a83f02b63f25a01c677c33fb42fa5028c6` |
| `seedream-pro.helm-create.json` | `d9407a64732562cdba72d8937126b7a83f02b63f25a01c677c33fb42fa5028c6` |
| `seedance-video.helm-latest.json` | `950e74550418099a48afc5821d3a724f93e91795a92e1a2170819de5694e01a0` |
| `seed3d.upstream-latest.json` | `7df3ea102664c36f13e16784e71f07f77a070b3e65fa8ee2300c8faabdf5bac8` |
| `seed3d.helm-latest.json` | `09535189819b43ec46f33056727048ee89d8badfe76c57f2e990feedc4982a23` |
| `seed3d-artifact-verification.json` | `54276f0e8916815f04872291a7c61e2c981172d2da4fd2872287b71844f969e0` |
| `schema-red.log` | `144134cf8e2b7cfea8c5c2be0a192fe6811dfc76c5461df3ac702fde69842362` |
| `final-regression.log` | `177e43b1b62ada6c3851aa8cca64bf3835a4f6108d2504bc9837d66e8ab6b38f` |
| `typecheck.log` | `e50fabff4715df82bd96322f05cf9d5b723e88c5709c5ee02037e6de06dfc2c7` |
| `final-format.log` | `2b2f0025a14229ca0ca718660db5d05f02ad67f9a4708346a942a859110a928e` |
