# 05 · 协议互译

Protocol Adapter 把多种客户端协议与任意上游 provider 协议互译，让客户端只见统一的标准与输出。各协议互译的开源参考、覆盖矩阵与坑位清单见 [调研笔记](research-notes.md)。

## 职责

- 将 OpenAI / Anthropic / Responses / 未来的 Gemini 请求归一化为统一的内部请求结构。
- 将提供方的响应转换回客户端所请求的协议。
- 保持流式语义（SSE 事件跨协议映射）。

## 设计

以 **musistudio/llms** 为架构蓝本，**litellm** 作正确性规范；不抄代码，自行重写。

- **统一中枢（IR）用 OpenAI Chat 形态**，扩展 thinking/推理块、多部件 content、tool-call ID、`provider_raw` 透传袋（装上游原生 `stop_reason`/`usage`）。
- **每协议一个类、5 方法契约**（`transformRequestOut/In`、`transformResponseOut/In`、`endPoint`），入站+出站同处一文件。
- **翻译永远 `nativeIn → IR → nativeOut`**，绝不 N×N 直连（N 协议 = 2N 变换函数）。
- **流式 = 显式状态机**：content-block index 分配器、tool-call-index→block-index 映射、临时 id→真 id 升级、幂等关闭守卫；为缓存命中/非流式上游提供 JSON→SSE 合成器。
- **横切关注点做成可叠加 transformer**（max-token 钳制、tool-use 归一、reasoning 注入）。

## 必须处理的坑

- finish_reason / stop_reason 枚举错配（映射成合法枚举 **并** 把原始值存进 `provider_raw`）。
- usage 字段翻译与缓存计费（`input = prompt − cached`，流式末事件 buffer usage）。
- tool-call 流式的 index/ID 协调（维护映射、临时 id 后补升级、容忍残缺 JSON）。
- 流式 block/part ID 与 role 一致性（先 start 再 delta 后 stop；OpenAI 首片带 `role:"assistant"`）。
- system 提示与多模态结构错配（Anthropic 顶层 `system`、禁连续同角色；图像 `image_url` vs `source:{base64}`）。
- Responses API item 展开（照 litellm 的 spec 补齐）。

错误也要按客户端协议形态翻译，见 [07 · 可观测性](07-observability.md)。
