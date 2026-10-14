# 媒体模型价格配置

核验日期：2026-10-14。全部 25 个模型的价格已写入运行时读取的
[`config/pricing.yaml`](../config/pricing.yaml)，字段为 `pricing.media`，不是仅供阅读的价格表。
价卡包含 57 个计费分档；MiniMax 两个 TTS 模型还分别带有克隆/设计声线的条件费用。

## 生效与读取

- `loadRuntimeCatalog` 在启动时读取 generated catalog 与 `pricing.yaml`；手动项优先，`media` 价卡整体覆盖。
- 新版本启动后，有 `allow_custom_model` 权限的 key 可在 `GET /v1/models` 的具体模型条目读取 `pricing.media`。普通 key 的 lane 条目不暴露供应商价格；lane 可能回退到其他模型，不能标成单一模型价。
- 修改挂载配置的部署应合并这 25 个模型条目，保留其他自定义覆盖，然后重启。仅更新镜像不会自动替换外部挂载的旧 `pricing.yaml`。
- `media.currency` 为原币种；`inputPerMTokUsd` / `outputPerMTokUsd` 继续为 null。null 是缺少该单位的价格，不表示免费。单独的零元媒体维度会明确写 `price: 0`。
- 非法币种、单位、条件字段、负价、空价卡、错误促销算式均拒绝加载，不会悄悄丢弃错误字段。

价卡字段：`providerModel`、`currency`、`region`、`basis`、`verifiedOn`、`source`、`rates`、可选 `conditionalFees`、`notes`。
每个 rate 包含 `direction`、`unit`、`price`、`conditions`，可带 `freeQuantity` 和 `promotion`。

## 火山方舟：北京，人民币

官方来源：[模型价格](https://ark.volcengine.com/region:cn-beijing/docs/ark/model-pricing?lang=zh)。

| 模型 | 已配置的正式价格 |
| --- | --- |
| Seedream 5.0 Flash | 输入图免费；输出 ¥0.12/张 |
| Seedream 5.0 Pro | 首张输入免费，之后 ¥0.02/张；普通输出 ≤2,610,000 像素 ¥0.30/张，超过 ¥0.60/张；拆层分别 ¥0.15、¥0.30/层 |
| Seedance 2.5 | 无参考视频：480p/720p ¥70/百万 completion tokens，1080p ¥77；有参考视频分别 ¥42、¥46 |
| Seed3D 2.0 | ¥2.40/成功模型文件 |

Pro 拆层按每一层的实际像素数分档。Seedance 使用上游实际 `usage.completion_tokens`，不能用固定秒价代替；草稿与最终视频分别计费。
Seed3D 的 Token 换算与每文件价格是同一笔费用的两种表示，不能重复收取。

## 阿里百炼：北京，人民币

官方来源：[模型价格](https://docs.bailian.console.aliyun.com/zh/model-studio/model-pricing)。其他地域及转售 MiniMax 的价格不用于本配置。

| 模型 | 已配置的正式价格 |
| --- | --- |
| qwen-image-3.0-pro | 输入 ¥0.02/张；1K 输出 ¥0.25/张，2K ¥0.50/张 |
| qwen-image-3.0 | 输入 ¥0.02/张；1K/2K 输出均 ¥0.18/张 |
| qwen-image-2.1-pro / turbo | 输入免费；输出分别 ¥0.25 / ¥0.10 每张 |
| wan3.0-video | 480P / 720P / 1080P 分别 ¥0.30 / ¥0.60 / ¥1.20 每秒 |
| wan3.0-video-prime | 对应分辨率分别 ¥0.45 / ¥0.90 / ¥1.80 每秒 |
| qwen3-asr-flash、qwen3-asr-flash-filetrans、qwen-audio-3.0-asr-flash-filetrans、fun-asr | ¥0.00022/输入音频秒 |
| paraformer-v2、paraformer-8k-v2 | ¥0.00008/输入音频秒 |
| qwen-audio-3.1-asr-flash-filetrans | 输入 ¥0.80/百万 Token，输出 ¥2.70/百万 Token |
| qwen-audio-3.1-tts-flash | 输入 ¥1.50/百万 Token，输出 ¥12/百万 Token |
| qwen-audio-3.0-tts-plus | ¥1.40/万计费字符 |
| cosyvoice-v3.5-plus / flash | 分别 ¥1.50 / ¥0.80 每万计费字符 |

万相按**输入视频秒数 + 成功输出视频秒数**计费，以输出分辨率选档。
普通 wan3.0-video 官网有限时七折：¥0.21 / ¥0.42 / ¥0.84 每秒；保存在 `promotion`，不覆盖正式单价。
官网未公布结束时间，`endDate: null` 表示未知，不代表永久有效；prime 不套用此优惠。

按字符计价的百炼 TTS：汉字计 2，其他字符（含标点、空格）计 1，SSML 标签不计。
3.1 的 Token 计价不能套用 3.0 的秒价或字符价；费用计算需要对应的实际用量。

## MiniMax 国际直连：美元

官方来源：[视频与语音价格](https://platform.minimax.io/docs/pricing/overview)。

| 模型 | 已配置的正式价格 |
| --- | --- |
| MiniMax-H3 | 768P 输入/输出视频均 $0.08/秒；2K 均 $0.13/秒；输入图前 5 张免费，之后 $0.04/张 |
| MiniMax-H3-Max | 480P 输出 $0.05/秒、输入 $0.0553/秒；768P 输出 $0.08/秒、输入 $0.143/秒；输入图前 2 张免费，之后 $0.074/张 |
| speech-2.8-hd | $100/百万计费字符 |
| speech-2.8-turbo | $60/百万计费字符 |

两个视频模型输入音频免费。TTS 计费字符来自 `extra_info.usage_characters`，不能换成 `word_count` 或 `norm_text_char_count`。
使用外部创建的克隆/设计声线时，首次合成可能分别收 $1.50 / $3.00 每声线；已分别写入两个 TTS 模型的 `conditionalFees`。
普通系统声线不额外收取此费用。未知声线类型不能假定没有费用。

## 价格目录与账务边界

本次交付为**全部模型的价格配置、严格加载校验和模型目录下发**。价卡是官网目录价，不包含账号折扣、赠送额度或人民币兑美元汇率。
没有新增实际用量计算、异步任务账务结算或数据库迁移；媒体请求的 `cost_usd` 仍可能为 null。
此前媒体 spend-capped key 的拒绝边界保留，避免仅有单价但尚无可靠预留/结算时绕过硬预算。
异步 GET 查询不新增扣款，重复查询不会成为重复记账入口。

自动化验收覆盖所有 25 个 provider alias 与 wire model 的对应、57 个价档、条件费用、单位与分档、旧配置兼容、非法配置拒绝，以及真实 HTTP 模型目录响应。
