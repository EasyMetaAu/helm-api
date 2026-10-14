# Seedream 图片入口集成证据（T05/T09）

日期：2026-10-14。范围：本地图片路由与 image-chain 离线验证；主控负责配置、server组合、导出和最终验收。未部署，未调用真实方舟接口。

## 基线与提交边界

工作区：`/Users/lukin/Projects/.worktrees/ark-media-t01-contract/helm-api`。
分支：`codex/ark-media-t01-contract`。

- T01：`b801e18b529e1840c58fcea7d4714dc69cbec91e`。
- 合入 T02 原提交 `b22ed646158d5085019de478a408a979c8f06403`，本地 cherry-pick 为 `ddf3b385174f5a593018a37dffbbdd95ea141777`，这是本次修改的父版本。
- 本次只改 `apps/gateway/src/routes/images.ts`、`images.test.ts`、`image-chain.ts`、`image-chain.test.ts`，新增本文件。未改 server、barrel、catalog/config、锁文件或 shared schema。

## 已实现行为

1. 在原 `/v1/images/generations` 入口，根据 resolver 返回的 **最终 providerModel** 选择严格 Ark schema。原始 wire ID、`ark/seedream-5.0-flash`、`ark/seedream-5.0-pro`、`seedream-flash`、`seedream-pro` 以及已配置任意 alias 都不能绕过字段/组合校验。公开名映射仍由主控 server 提供，本路由没有硬编码这些别名的供应链解析。
2. 通用入口只为 `layer_decomposition:true` 暂时允许省略 prompt；解析目标后仅 Seedream 允许此请求。非 Ark 仍使用原 prompt 约束。普通文生图、单图编辑、多图参考及图层拆分均走 images/generations，严格字段不会被丢弃或转换。
3. 已核实的 Seedance/Seed3D wire ID 不得走图片接口；Seedream 不得走 `/v1/images/edits`，即使误配的 client 暴露 imageEdit 也拒绝。Ark 图片目标不能通过 Gemini 翻译路径调用。
4. 成功返回保留全部图层、坐标、名称、说明及 usage。先验证严格结果结构、实际 model、图层模式和 URL/Base64 delivery 与请求一致，再返回原始对象。缺产物、错误模型、图层信息缺失、delivery错配均作为结果不明终止，不发生第二次创建。
5. Ark 图片成本固定为未知（null），不走聊天token价格。spend-capped key 在上游前返回422 / `media_pricing_unavailable`；即使 pricing hook 缺失或错误地返回 true 也保持拒绝。已有请求数/token预算、鉴权、blocked-model、内存/并发准入保持原路径。
6. 保留现有开始创建后不重试、不fallback的执行规则。新增识别 T02 `ArkMediaError.outcome`：`not_sent`→503/provider_unavailable，明确拒绝→上游机器错误码，`unknown`→503/outcome_unknown。400/413/422保留对应HTTP状态，429保留429；上游401/403等拒绝映射502，避免误称Helm调用方鉴权失败。确定拒绝和未发出不计provider熔断失败；结果不明保持熔断失败。
7. Ark错误对外只返回固定消息与最多128字符的字母/数字/下划线/点机器码，丢弃原始错误正文，避免账户标识、签名URL或凭据进入公开错误及常规attempt日志。未知结果不暴露上游机器码。其他provider现有错误行为不变。

## 红绿测试

日志保存在仓库外：`/Users/lukin/Documents/Codex/2026-10-14/helm-seedance-research/`。

| 证据 | 结果 |
|---|---|
| `t05-red.log` | 24失败、61通过；验证旧入口缺少严格Ark校验、无prompt图层支持、正确错误分类及响应关联验证 |
| `t05-correlation-red.log` | 2失败、95通过；plain图返回给图层请求、URL返回给b64请求被旧路径误判成功 |
| `t05-green.log` | 最终98/98通过：images 74，image-chain 24；含原有OpenAI/Grok/Gemini、预算及单写保护用例 |
| `t05-typecheck-integration.log` | 跨包源码类型检查通过，退出0 |
| `t05-biome.log` | 四个TS文件格式与lint检查通过 |

定向测试命令：

```bash
CI=true pnpm exec vitest run --project node \
  apps/gateway/src/routes/images.test.ts \
  apps/gateway/src/routes/image-chain.test.ts
```

SDK闭环测试实际经过 Hono入口 → Ark SDK → 注入的离线 fetch，未访问网络。Flash/Pro各覆盖成功、400、429、503、连接失败；另有真实AbortSignal超时。每项都验证一次POST、没有fallback；成功请求验证最终wire model和原请求字段，失败验证不泄漏测试凭据及账户文本。

类型/格式检查：

```bash
CI=true pnpm exec tsc --noEmit -p apps/gateway/tsconfig.json --rootDir .
pnpm exec biome check apps/gateway/src/routes/images.ts \
  apps/gateway/src/routes/images.test.ts \
  apps/gateway/src/routes/image-chain.ts \
  apps/gateway/src/routes/image-chain.test.ts
```

依赖用 `CI=true pnpm install --offline --frozen-lockfile --ignore-scripts` 在本工作区安装，锁文件无变化。Vitest读取根配置时提示admin缺少生成的`.svelte-kit/tsconfig.json`；仅执行node项目，相关测试完成并退出0。没有启动服务或留下测试进程。

## 主控仍须集成验收

- 当前按并行约定直接相对import shared schema与core ArkMediaError。默认 `pnpm --filter @helm/gateway typecheck` 会产生TS6059（源码跨出gateway rootDir）；已修复测试中的unknown类型错误，`--rootDir .`检查全量gateway源码依赖通过。主控须添加barrel并改为包import，再跑标准类型检查/构建；本任务不能宣称标准构建或CI已通过。
- server必须配置上述公开模型映射及Ark client，resolver将Ark标为isPriced=false、保持模型权限与媒体能力隔离。本次测试注入resolver不代替实际server配置验收。
- image-chain在**尚未开始调用**时仍可因本地熔断跳过候选；开始调用后绝不换provider重发。模型发现/配置层应固定所请求的模型，不利用聊天fallback替换媒体模型。
- spend-capped图片请求继续拒绝；按实际图层和像素档位结算金额未在此任务开放。usage保真不表示计费验收完成。
- 未跑全仓测试、远程CI、真实付费生成或生产验证。真实产物、上游实际格式/大小、公开alias从server端到端解析，以及最终预算/权限联合验收归主控后续任务。
