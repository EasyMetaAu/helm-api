# Fun-ASR and Paraformer transcription jobs

Helm exposes DashScope recorded-file recognition through its existing asynchronous transcription API. The default lanes are `transcription-fun-asr` (`bailian/fun-asr`) and `transcription-paraformer` (`bailian/paraformer-v2`). Each job accepts **one** public or presigned audio/video URL in `input.file_urls`. Submit a separate job for each file.

## Enable the provider

Inject `BAILIAN_API_KEY` into the gateway environment. The checked-in `config/providers.yaml` uses provider type `bailian-media`, Beijing endpoint `https://dashscope.aliyuncs.com/api/v1`, and both model aliases. Set `media_account_id` to a stable label for your DashScope account before creating jobs. Keep that label, endpoint and credential stable while jobs are active.

The lanes in `config/lanes.yaml` have no fallback:

```yaml
transcription-fun-asr:
  primary: bailian/fun-asr
  fallback: []
transcription-paraformer:
  primary: bailian/paraformer-v2
  fallback: []
```

The corresponding `config/capabilities.yaml` entries declare audio input and no streaming. `config/pricing.yaml` contains their Beijing CNY price cards. Merge these entries into externally mounted configuration before restarting the gateway. A missing credential leaves the optional provider unavailable.

Grant the calling Helm key `allowed_lanes: [transcription-fun-asr]` (or include both lanes). Lane calls do not require `allow_custom_model`. A key that excludes the selected lane cannot create or poll its jobs. Poll with the same Helm key that created the job.

## Submit

Send `Authorization: Bearer <Helm Key>` and `Content-Type: application/json` to `POST /v1/audio/transcription-jobs`:

```json
{
  "model": "transcription-fun-asr",
  "input": {
    "file_urls": ["https://your-cdn.example/clip.mp4?signature=YOUR_SIGNATURE"]
  },
  "parameters": {
    "vocabulary": { "阿里巴巴": 4, "Helm API": 2 },
    "language_hints": ["zh"],
    "diarization_enabled": true,
    "speaker_count": 2
  }
}
```

HTTP 200:

```json
{"request_id":"<Helm request ID>","status":"queued"}
```

The `request_id` is Helm's durable public ID, not the upstream task ID. Helm submits once with `X-DashScope-Async: enable`. Omitted `parameters` becomes `{}`, as required by newer workspace endpoints.

| Parameter | Fun-ASR | Paraformer-v2 |
| --- | --- | --- |
| `input.file_urls` | Exactly one HTTP(S) URL, without embedded username/password | Same |
| `parameters.vocabulary` | Object mapping hotword text to integer weight 1–5; at most 2000 entries | Unsupported by the documented file API |
| `parameters.vocabulary_id` | Nonempty ID of an existing precompiled vocabulary | Same; create the vocabulary for the matching model |
| `parameters.channel_id` | Nonempty array of nonnegative integer channel indices; upstream default `[0]` | Same |
| `parameters.language_hints` | One language code from the official Fun-ASR list; omit for automatic detection | One or more of `zh`, `en`, `ja`, `yue`, `ko`, `de`, `fr`, `ru` |
| `parameters.diarization_enabled` | Boolean; speaker separation is for mono audio | Same |
| `parameters.speaker_count` | Integer 2–100; effective when diarization is enabled | Same |
| `parameters.disfluency_removal_enabled` | Unsupported | Boolean |
| `parameters.timestamp_alignment_enabled` | Unsupported | Boolean |

Fun-ASR inline hotword text containing any non-ASCII character is limited to 15 Unicode characters in total, including spaces and ASCII characters. Pure ASCII text is limited to seven space-separated parts. Empty/blank hotwords, invalid weights, oversized vocabularies and unsupported parameters return HTTP 400 before dispatch. Neither file API documents a punctuation toggle; returned punctuation is always preserved. Use `vocabulary_id` in place of `vocabulary` to reuse a precompiled list.

## Poll and read words

Send the same authorization header to `GET /v1/audio/transcription-jobs/<Helm request ID>`. A representative completed response is:

```json
{
  "request_id": "<Helm request ID>",
  "status": "done",
  "transcription": {
    "results": [{
      "file_url": "https://your-cdn.example/clip.mp4?signature=YOUR_SIGNATURE",
      "subtask_status": "SUCCEEDED",
      "transcription_url": "https://result.example/transcript.json",
      "transcript": {
        "transcripts": [{
          "channel_id": 0,
          "text": "你好。",
          "sentences": [{
            "begin_time": 100,
            "end_time": 600,
            "text": "你好。",
            "sentence_id": 1,
            "speaker_id": 0,
            "words": [{"begin_time":100,"end_time":600,"text":"你好","punctuation":"。"}]
          }]
        }]
      }
    }],
    "partial_failure": false,
    "upstream_status": "succeeded"
  },
  "usage": {"duration":1,"type":"duration","seconds":1}
}
```

