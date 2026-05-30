# 11 · 管理界面（Admin UI）

启动后，Helm 自带一个**管理界面**（Web 控制台），用于做基本的规则管理与请求调试。它面向**内部使用**，认证用简单的 HTTP Basic 账号密码即可。

## 认证：HTTP Basic（账号密码）

管理界面的认证**独立于 API 流量的 API key**（见 [06](06-auth-and-rate-limits.md)）：

- 用 **HTTP Basic** 认证（浏览器原生弹窗即可）。
- 账号密码在**配置文件或环境变量**里配，内部使用，不做复杂权限体系。
- 环境变量优先（容器化注入）。

```yaml
# config/auth.yaml （或用环境变量覆盖）
admin:
  enabled: true
  username: admin                 # 或环境变量 HELM_ADMIN_USER
  password: change-me             # 或环境变量 HELM_ADMIN_PASSWORD
```

```bash
# 环境变量形态（推荐用于 Docker）
HELM_ADMIN_USER=admin
HELM_ADMIN_PASSWORD=change-me
```

- 未配置账号密码且 `admin.enabled: true` 时，启动应给出明确告警（避免裸奔）。
- 管理界面建议只监听内网 / 反代后访问。

## 管理界面能做什么

### 规则管理（基本）

- **Lane 管理**：查看/编辑默认与任务 lane 的 `primary + fallback[]`（见 [04](04-routing-and-lanes.md)）。
- **策略管理**：查看/编辑 policies 匹配规则（task_type / complexity / user / org → lane）。
- **分类器配置**：开关 eval、调 `confidence_threshold`、看 rules 维度/权重（见 [03](03-classification.md)）。
- **Provider / 凭证**：查看 provider 别名与健康（凭证只读引用，不回显明文）。
- **API Key 管理**：新建 / 吊销 key，设置每 key 上限（见 [06](06-auth-and-rate-limits.md)）。

改动落到 `config/*.yaml`（或运行时配置存储），保持"配置即代码"，可被版本管理。

### 请求调试（Debug）

复用 [07 · 可观测性](07-observability.md) 定义的请求列表与详情：分类层级、命中策略、lane 候选链、provider 尝试、成本、错误与 `trace_id`。

## 边界（MVP）

- 只做**基本**规则管理 + 请求查看，不做多租户、不做细粒度 RBAC。
- 不在管理界面里放 Memory / agent 编排（MVP 之外）。
- 复杂的配置仍可直接改 `config/*.yaml` 后重启——管理界面是便利层，不是唯一入口。
