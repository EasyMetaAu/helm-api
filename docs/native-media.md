# 阿里百炼与 MiniMax 媒体接口

本集成使用已有 OpenAI Node SDK 调用千问 Images 兼容 API。视频、文件识别与语音使用官方原生 HTTP/WebSocket 协议；没有 Python 服务、第三方模型代理或整套 SDK 重写。

## 配置和启用

`config/providers.yaml` 已提供两个可选 provider，分别引用 `BAILIAN_API_KEY`、`MINIMAX_API_KEY`。未设置凭证时不创建客户端。密钥仅由运行环境注入。

- `bailian-media` 的 `base_url` 必须以 `/api/v1` 结尾。同一 origin 的 `/compatible-mode/v1` 用于千问图片与短 ASR，`wss://<origin>/api-ws/v1/inference` 用于语音。
- `minimax-media` 使用 HTTPS origin，例如 `https://api.minimax.io`。视频为 v2；语音为 `/v1/t2a_v2` 和 `/ws/v1/t2a_v2_bidi`。
- 为 `media_account_id` 设置稳定的内部账户标识；不同账户不可复用该标识。配置没有验证该账户已开通某模型。工作空间专属域名是否开放原生 `/api/v1`、WebSocket 仍需账户实测，不能由 Chat 兼容域名推断。
- 任务绑定账户标识、endpoint 和凭证指纹。修改其中任一项后旧任务查询返回 409；在证明账户一致前不自动迁移任务。

默认 lane：`qwen-image`、`wan-video`、`minimax-video`、`bailian-speech`、`minimax-speech`、`transcription-short`、`transcription-file`。给调用 Key 授权对应 lane；使用具体 alias/wire model 另需 `allow_custom_model`。不要把短 ASR 混入普通聊天 lane。

模型清单由配置显式维护。千问图片支持 3.0/3.0-pro/2.1-pro/2.1-turbo；万相支持 3.0-video/video-prime；MiniMax 视频支持 H3/H3-Max；TTS 包括配置中的千问 Audio、CosyVoice 和 speech-2.8。每个模型的地域、音色和账户权限仍由上游确认。

## 请求示例

以下只展示 JSON；发送到 Helm 时使用自己的 Helm Key，不使用上游 Key。

| 接口 | 示例 body |
|---|---|
| `POST /v1/images/generations` | `{"model":"qwen-image","prompt":"一只小鸟","size":"1024x1024"}` |
| `POST /v1/videos/generations`（万相） | `{"model":"wan-video","input":{"prompt":"小鸟飞过湖面"},"parameters":{"duration":5,"resolution":"720P"}}` |
| 同接口（MiniMax） | `{"model":"minimax-video","content":[{"type":"text","text":"小鸟飞过湖面"}],"duration":4,"resolution":"768P","ratio":"16:9"}` |
| `POST /v1/audio/speech` | `{"model":"minimax-speech","input":"你好","voice":"<该模型已开通音色>","response_format":"mp3"}` |
| `POST /v1/audio/transcription-jobs` | `{"model":"transcription-file","input":{"file_url":"https://your-cdn.example/audio.mp3"}}` |

千问参考图编辑使用 Images generations 的 `image` 扩展（URL、Data URL 或数组），不是 multipart `/images/edits`。长 ASR 的 Qwen3 使用 `input.file_url`，其他已配置文件模型使用单元素 `input.file_urls`。结果保留各文件成功/失败状态，成功文件的识别 JSON 位于 `transcription.results[].transcript`，其中保留文本、时间及供应商提供的说话人信息。仅在模型本身返回相关字段时才有对应信息。

短 ASR 走原生 Chat 兼容契约，专用处理路径跳过分类、memory 和普通文本 fallback，保留 URL/Data URL 与 `asr_options`：

```json
{"model":"transcription-short","messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":"https://your-cdn.example/audio.mp3"}}]}],"asr_options":{"language":"zh","enable_itn":true}}
```

支持 `stream:true` 和 `stream_options.include_usage`。这个入口不接收 Whisper multipart；音频数据不补写虚构的 WAV 格式。

## 异步任务与恢复

创建返回 Helm `request_id`，用原 Key 查询 `/v1/videos/{request_id}` 或 `/v1/audio/transcription-jobs/{request_id}`。不同 Key 即使同属一个账户也不能读任务。模型封禁、lane 权限和当前 provider 身份仍会重新校验。

创建请求只发送一次。网络超时或响应不完整返回 `outcome_unknown` 与 `error.operation_id`；不要重新创建。查询对应 `/operations/{operation_id}` 可了解状态。如果已经保存上游任务 ID，查询会恢复稳定公开 ID 并返回 `request_id`，之后可继续取结果；如果上游 ID 从未收到，仍需上游账户侧人工对账。没有凭空查询、取消或重发机制。

任务记录保留 7 天；阿里查询窗口按 24 小时，MiniMax 按 7 天处理。产物链接有效期独立；不将保留期或查询期宣称为视频下载有效期。结果下载不带 API Key，要求公网 HTTPS，逐跳校验 DNS/IP、固定连接地址，限制大小和总超时。

## 语音流

`POST /v1/audio/speech` 默认返回完整音频；`stream:true` 返回音频字节流。流中错误不能改成正常 JSON，应视为中断。原有 xAI `/v1/tts` 接口保留。

`WS /v1/audio/tts` 是 Helm 扩展，不是 OpenAI Realtime。握手使用 `Authorization: Bearer <Helm Key>`，客户端按顺序发送：

```json
{"type":"start","request":{"model":"minimax-speech","voice":"<音色>","response_format":"mp3"}}
{"type":"append","text":"你好。"}
{"type":"finish"}
```

服务端发送有序 JSON 控制/usage 事件和二进制音频。是否支持 `flush`、`cancel` 由会话声明；不支持则拒绝。连接关闭、超时、完成和异常都释放并发名额。MiniMax 2205 只在明确未接受文本且该协议允许时进行有限重发，不重连重播已接受的文本。

## 费用与验收边界

当前原生媒体 USD 定价没有可靠配置，费用保留 `null`。有 spend cap 的 Key 在发请求前拒绝；请求次数、并发、模型权限继续执行。普通日志只含结构化状态/usage，不含密钥或输入正文。成功后的辅助记账失败会记录错误，不丢弃已付费产物。

离线 HTTP/WS fixture 测试验证协议与边界；不能证明账户已开通模型、音色可用或实际扣费正确。真实付费验收需要单独明确模型、次数、输入、价格范围；本次代码合并不等于生产部署或真实模型验收。
