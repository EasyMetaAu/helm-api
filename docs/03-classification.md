# 03 · 分类级联

## 分类级联（Classification cascade）

这是 Helm 的核心。请求进入后，按三层顺序决定 lane，命中即停：

```text
请求进入
  → 第 1 层：确定性规则（rules）            [始终开启，零成本、零延迟]
        命中且 confidence ≥ 阈值 → 直接进对应 lane
  → 第 2 层：小模型评估（eval）              [默认关闭，带缓存]
        小模型判出 complexity / task_type → 进对应 lane
  → 第 3 层：兜底 → balanced lane           ← 永远安全的默认
```

**关键区分：两种 fallback 是两件事，必须分开记录。**

- **分类兜底（classification fallback）**：我不知道这是什么任务 → 落到 balanced lane。
- **执行兜底（provider fallback）**：选中的 provider 挂了 / 超时 / 限流 → 走 lane 链内的下一个 model。

第一个发生在"选 lane"阶段，第二个发生在"执行 lane"阶段。两套机制、两套日志字段，绝不能混淆。执行兜底见 [04 · 路由与 Lane](04-routing-and-lanes.md)。

## 任务分类

分类器输出：

```yaml
complexity: simple | standard | complex | reasoning
task_type: chat | coding | math | writing | extraction | tool_use | vision | web | data
confidence: number          # [0,1]，低于阈值则进入下一层
constraints:
  needs_tools: boolean
  needs_json: boolean
  needs_vision: boolean
  long_context: boolean
  low_latency: boolean
  low_cost: boolean
```

分类器的输入可以使用：

- 当前用户消息
- 最近的若干条消息
- 工具定义
- 响应格式
- 最大 token 目标
- 附件 / 多模态元数据

## 第 1 层：确定性规则（参考 Manifest）

第一层是本地、确定性、零成本的加权评分，借鉴开源 Manifest 模型路由器的设计：

- **加权维度评分**：一组关键词 / 结构 / 上下文维度，每个维度有权重和方向，累加成一个 `rawScore`。
- **四档复杂度**：用固定边界把分数映射到 `simple | standard | complex | reasoning`。
- **任务检测**：按关键词集合、工具名前缀、结构信号（URL、代码块、文件路径、堆栈）识别 `coding / web / data / vision` 等任务类型。
- **会话动量（momentum）**：短的后续消息按历史会话倾向加权，避免单条短消息把分类带偏。
- **硬覆盖与捷径**：心跳类（如 `HEARTBEAT_OK`）直接判 simple；形式逻辑关键词直接判 reasoning；带 tools 的请求下限为 standard；超长上下文（如 > 50k token）下限为 complex。
- **置信度闸门**：`confidence = 2·sigmoid(k·到最近边界的距离) − 1`，归一化到 `[0,1)`——贴边界（距离→0）≈0（最不确定），远离边界≈1（最确定）；低于阈值（默认 `0.45`）视为"不确定"，进入第 2 层。（注：旧实现用裸 `sigmoid`，落域 `[0.5,1)`，默认阈值 0.45 永不触发——已由 `classifier.confidence-fix` 修正，见 implementation-notes。）

可移植性：维度名/权重/关键词列表/边界/阈值都是**数据**，应当放进 `classifier.yaml`，可调而不需改代码；少量结构信号正则和控制流是代码实现。具体维度/阈值见 [调研笔记](research-notes.md)。

## 第 2 层：小模型评估（LLM eval）

当第 1 层不确定时，用一个便宜的小模型对内容做一次评估，结果决定 lane。**默认关闭**。

```yaml
classifier:
  rules:
    enabled: true
    confidence_threshold: 0.45     # 低于此值才进入 eval

  eval:
    enabled: false                 # 默认关闭
    model: deepseek/deepseek-v4-flash   # 便宜、快、JSON 可靠；可替换
    temperature: 0
    max_tokens: 256                # 只输出一个 JSON，封顶成本
    timeout_ms: 300                # 超时即放弃，不阻塞主路径
    on_failure: balanced           # 超时/解析失败 → 默认 lane
    cache:
      enabled: true
      key: content_hash            # 规范化(最后用户消息 + tools 签名)
      ttl_sec: 300                 # 不必每次都评估
```

设计要点（借鉴 llm-router 的 probe，但改为可决策）：

- 输出严格 JSON：`{ complexity, task_type, confidence }`，校验失败即 fail-open 到 `balanced`。
- `temperature: 0`、非流式，结果可缓存。
- 与 llm-router 的 probe 不同：probe 是"仅咨询、不改路由"；Helm 的 eval 是"可决策"——它的输出直接选 lane。
- 缓存按 **content-hash**（而非 conversation_id），因为网关是无状态的；同样/相似请求命中缓存，不重复评估。
- 评估调用本身也经过一个 provider，因此它在配置上是一个内部的小模型，不属于对外的三条 lane。

probe 复用细节见 [调研笔记](research-notes.md)。
