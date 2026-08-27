# TTS API（xAI / SuperGrok OAuth）

Helm 提供一个独立的 OpenAI 风格语音合成入口。该入口固定使用已连接的
xAI/SuperGrok OAuth 账号池，不经过文本 lane 分类，也不接受静态 `XAI_API_KEY`
作为替代凭证。

## 基本信息

| 项目 | 合同 |
|---|---|
| Base URL | `http://<helm-host>:8080` |
| 鉴权 | `Authorization: Bearer <Helm API key>` |
| Provider | xAI 官方 `https://api.x.ai/v1` |
| 文本接口 | `POST /v1/tts` |
| 只读目录 | `GET /v1/tts/voices` |
| 默认音频 | MP3（上游 `audio/mpeg`） |
| 文本上限 | 15,000 个字符 |

也可以直接打开 Helm 自带的 [Swagger UI](/docs) 或下载
[OpenAPI 3.1 文档](/openapi.json)。

## 1. 查询可用声音

这是免费只读请求，用于检查当前 OAuth 账号是否有 TTS entitlement，并返回内置
声音目录。Helm 在上游返回 401 时会通过 Token Manager 刷新 token 后安全重试一次。

```bash
curl http://localhost:8080/v1/tts/voices \
  -H "Authorization: Bearer $HELM_KEY"
```

响应示例：

```json
{
  "voices": [
    {
      "voice_id": "eve",
      "name": "Eve",
      "language": "multilingual",
      "gender": "female"
    }
  ]
}
```

当前账号返回的声音数量和目录由上游决定；声音不是“一种语言一个声音”，内置声音
通常标记为 `multilingual`。自定义声音如果上游账号支持，也可以在 `voice_id` 中使用，
但不会出现在内置 voices 列表里。

### 当前内置声音目录

下面是当前 Helm 使用的 SuperGrok OAuth 账号在 `GET /v1/tts/voices` 返回的 28 个内置声音。
目录来自上游实时响应，账号 entitlement 或 xAI 目录变化后可能增删；调用方应以接口实时
返回为准。

| `voice_id` | 名称 | `language` | `gender` |
|---|---|---|---|
| `altair` | Altair | multilingual | male |
| `ara` | Ara | multilingual | female |
| `atlas` | Atlas | multilingual | male |
| `aurora` | Aurora | multilingual | female |
| `carina` | Carina | multilingual | female |
| `castor` | Castor | multilingual | male |
| `celeste` | Celeste | multilingual | female |
| `cosmo` | Cosmo | multilingual | male |
| `eve` | Eve | multilingual | female |
| `helios` | Helios | multilingual | male |
| `helix` | Helix | multilingual | male |
| `iris` | Iris | multilingual | female |
| `kepler` | Kepler | multilingual | male |
| `leo` | Leo | multilingual | male |
| `liora` | Liora | multilingual | female |
| `lumen` | Lumen | multilingual | male |
| `luna` | Luna | multilingual | female |
| `lux` | Lux | multilingual | female |
| `naksh` | Naksh | multilingual | male |
| `orion` | Orion | multilingual | male |
| `perseus` | Perseus | multilingual | male |
| `rex` | Rex | multilingual | male |
| `rigel` | Rigel | multilingual | male |
| `sal` | Sal | multilingual | male |
| `sirius` | Sirius | multilingual | male |
| `ursa` | Ursa | multilingual | female |
| `zagan` | Zagan | multilingual | male |
| `zenith` | Zenith | multilingual | male |

例如，使用 Eve 生成中文语音时，`voice_id` 仍填 `eve`，语言由 `language: "zh"` 指定：

```json
{
  "text": "你好，这是 Helm 的 TTS 测试。",
  "voice_id": "eve",
  "language": "zh"
}
```

## 2. 生成语音

```bash
curl http://localhost:8080/v1/tts \
  -X POST \
  -H "Authorization: Bearer $HELM_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "text": "你好，这是 Helm 的 TTS 测试。",
    "voice_id": "eve",
    "language": "zh"
  }' \
  --output speech.mp3
```

成功时，响应体就是音频二进制，不是 JSON：

```text
HTTP 200
Content-Type: audio/mpeg
```

可用 `ffprobe` 检查生成结果：

```bash
ffprobe -v error -show_entries format=format_name,duration,size \
  -of default=noprint_wrappers=1 speech.mp3
```

### 请求字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `text` | string | 是 | 要合成的文本，去除首尾空白后不能为空，最多 15,000 字符。 |
| `voice_id` | string | 否 | 声音 ID；省略时由 xAI 使用默认声音。建议先从 `/v1/tts/voices` 读取。 |
| `language` | string | 否 | BCP-47 语言代码或 `auto`。省略时由上游处理。 |
| 其他字段 | — | 否 | Helm 保留并透传 xAI 已支持的其他 TTS 参数，例如 `output_format`、`speed`、`with_timestamps`。具体字段以 xAI 官方文档为准。 |

### 明确支持的语言

xAI 当前文档列出 20 种语言，另有 `auto` 自动检测：

| 语言 | 代码 | 语言 | 代码 |
|---|---|---|---|
| English | `en` | 简体中文 | `zh` |
| العربية（埃及） | `ar-EG` | العربية（沙特） | `ar-SA` |
| العربية（阿联酋） | `ar-AE` | Bengali | `bn` |
| Français | `fr` | Deutsch | `de` |
| हिन्दी | `hi` | Bahasa Indonesia | `id` |
| Italiano | `it` | 日本語 | `ja` |
| 한국어 | `ko` | Português（巴西） | `pt-BR` |
| Português（葡萄牙） | `pt-PT` | Русский | `ru` |
| Español（墨西哥） | `es-MX` | Español（西班牙） | `es-ES` |
| Türkçe | `tr` | Tiếng Việt | `vi` |

`auto` 不是独立语言；它要求上游自动识别文本。官方还说明列表之外的语言可能可以
生成，但准确度不保证。语言代码大小写不敏感，地区变体应按表中 BCP-47 值发送。

## 错误响应

错误采用 Helm 的统一 envelope：

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error",
    "code": "invalid_request",
    "param": null
  }
}
```

常见状态：

| HTTP | `code` | 含义 |
|---:|---|---|
| 400 | `invalid_api_key` / `invalid_request` | API key 无效、JSON 损坏或请求字段不合法。 |
| 401 | `invalid_api_key` | 缺少或无效的 Helm API key。 |
| 401–599 | `upstream_error` | xAI TTS 返回的错误，状态码尽量透传。 |
| 503 | `provider_unavailable` | 没有可用的 xAI OAuth TTS 账号或本地并发/内存准入失败。 |

## 付费与重试边界

`POST /v1/tts` 可能产生计费或订阅额度消耗。请求一旦开始，Helm 只向一个已选中的
OAuth 账号发起一次上游 POST：网络超时、断连、5xx 或结果不明确时，都不会重试、
不会切换兄弟账号。需要重试时，应由调用方在确认上游没有生成结果后人工决定。

`GET /v1/tts/voices` 没有付费写入副作用，因此允许在 401 后刷新 token 并重试一次。

官方参考：[xAI Text to Speech](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech)
