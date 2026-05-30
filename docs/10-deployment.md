# 10 · 部署（自托管 / Docker）

Helm 是**开源、自托管**项目（MIT 协议）。不提供 SaaS、不售卖，任何人都可以自己部署、修改、商用。部署方式以 **Docker** 为主。

## 设计原则

- **单容器、配置即代码**：一个镜像 + 一份配置目录即可跑起来；像 nginx 一样改配置、重启生效。
- **轻量、可自托管**：默认用本地存储（如 SQLite / 本地文件）落遥测与 key，不强依赖外部数据库。
- **零额外服务**：MVP 不依赖 Redis / 消息队列；限流、缓存先用进程内实现。

## Docker 部署

```bash
docker run -d --name helm \
  -p 8080:8080 \
  -v $(pwd)/config:/app/config \   # lanes/policies/classifier/providers...
  -v $(pwd)/data:/app/data \       # 遥测、key 等持久化
  -e HELM_ADMIN_USER=admin \       # 管理界面账号（见 11）
  -e HELM_ADMIN_PASSWORD=change-me \
  -e OPENAI_API_KEY=sk-... \       # 上游 provider 凭证
  ghcr.io/easymetaau/helm-api:latest
```

也提供 `docker-compose.yml` 形态，便于挂载配置与持久化卷。

## 配置来源

配置可来自**文件**或**环境变量**，环境变量优先（便于容器化与密钥注入）：

- `config/*.yaml`：lanes、policies、classifier、providers、capabilities、pricing、auth（见 [02 · 架构](02-architecture.md)）。
- 环境变量：provider 凭证、管理界面账号密码、可选的存储/端口覆盖。

## 启动行为

1. 加载配置（文件 + 环境变量）。
2. 若不存在任何 API key，**生成一把 root key 并打印一次**（见 [06](06-auth-and-rate-limits.md)）。
3. 启动 HTTP 服务（API + 管理界面，见 [11 · 管理界面](11-admin-ui.md)）。
4. 健康检查端点就绪后开始服务流量。

## 升级

像 llm-router 的 SOP 一样：拉新镜像 → 重建容器 → 校验 `/healthz` 与版本；保留挂载的 `config/` 与 `data/`，不覆盖。
