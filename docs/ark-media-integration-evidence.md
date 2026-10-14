# Ark 集成验收记录

日期：2026-10-14。主持：主控。结论：**本地代码与离线集成验收通过；T13 真实调用受阻，未发布。**

## 被验收版本与提交

- 基线：`f0d962692f97b18fb8ed118c3c1991fbfe0d1770`。
- 集成代码：`e7ac6a14150165edf8e53d13d03cf1ad3ebc6003`；后续验收记录提交只修改文档。
- 分支：`codex/ark-media-integration`。
- 工作区：`/Users/lukin/Projects/.worktrees/ark-media-integration/helm-api`，Codex 管理，保留供审阅。
- 原主检出未切分支、未重置、未应用本次代码。

| 子任务 | 原提交 | 集成提交 |
|---|---|---|
| T01 严格契约 | `b801e18b529e1840c58fcea7d4714dc69cbec91e` | `bfc9cb6c` |
| T02 OpenAI SDK 传输 | `b22ed646158d5085019de478a408a979c8f06403` | `cca5bf62` |
| T05/T09 图片 | `e5f4c78e215f1f9d15ab0d56d25e47d000df6df2` | `982e6652` |
| 图片权限补充 | `6114a0645581ea28d2202d01021482321d6c611e` | `cbff7c08` |
| T06/T07/T10 异步视频与 3D | `78226eefba9152909cb27fb2d8a94e9749c3c2de` | `3ac26b44` |
| 主控接线、联合边界、文档与后台标记 | `e7ac6a14150165edf8e53d13d03cf1ad3ebc6003` | 同左 |

两个原 Codex 子任务已提交并结束。本次没有创建重复聊天，没有推送、PR、合并或部署。

## 验收覆盖

- 真实 `buildServer` + SQLite 临时数据库 + Hono HTTP 请求 + OpenAI SDK，四模型均走到 mock fetch：Flash/Pro 图片、Seedance/Seed3D 创建和查询。每个模型断言实际 wire ID、URL 和鉴权隔离。所有上游为离线 mock，零付费调用。
- `server.dispose()` 后重新 `buildServer()` 读取同一 SQLite 文件恢复任务，跨 key 查询零上游请求且拒绝；这是服务对象重启验收，未声称进行了操作系统重启。
- 图片 lane 白名单、direct alias/wire ID 权限、requested/alias/wire 黑名单；client policy 的 POST/GET 3D 入口；金额预算未知时创建前拒绝。
- 付费 POST 一次：503、超时、取消、重定向、错误响应、映射持久化失败均不重放。轮询不重复计费。跨 provider 同上游 ID 使用不同 UUID，验证任务 kind/provider/model/key/account 绑定。
- SQLite 与 Postgres/PGlite 定向契约均验证：未过期媒体任务与预写记录不受条数清理淘汰；到 TTL 后清理。普通 Responses 数量清理行为保留。
- Grok 原图片/视频、固定首尾帧、扩展、聊天媒体隔离等相关回归；Seedream 图层与多图参数、Seedance 全模态与严格输入；三种已知上游失败 code 保留，消息不直接泄露。
- OpenAPI、四模型调用例子（全部 JSON 例子经 schema 验证）、后台模型选择器 Image/Video/3D 标签；聊天连通性检查在任何 Ark 网络请求前拒绝。

## 最终验证

| 检查 | 结果 | 日志 |
|---|---|---|
| 定向 Vitest，20 文件 | **677/677，exit 0** | `final-tests.log` |
| Shared/Core/Gateway 类型检查 | 通过，exit 0 | `final-typecheck.log` |
| Admin Svelte check | 0 errors / 0 warnings，exit 0 | `final-admin-check.log` |
| Shared/Core/Gateway/Admin build | 通过，exit 0 | `final-build.log` |
| 33 个相关 TS 文件 Biome | 通过，exit 0 | `integration-biome.log` |
| 4 个受影响 Admin 文件 Prettier | 通过，exit 0 | `integration-prettier.log` |
| Git diff whitespace | 通过 | 提交前 `git diff --cached --check` |

复现命令：

```bash
CI=true pnpm exec vitest run \
  packages/shared/src/request/ark-media-schema.test.ts packages/shared/src/request/ark-media-documentation.test.ts \
  packages/shared/src/request/images-schema.test.ts packages/shared/src/request/videos-schema.test.ts \
  packages/core/src/provider/ark.test.ts packages/core/src/config/samples.test.ts \
  packages/core/src/store/responses-registry-store-contract.test.ts \
  apps/gateway/src/routes/images.test.ts apps/gateway/src/routes/image-chain.test.ts \
  apps/gateway/src/routes/videos.test.ts apps/gateway/src/routes/three-d.test.ts \
  apps/gateway/src/routes/ark-media-task.test.ts apps/gateway/src/routes/execute.test.ts \
  apps/gateway/src/routes/openapi.test.ts apps/gateway/src/server.ark.test.ts \
  apps/gateway/src/server.ark-integration.test.ts apps/gateway/src/server.client-policy.test.ts \
  apps/gateway/src/responses-registry.test.ts apps/admin/src/lib/api/models.test.ts \
  apps/admin/src/lib/components/LaneEditor.test.ts
pnpm --filter @helm/gateway... typecheck
pnpm --filter @helm/admin check
pnpm --filter @helm/gateway... --filter @helm/admin build
```

