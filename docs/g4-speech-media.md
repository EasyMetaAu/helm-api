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

## 文件转写入口

`POST /v1/audio/transcriptions` 接收 multipart：`file`、`model`（lane 或获授权的 alias），可选重复 `languages[]` / `keywords[]`、`prompt`、`timestamps=word|sentence`、`diarize=true|false`；只支持 JSON 结果。每个文件上限 25 MiB，长材料须由调用方按实际音频边界分块。

配置 provider `type: openai-audio` / `deepgram`，分别使用 `https://api.openai.com/v1` / `https://api.deepgram.com/v1` 和静态 `api_key_env`。模型映射为 `gpt-transcribe` / `nova-3`，再配置单独转写 lane。配置生效不代表该账户已开通。

统一结果包含 `text`、可选 `languages`、`words` / `segments`（startMs/endMs）、`requestId`、原生 `usage`。OpenAI 不接受词时间戳或 diarization，返回 422 `unsupported_parameter`；Deepgram 保留真实词时间戳与 speaker，将秒换算为毫秒，暂支持单通道、单语言／multi。缺词时间戳不补值。

稳定错误：400 `invalid_request`；403 `model_not_allowed` / `lane_not_allowed`；413 `request_too_large`；422 `unsupported_parameter` / `media_pricing_unavailable`；503 `provider_unavailable`；上游明确拒绝 `upstream_rejected`，提交或结果连接中断／服务端故障 `outcome_unknown`，不自动重试。此同步 API 的供应商没有通用结果查询保证，unknown 不等于未扣费。

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

## 豆包语音

配置 `type: doubao-speech`、`base_url: https://openspeech.bytedance.com`、静态 `api_key_env` 与稳定 `media_account_id`。TTS 模型映射 `seed-tts-2.0`，录音 ASR 映射 `bigmodel`，分别配置 lane。凭据及音色必须由部署方确认授权。

TTS 支持 mp3 / pcm / opus、8–48 kHz 的官方离散采样率；采用 2.0 `enable_subtitle`，统一映射 `sentence.words.startTime/endTime` 秒为毫秒。原生 `text_words` 保留，并映射到统一计费字符字段。HTTP 输出时长没有官方可靠总长字段，省略 durationMs；不能用字幕末尾代替音频总长。WS 为缓冲输入模式：append 累积文本，finish 才发起一次 HTTP SSE 合成，不提供 flush/cancel；关闭连接会中断本地请求，收费结果仍可能未知。

`POST /v1/audio/transcription-jobs` 示例：

```json
{"model":"doubao-asr","audio":{"url":"https://owned.example/audio.wav","format":"wav","language":"en-US"},"request":{"enable_punc":true}}
```

响应沿用 `request_id + status`，`GET /v1/audio/transcription-jobs/{request_id}` 返回统一 `transcription.text/segments` 与毫秒时间戳。使用官方 submit/query，供应商请求 UUID 在 submit 前进入现有持久任务记录。提交断线返回 `outcome_unknown + operation_id`；查询 `/v1/audio/transcription-jobs/operations/{operation_id}` 恢复映射后只查询同一 UUID，不提交新任务。重复请求码 45000001 保持未知，不认定为可安全重发。

## 费用与预算

SQLite v58、Postgres v57 增加 `media_spend_records`。费用记录和预算扣减在事务中处理，各 SQL 只访问一张表；原有请求／token 配额继续执行。先占用 USD 额度再调用供应商，确认结果后按原生用量结算并释放差额；未知结果保留预留。结算幂等，记录按 keyId 隔离。

HTTP JSON 结果新增 `accounting`：`operationId/state/reservedUsd/costUsd/costBasis`；二进制 HTTP 用 `x-helm-media-operation-id` 返回查询 ID。`GET /v1/audio/operations/{id}` 使用同一 API key 读取其费用记录和原生 usage。`costBasis=list_price` 表示配置价卡计算，不能作为供应商发票金额。状态 `reserved` 尚未完成、`outcome_unknown` 待核对、`settled` 已完成本地结算；未知记录不能作为免费失败自动重试。

