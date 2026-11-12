# G4 语音与媒体接入

## 当前完成点

现有 `/v1/audio/speech` 默认保持原二进制音频返回。增加显式 JSON 模式：

```json
{"model":"speech-fast","input":"Hello","voice":"已授权音色","output":"json","timestamps":"word"}
```

返回 `audio`（base64）、`contentType`、可选原生 `usage`、可选 `timestamps`。时间戳结构：

```json
{"text":"Hello","textBegin":0,"textEnd":5,"startMs":20,"endMs":420,"words":[{"text":"Hello","startMs":20,"endMs":420}]}
```

`textBegin/textEnd` 仅在上游提供时返回。缺少时间戳时省略，调用方不得补平均时间。请求时间戳且未选择 JSON，或 HTTP 同时选择 JSON 与 stream，返回 422 `unsupported_parameter`，上游不执行。

`/v1/audio/tts` WebSocket 的 start.request 接受 `timestamps`；新增事件 `{"type":"timestamp","sequence":1,"timestamp":{...}}`，音频、终止、取消事件不变。MiniMax 使用 sentence/word 完整片段，不使用累计的 word_streaming。百炼解析原生 sentence-end 字级对齐；支持取决于模型和音色。

MiniMax HTTP JSON 通过一次流式上游合成收集字幕和音频，不执行第二次生成。音频保留现有 16 MiB 收集上限。MiniMax `audio_length` 原单位毫秒，`usage_characters` 与 `usage_voice_count` 保留原生字段。百炼累计计费字符数转为 session usage 事件增量。

## 实现顺序与依赖

1. 现有 MiniMax／百炼字幕、用量与 HTTP/WS 贯通。
2. OpenAI gpt-transcribe multipart 和 Deepgram Nova-3 文件转写；豆包 TTS 2.0 与录音 ASR 按各自官方协议接入。
3. 原生 usage、价卡与持久费用记录，预算原子预留／结算，未知费用保留待核对。
4. API 优先的最小后备；付费结果不明时只查询／对账，不自动重发。

## 协议证据

- [MiniMax HTTP](https://platform.minimax.io/docs/api-reference/speech-t2a-http)：subtitle_enable、subtitle_type、data.subtitle、毫秒时戳。
- [MiniMax WS](https://platform.minimax.io/docs/api-reference/speech-t2a-websocket)：task_continued.data.subtitle；is_final 不携带字幕。
- [百炼客户端事件](https://help.aliyun.com/zh/model-studio/cosyvoice-client-events)：word_timestamp_enabled、支持模型与音色限制。
- [百炼服务端事件](https://help.aliyun.com/zh/model-studio/cosyvoice-server-events)：sentence-end.words、begin_time/end_time（毫秒）、usage.characters（累计）。
- [OpenAI 转写](https://developers.openai.com/api/docs/guides/speech-to-text)：gpt-transcribe 使用 languages[]；timestamp_granularities 是旧 Whisper 专属，不能套用。
- [Deepgram Nova-3](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded)：二进制或 URL JSON，不是 OpenAI multipart。
- [豆包 TTS](https://www.volcengine.com/docs/6561/1598757)：2.0 使用 enable_subtitle；无 SSE 恢复保证。
- [豆包录音 ASR](https://docs.volcengine.com/docs/zh/doubao-voice/large-model-recording-file-recognition-standard-version-api.md)：先持久化请求 UUID，submit 后按同 UUID query，重复提交错误不能改 UUID 重发。

## 限制与待验收

尚未执行收费调用、真实音质／时戳评测、远程 CI 或生产部署。Mock／受控传输测试只证明本地协议处理。

GPU 协议核实：旧 asr-service `/transcribe` 接收 multipart，WhisperX 时间单位秒；其 `/transcription/{file_id}` 在缓存不存在时均返回 processing，不能区分失败／未接受，且无已确认鉴权。新 asr-node／alignment-node 的 compute.v1 固定 `application=dictogo`、不可变 artifact 与回调协调方；Chatterbox 节点文档注明尚未构建部署。此次无权修改旧业务或 GPU 服务，不能宣称已有可直接切换的安全后备。