本期后台变更仅为模型选择器的能力标签，组件测试验证渲染；没有改变浏览器操作流程。未运行全仓测试、Playwright、远端 CI、Docker smoke 或生产验证，不能将本报告解释为这些门禁通过。测试启动时未构建静态目录的提示属于静态资源缺失；后续 Admin 构建成功。Portal 未改动或重建。

## 未完成与操作限制

- T13：Flash/Pro/Seed3D 尚未获新的付费调用授权。Seedance 此前唯一批准的任务 `cgt-20261014140243-mgu53` 为 `failed / SetLimitExceeded`，未产出媒体；该次授权已消耗，未重试。四模型均未获得经 Helm 的成功真实产物验收。
- USD 媒体结算未实现，硬金额预算 key 拒绝调用；不将 CNY 当 USD，也不把未知价格当 0。请求数预算仍适用。
- 7 天任务保护会让数据库总行数超过普通 Responses 的 10,000 条软上限；仍按 TTL 清理，没有增加无期限保留。3D 输出是包含 GLB 的 ZIP；链接 24 小时，Helm 不托管资产。
- 若进入 PR/发布流程，还需单独执行仓库要求的 CI 和上线验收；本次未推送或部署。

## 本地日志完整性

日志根目录：`/Users/lukin/Documents/Codex/2026-10-14/helm-seedance-research`。仅保存脱敏输出，没有保存测试 API key。

| 日志 | SHA-256 |
|---|---|
| `final-tests.log` | `9c5dd52958684ff76160f4596783efe01e5f725e5f80c10e889e3b509bdf2eec` |
| `final-typecheck.log` | `e50fabff4715df82bd96322f05cf9d5b723e88c5709c5ee02037e6de06dfc2c7` |
| `final-admin-check.log` | `b47bbe2ad30c309203dcd7372377ed65c5d9aae78a0d2060d2ca93f67f51d8c3` |
| `final-build.log` | `8b46b1107e43771eceff278603df58788061188158012df43ea2ca60693ac4d0` |
| `integration-biome.log` | `d5405e0b1ad6f59781525e20fc503dfb1a7cf0cb9965ecb15be549c6fd8c5128` |
| `integration-prettier.log` | `8fee5c078089a916c4dc79b431bab8df079c2ea05379c0cd372553afa046132c` |
| `t04-red.log` | `a02ae995c85703e98046c87e75792034d151ca153cfa5afeef5207411301aa62` |
| `t04-boundary-red.log` | `29d080bfdb7e6690b608ef7eeed06a95bd9d824d4ea640d29a8aad0a121f2034` |
| `t12-red.log` | `4c4dbbb51ba31c78ab6b42be95057794fea9ef6f358f197245f74bc2f4b913cb` |
| `t12-retention-red.log` | `21fb8c58fb654162d1233d3917350c15ad5be580370bdcc3b60d858df73197b2` |
| `t12-retention-green.log` | `1933a72bc04dc940a2a76ee714e6ee2ba630016959c9f3e60beab991bbf946ec` |
| `t08-model-block-red.log` | `137099caf65e5284842211c73ffcac8b04125a03ff42842b7d5213bb515588b7` |
| `t08-boundary-green.log` | `c31219bd9bff5269f45ef3c9ed7d485cd50b6fa02373d0425a827aacf5510dd1` |
| `t10-error-red.log` | `4fabb46d4aec016896bc974dcc861d056203c6dfe33f72e269066cf4e65c4ca9` |
| `t10-error-green.log` | `85f160be7be8e1c8d8eb350a0033902ea0ad65ce3f820f8a9fa8f5c8324ee01a` |
| `t11-admin-red.log` | `e50209d4165a89a7f7c8d511ebb8190bd29e56f12f61a1a7679c78b138fc56f9` |
| `t11-admin-green.log` | `0739f1691d5adaa72d520ede7759645ed49586efcf42df04ef1da339edbbf8ab` |

## 后续真实验收更新

本记录为先前离线验收快照。随后经用户批准执行四次真实创建，修复 Seed3D 响应元数据兼容，3D 产物链路成功，其余三项受额度限制；另有 low/medium 参数差异。当前状态以 [T13 真实验收](ark-media-live-acceptance.md) 为准。