Read words from `transcription.results[i].transcript.transcripts[j].sentences[k].words`. `begin_time` and `end_time` are **milliseconds**. Helm validates the downloaded JSON and retains all native fields, including word text, punctuation, whitespace, channel IDs, speaker IDs and provider extensions. It does not generate missing timestamps or speaker labels. Result downloads use the existing bounded, public HTTPS downloader without provider authorization.

| DashScope status | Helm response |
| --- | --- |
| `PENDING` | `queued` |
| `RUNNING` | `in_progress` |
| `SUCCEEDED`, all files successful | `done` |
| `SUCCEEDED`, some files failed | `done`, `partial_failure: true`; inspect each `subtask_status` |
| `SUCCEEDED`, all files failed; or `FAILED` | `failed`; task/per-file error details remain available |
| `CANCELED` | `cancelled` |
| `UNKNOWN` or malformed upstream response | HTTP 502 |

An invalid or unavailable result file returns HTTP 502; it is not reported as a completed transcript. Retry the GET within the query window. The existing DashScope query window is 24 hours; Helm's operation records last seven days. Downloaded results are not permanently archived by this API.

If creation returns HTTP 503 with `error.code: "outcome_unknown"`, retain `error.operation_id` and query `GET /v1/audio/transcription-jobs/operations/<operation ID>`. Do not submit the file again automatically. The operation returns `state` and `upstream_task_known`; if a known upstream ID can be recovered, it also returns the stable `request_id`. If the upstream ID was never received, recovery requires account-side reconciliation (核对上游任务). Provider 4xx rejection returns HTTP 400 with `upstream_rejected`; provider 5xx or lost responses remain uncertain and are never retried.

The create route records status, timing, and request size. Complete request and response bodies are excluded from payload and session capture, including on errors, because the download URL can grant access to private media.

## Usage and pricing

Verified Beijing list prices on 2026-11-16: `fun-asr` **CNY 0.00022 per input audio second**; `paraformer-v2` **CNY 0.00008 per input audio second**. Output is not billed. Use the provider's `usage.duration`, exposed unchanged and also as `usage.type: "duration"` / `usage.seconds`. Selected channels are billed separately; never substitute file duration or the final word timestamp. Missing usage stays unknown, and zero is retained.

## Limitations

- The current official REST references specify one URL per task for both models. Helm rejects multi-URL requests; it does not create a batch of upstream tasks behind one ID.
- The official inline vocabulary shape requires a weight for every word. No optional-weight/default-weight form is documented for Fun-ASR. Limits and model ownership of an existing `vocabulary_id` are checked by DashScope; Helm does not fetch or manage vocabulary lists. The docs do not establish how Fun-ASR combines inline and precompiled lists, so use one form at a time.
- Spend-capped file ASR requires a verified per-job ceiling for the selected provider account and an `X-Helm-Transcription-Operation` ID. Helm reserves the ceiling before dispatch. A confirmed unsent request releases it. A terminal result with provider-reported duration records normalized usage on the same receipt and retains the reservation with unknown cost. Later polls can fill missing usage. Polling does not derive a charge from a public list price or submit a second provider request. Without verified account-level pricing, keep the ceiling unset and admission remains disabled for spend-capped keys.
- For uncapped `fun-asr` keys, the terminal poll can price the original creation from provider-reported billable seconds. USD reporting uses the exchange rate configured on the media price card. Repeated polls refer to the same creation.
- An account ceiling based on a limited number of billed audio tracks declares `maxChannels`. For Bailian, the gateway checks the selected `channel_id` array against that limit before reserving or dispatching. Omitting the array selects the provider default of one track. Providers without this verified track mapping cannot use a track-limited ceiling.
- Verification uses synthetic fixtures only. Account entitlement, actual recognition quality, presigned URL reachability and provider billing have not been tested with a real call.

## Official references

- [Fun-ASR recorded-file REST API](https://help.aliyun.com/zh/model-studio/fun-asr-recorded-speech-recognition-restful-api)
- [Paraformer recorded-file REST API](https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-restful-api)
- [Improve ASR accuracy: hotwords and limits](https://help.aliyun.com/zh/model-studio/improve-asr-accuracy)
- [Model pricing](https://help.aliyun.com/zh/model-studio/model-pricing)
