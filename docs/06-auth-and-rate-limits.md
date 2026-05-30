# 06 · 鉴权、API Key 与限流

## 鉴权与 API Key

Helm 默认**不允许匿名访问**。

- `require_api_key: true`：所有请求都必须带 key。
- **启动引导（bootstrap）**：服务启动时若不存在任何 key，自动生成一把 root key，并**仅打印/持久化一次**，供运维取走。
- key 通过 Auth Resolver 解析为账户/组织/用户身份；遥测中绝不存明文 key。

```yaml
auth:
  require_api_key: true
  bootstrap:
    generate_if_missing: true        # 启动时无 key 则生成一把 root key
    persist_to: ./data/helm-keys.json   # 或环境变量 / 数据库
    print_once: true                 # 首次生成时打印到启动日志一次
```

## Key 管理

- **多 key**：支持任意数量的 key，每把绑定身份（account / org / user）。
- **哈希存储**：只存 key 的哈希（如 sha256）+ 前缀（如 `helm_live_xxxx`）用于展示/排障；绝不存明文。
- **每 key 上限**：可选 `max_lane`（封顶到某条 lane）/ `allowed_lanes`（白名单）/ `allow_custom_model`（是否允许客户端显式指定模型直通）。
- **轮转与吊销**：生成新 key + `disabled: true` 吊销旧 key；不就地改写。
- root key 仅用于引导和管理面，不建议直接喂生产流量。

```yaml
# key 记录（存储层，示意）
api_keys:
  - key_id: k_root
    hash: sha256:...
    account_id: acct_default
    role: root
    disabled: false
  - key_id: k_app1
    hash: sha256:...
    account_id: acct_default
    max_lane: balanced          # 封顶，禁止 premium
    allow_custom_model: false   # 不允许跳过规则直通模型
    disabled: false
```

## 限流与配额

`nginx for LLM` 自然需要 per-key 限流，但不能成为"开箱即用"的摩擦。

**决策**：MVP 内置**轻量 per-key 限流**（令牌桶 RPM/TPM），**默认关闭**；完整的配额 / 计费 / 信用体系**推迟到 MVP 之后**。限流器位于 Auth 之后、分类之前；触发即返回 `rate_limited`。

```yaml
rate_limit:
  enabled: false            # 默认关闭，零摩擦
  default:
    rpm: 0                  # 0 = 不限
    tpm: 0
  # 可按 key 覆盖
```
