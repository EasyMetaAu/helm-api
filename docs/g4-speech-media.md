# G4 语音与媒体接入

## 线上验收与采样率

v0.30.81（`7f01721e`）已在目标实例完成真实短音频验收：MiniMax speech-2.8-turbo 与百炼 qwen-audio-3.0-tts-plus 的 HTTP／WebSocket 音频及原生时间戳正常；百炼 qwen3-asr-flash 正确转写生成音频。MiniMax 两次各 28 个计费字符，价卡费用各 USD 0.00168；百炼两次各 28 字符，美元结算因缺汇率保持未知。该结果不代表供应商账单核对完成。

从 v0.30.82 起，百炼省略 `sample_rate` 时使用官方默认 22050 Hz；支持显式 8000、16000、22050、24000、44100、48000 Hz，其他值在建立上游连接前拒绝。MiniMax 保持原默认 32000 Hz。HTTP 与 WebSocket 使用相同默认规则。

CosyVoice 3.5 使用 v3 系统音色时上游返回 418；目标账户没有已创建音色，仍需匹配模型的授权音色。百炼美元结算仍需有效汇率配置，MiniMax spend-capped 调用仍需供应商计费字符硬上界。OpenAI、Deepgram、豆包与 GPU 尚未配置，不计为线上验收通过。

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

## 百炼短 WAV ASR 费用路径

`POST /v1/chat/completions` 的 `transcription-short` lane 可在非流式、完整单声道 PCM16 WAV data URL 输入时复用转写账本。发送前按实际帧数核定时长并持久预留，成功后按供应商 `usage.seconds` 结算。响应保留原有 Chat 内容与 usage，并增加 `accounting` 和 `x-helm-media-operation-id`；用所属 key 查询 `/v1/audio/operations/{operationId}`，只能读账，不能恢复转写文本。

放行 spend-capped key 要求该模型的单一输入音频秒价，以及显式可信的 `billing.roundingSeconds`；CNY 卡还须配置 `billing.usdPerCurrencyUnit`。官方当前秒价页没有建立本账户取整/最小收费单位，“不足一秒按一秒”的音频 token 换算不能作为账单取整证明。本次不设置默认值、不改生产价卡；缺计费依据继续 422。带 cap 的流式、URL、压缩或残缺 WAV 输入也保持关闭。现有未受限 URL/流式协议保持原行为。

网络后未知、5xx、缺失/无效 usage 不写零费用、不重发，保留预留及 operation ID；只有确认未发送或明确拒绝才零结算。账本保存原生 seconds 的 duration 用量，遥测记录结算费用及 operation 日志，不把秒伪装为 token。没有新增 SQL 或幂等框架。

调用方必须在发送前持久化业务 attempt 与 pending 状态，固定音频身份；返回后立即保存 operation ID、实际结果及 usage。HTTP 响应完全丢失时，Helm 当前没有按调用方自选 ID 找回结果的通用接口，先核对已有日志/账本，不能自动建新 attempt 重发。此片测试源码先行但按高负载限制未运行，亦未类型检查/编译/部署，不计为真实 ASR 费用验收通过。

2026-11-13本地定向验证：4个测试文件26项通过，core/gateway类型检查通过，独立只读审查无具体可达P0/P1。远程CI、镜像与生产运行读回尚待；当前价卡仍缺可信取整/FX，未新增收费调用或修改配置。

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

真实供应商收费调用及音质／时戳评测仍需按实际账户、音色和预算验收。Mock／受控传输测试只证明协议处理；部署版本须从目标服务 `/version` 核对。

GPU 协议核实：旧 asr-service `/transcribe` 接收 multipart，WhisperX 时间单位秒；其 `/transcription/{file_id}` 在缓存不存在时均返回 processing，不能区分失败／未接受，且无已确认鉴权。新 asr-node／alignment-node 的 compute.v1 固定 `application=dictogo`、不可变 artifact 与回调协调方；Chatterbox 节点文档注明尚未构建部署。此次无权修改旧业务或 GPU 服务，不能宣称已有可直接切换的安全后备。

## 豆包语音

默认配置新增独立 provider `doubao`，类型 `doubao-speech`，端点 `https://openspeech.bytedance.com`，静态环境变量 `DOUBAO_SPEECH_API_KEY`，稳定 `media_account_id: doubao-speech-default`。缺凭据时跳过该可选客户端，不在启动时执行付费探测。两条 lane 均单候选、无 fallback，且不加入通用文本链：

| lane / alias | 本轮支持范围 | 官方接口与资源 |
|---|---|---|
| `doubao-speech` → `doubao/seed-tts-2.0` | 一次输入文本，HTTP SSE 返回音频与中/英文原生字幕；Helm HTTP binary/JSON 及缓冲 WS | `/api/v3/tts/unidirectional/sse`，`X-Api-Resource-Id: seed-tts-2.0` |
| `doubao-transcription-file` → `doubao/bigmodel` | 供应商可取 HTTPS 录音 URL，标准版异步 submit/query，真实句/词毫秒时戳和可选原生时长 | `/api/v3/auc/bigmodel/submit`、`query`，资源 `volc.seedasr.auc`（录音文件识别2.0） |

