# 09 · MVP 路线图与成功标准

## MVP 路线图（分阶段）

按"每阶段都能独立跑起来"的顺序推进，不追求一次到位：

- **Phase 0 — 骨架**：HTTP 网关 + Auth（启动引导 key、强制鉴权）+ 单协议直通（OpenAI Chat）+ 遥测落库 + **Docker 部署**（配置/数据挂载卷）。能鉴权、能转发、能记日志、能容器化跑起来。
- **Phase 1 — 路由核心**：第 1 层确定性规则分类器 + 三条默认 lane + Provider 执行器 + 能力过滤 + 熔断器 + fallback 链。可服务真实流量；分类不确定落 balanced。
- **Phase 2 — 协议互译**：Protocol Adapter（OpenAI ↔ Anthropic 双向 + 流式），按 musistudio 蓝本重写。客户端可混用 SDK。
- **Phase 3 — eval 层**：第 2 层小模型评估 + content-hash 缓存（默认关闭）。开启后判定能选 lane。
- **Phase 4 — 管理界面**：Web 控制台（HTTP Basic 认证）= 基本规则管理（lane / policy / classifier / key）+ 请求调试（列表/详情/决策链）。
- **MVP 之后**：Gemini 协议、Memory 中间件、限流/配额完整化、Signals 反馈层。

## MVP 成功标准

- 新客户端可以把一个 OpenAI 兼容的 SDK 指向 Helm，无需自定义配置即可获得可用的路由。
- 默认的 economy / balanced / premium lane 开箱即用，且 LLM 评估默认关闭。
- 启动时若无 key，自动生成一把 root key；无 key 的请求被拒绝。
- 第 1 层规则能确定分类时直接进对应 lane；不确定且 eval 关闭时落到 balanced。
- 开启 eval 后，小模型的判定能选 lane，且相同请求命中缓存不重复评估。
- 一个 coding 请求在配置了 coding lane 时能路由到该 lane，否则回退到 premium 或 balanced。
- 一个带 JSON 约束的请求绝不会悄无声息地被路由到一个会忽略 JSON 约束的模型。
- 任何出乎意料的 provider 选择都能从请求日志中得到解释（包括是哪一层、哪条规则、哪个 provider 尝试导致的）。