WS 的 start.request 可增加 `max_input_characters`（1–10000 个 Unicode 码点）。spend-capped key 必须声明此上限，先预留整个会话，再发起上游；append 超限返回 `input_limit_exceeded`，该段不发送。声明上限或选择 output=json 后，先返回 `accounting` 事件及 operationId。单条字幕或 usage 事件不是最终收费确认。

可用于准入的价卡必须匹配实际 providerModel。字符型价格需明确 `billing.maxCharactersPerInputCodepoint`；CNY 还需部署方明确 `billing.usdPerCurrencyUnit`。同步 ASR 秒价需明确 `billing.roundingSeconds`，首批仅支持完整单声道 PCM16 WAV 的本地时长；diarize、多语言/multi 和 keyterm 附加计费未核定时拒绝受限调用。

这些 billing 字段必须来自供应商或账户合同。当前默认价卡没有填入未经证实的字符上界或汇率；因此默认 MiniMax 国际服务的 spend-capped 调用仍可能返回 `media_pricing_unavailable`。MiniMax 国际文档只明确字符单价和首次音色费用，没有公布输入长度与计费字符的硬上界；正数 usage_voice_count 也不区分设计音色和复刻音色，无法精确结算时保留未知。异步 URL ASR 的时长预留尚未接入，继续拒绝 spend-capped 调用。

## GPU 接口与 H04 状态

`type: whisperx-asr` 使用旧独立服务的同步 `/transcribe` multipart 协议，通过 `/v1/audio/transcriptions` 调用，模型映射 `whisperx`。配置须指向部署方控制、带认证的 HTTPS 代理；原服务本身未确认具备鉴权。发送 `sync_mode=true` 与 `skip_cache=true`，绕过忽略语言选项的旧缓存读取；保留真实 segment/word 时间戳，秒转毫秒，无时戳的词不补值。服务原生 audio_duration 转 durationMs。原服务仍会写自己的缓存，未对其做任何修改。

lane 中 API 排在首位、WhisperX 位于 fallback，可在 API provider 未配置凭据／不可解析时选择 GPU。调用已发出后的失败不会自动转发 GPU，未知付费结果不会重试。API 明确拒绝后的自动切换、家庭 GPU 实际网络／推理验收，以及 Chatterbox 通用接入仍未交付；旧服务没有可依赖的未知任务查询语义，新 Chatterbox compute.v1 固定 dictogo，且尚缺独立可调用部署契约。

## Luma 交接状态

| 项目 | 本地实现 | 可调用与验收条件 |
|---|---|---|
| H01 | MiniMax／百炼／豆包真实字幕贯通 HTTP JSON 和 WS | 部署本分支并配置真实音色后验收；缺字段省略 |
| H02 | OpenAI／Deepgram 文件转写、豆包 TTS／异步 ASR | 需部署、配置凭据及模型权限；长材料按 25 MiB 文件限制分块 |
| H03 | HTTP/WS TTS 与同步文件 ASR 原生 usage、持久账本、原子预留和幂等结算 | 硬上限只在可核定价卡下放行；默认国际字符上界、FX、异步 ASR 预留仍有缺口 |
| H04 | WhisperX 同步协议 adapter 与 lane 选择入口 | 实际 GPU 服务、未知结果对账及调用后自动切换尚未验收／交付 |

按句 TTS 先使用 MiniMax JSON 的 audio、contentType、原生 durationMs；Luma 上传自有存储后形成 url + durationMs，不依赖逐词字幕。当前包版本未发布；未推送、合并、部署或执行收费调用，生产入口尚不可依赖这些新增字段。

## 本地验证

2026-11-12：17 个定向测试文件、106 项测试通过，覆盖字幕与协议映射、HTTP/WS、权限、豆包提交恢复、费用预留／结算、双数据库与新增迁移。未知转写异常返回 outcome_unknown 和持久 operation_id，且不重复调用上游。shared/core/gateway 类型检查与构建、变更 TypeScript 的 Biome 检查通过。以上不替代远程完整 CI、真实供应商调用或 GPU 验收。