鉴权采用豆包语音**新版控制台 API Key**，发送 `X-Api-Key`，不需要 App ID。此 key 与 Ark 的 Bearer key 不是同一鉴权入口，不会回退读取 `ARK_API_KEY`。旧控制台 App ID/Access Token 双头组合本轮未增加，只有旧凭据时应在语音新版控制台准备适用 API Key；不要把 token 直接当作新 key。`media_account_id` 是部署方稳定的项目/账户标识，用于已有持久任务身份隔离，不是 secret。TTS 还需该账户已授权的2.0音色。服务/资源开通及余额未核验前不宣称真实可用。

TTS 支持 mp3 / pcm / opus、8–48 kHz 的官方离散采样率；2.0 `enable_subtitle` 的词时戳单位秒，统一转换为毫秒。字幕只在供应商返回时提供，不补平均位置。HTTP 输出没有可靠音频总时长字段，省略 durationMs；不能用字幕末尾代替总时长。WS 为缓冲输入：append 累积文本、finish 才发起一次 HTTP SSE，不提供供应商原生双向TTS的实时输入/flush/cancel；关闭只中断本地请求，收费结果仍可能未知。HTTP408/5xx、流中断或缺少完成事件保持未知，无自动重发。

标准录音ASR示例：

```json
{"model":"doubao-transcription-file","audio":{"url":"https://owned.example/audio.wav","format":"wav","language":"en-US"},"request":{"enable_punc":true}}
```

请求 `POST /v1/audio/transcription-jobs`；接受后使用返回 `request_id` 查询同路径 `/{request_id}`。供应商 UUID 在提交前进入现有持久记录，query 使用同一个 UUID。提交断线返回 `outcome_unknown + operation_id`；查询 `/v1/audio/transcription-jobs/operations/{operation_id}` 恢复映射后只查询原任务，重复码45000001不能改UUID重发。可选 `audio_info.duration` 原生毫秒转为 `transcription.durationMs` 和 duration usage.seconds；缺失时省略，不从最后一个字幕推断。`words`/`segments`保留原生字段，缺失不造值。

官方另有极速录音接口 `recognize/flash`（资源 `volc.bigasr.auc_turbo`、同步base64或URL、≤2h/100MB）以及实时 WebSocket ASR2.0。它们不属于本轮新增别名，不把标准版异步客户端冒充极速/实时，也不套用2.0标准版价目到旧极速资源。Luma 短录音可先形成自己的可读短WAV URL使用标准版；真正的边录边转另行适配，不借用TTS WebSocket地址。

价卡记录官方**后付费标价**：TTS2.0为 CNY3/万字符，录音ASR2.0为 CNY0.8/小时（价卡按0.8/3600每秒）。官方字符规则为汉字、字母、标点、空格及SSML标签均计字符，保留原生text_words。没有假设资源包优惠、试用免费、发票汇率。TTS预留须单独明确 `billing.usdPerCurrencyUnit`；缺FX拒绝spend-capped调用。异步URL ASR仍缺本地时长预留链路，即使有native usage也不放行spend-capped key；不删cap绕过。不把原生时长称为供应商发票结算，账单单位说明与精确取整仍由账户适用契约确认。

本轮部署仅使模型、lane及协议可配置。真实收费验收还需要语音项目API Key、相应资源已开通、授权音色/自有HTTPS音频，以及独立有限批次授权。旧Luma验收key保持停用。私密配置模板应置于0600文件，不能将Key写入providers.yaml、仓库或普通日志。

官方资料（本轮核对2026-11-14）：[API Key使用](https://docs.volcengine.com/docs/zh/doubao-voice/api-key-usage.md)、[HTTP SSE TTS](https://docs.volcengine.com/docs/zh/doubao-voice/http-chunked-sse-unidirectional-streaming-v3.md)、[标准录音ASR](https://docs.volcengine.com/docs/zh/doubao-voice/large-model-recording-file-recognition-standard-version-api.md)、[极速录音ASR](https://docs.volcengine.com/docs/zh/doubao-voice/large-model-recording-file-lite-recognition-api.md)、[后付费价目及计量规则](https://docs.volcengine.com/docs/zh/doubao-voice/billing-instructions.md)。

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

按句 TTS 先使用 MiniMax JSON 的 audio、contentType、原生 durationMs；Luma 上传自有存储后形成 url + durationMs，不依赖逐词字幕。新增接口目标版本为 0.30.81；调用方须确认目标 Helm 已部署包含本次改动的版本，并完成所选供应商的真实验收。

## 本地验证

2026-11-12：17 个定向测试文件、106 项测试通过，覆盖字幕与协议映射、HTTP/WS、权限、豆包提交恢复、费用预留／结算、双数据库与新增迁移。未知转写异常返回 outcome_unknown 和持久 operation_id，且不重复调用上游。shared/core/gateway 类型检查与构建、变更 TypeScript 的 Biome 检查通过。以上不替代远程完整 CI、真实供应商调用或 GPU 验收。
