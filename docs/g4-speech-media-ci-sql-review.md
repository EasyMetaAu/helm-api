# G4 发布前 CI 数据库查询审查

2026-11-12，审查开发提交 `c2fe2df20130dd31fedb2f78d91311351bfd6f43`，基线为 `f3c084bd62acc1442d07a9d153a10f390c450b98`。

本次 SQLite v58／Postgres v57 迁移仅新增 `media_spend_records`，每条 SQL 只操作一张表。完整 CI 还会执行以下既有跨表查询，因此在触发 CI 前完成三角色审查。

## 查询范围与必要性

路径均相对于 `packages/core/src/store/`。行号对应上述开发提交。

| 查询族与源码 | 单表替代方案 | 保留现有查询的具体理由 |
|---|---|---|
| 历史隔离及 ID 重映射：`sqlite/migrate.ts:1014`；`postgres/migrate.ts:925,944` | 逐表读取，应用层保存旧／新 ID 映射，再分批写入 | 必须在同一事务中检测冲突并一致迁移父子记录；改写会改变需要验证的历史迁移 |
| 父记录计数及时间回填：`sqlite/migrate.ts:935,949,1363`；`postgres/migrate.ts:834,849,1317` | 先聚合子表，再逐条更新父表 | 必须覆盖无子记录的父项，并保持摘要与实际存量一致；拆分增加事务内写入次数 |
| 归属与 scope 校验：`sqlite/memory-store.ts:164,478,1508`；Postgres 对应 `:144,502,1647` | 先批量读出已授权 thread ID，再查子记录 | 子记录通过父 thread 继承 owner/project/resource；关系校验是权限契约，不能为改单表而移除 |
| Observer 覆盖范围：SQLite `memory-store.ts:574,1007`；Postgres `:599,999` | 读取候选、端点与消息范围后在应用层匹配 | 需要一致的同 thread 端点、重复次数及实时内容快照；拆分增加数据搬运和快照协调 |
| 衰减与空闲调度：SQLite `memory-store.ts:1594`；Postgres `:1734,2760` | 分别读 observation/thread/job 后按 owner 合并 | 判断依赖最新 sweep 和未观察消息，不能只看 thread 时间；合成回归需要执行实际调度条件 |
| FTS/vector 查询：`sqlite/memory-store.ts:2255,2305` | 先读候选 ID，再按 owner/scope/status 查询 fact | 索引候选不能充当授权依据，必须回到当前事实记录核验归属和有效状态 |
| 保留期与摘要修复：SQLite `memory-store.ts:2711,2777`；Postgres `:2528,2594` | 先读 frontier 与消息 ID，再删除并修复父项 | 必须保留 Observer frontier、事务及父记录锁，避免与追加消息发生不一致 |
| Session/chunk 清理：`postgres/telemetry.ts:673,697,719,760,1162` | 应用层批量管理 ID，写入前重新验证 | 必须保持 claim marker、子记录为空、generation 一致及 `SKIP LOCKED` 语义 |
| 历史去重修复：`postgres/dedup-memory-messages.ts:106,153` | 分开检查 occurrence 冲突、清理衍生数据和修复计数 | 当前原子修复是回归对象；具有全测试库清理语义，必须隔离运行 |

## 三角色结论

| 角色 | 结论与依据 |
|---|---|
| 数据库性能 | 同意在有界合成数据上执行。thread/message/observation 主键、thread 时间与 owner/scope 索引支持关联条件；coverage 和清理有批次限制。聚合扫描不因结果 LIMIT 而自动有界，不能据此推断生产容量。单表替代会增加应用层合并、往返或 N+1 操作。未发现本范围 P0/P1 阻塞。 |
| 业务与数据一致性 | 同意执行。查询维护归属、覆盖范围、隔离迁移、保留期和摘要一致性；拆分仍需等价事务快照及锁。SQLite 使用事务，Postgres 迁移使用保留连接与 advisory lock，清理保留父记录锁。未发现本范围 P0/P1 阻塞。 |
| 安全与权限隔离 | 同意仅在独立测试数据库执行。owner/thread/key 与 generation 条件不能放宽；全库维护仅面向测试实例。CI 不注入生产数据库凭据。未发现本范围 P0/P1 阻塞。 |

三方均为源码及索引审查，未运行查询、EXPLAIN 或性能测试；验证依据是事务、谓词、索引、批次边界和现有测试夹具，不作为生产规模或多连接竞争的证明。

## 执行条件

- verify/store/e2e 使用一次性 GitHub hosted runner；PR Docker smoke 同样使用 hosted runner，且不挂载生产数据。
- SQLite/PGlite 为测试创建的独立实例，e2e 使用独立 `.e2e-data`、虚拟凭据及本地 mock 上游。
- `PG_TEST_URL` 与 `HELM_TEST_POSTGRES_URL` 在 CI 保持未设置，由脚本创建并清理专用 PostgreSQL 容器；若另行指定，必须先确认是可清空的独立测试库。
- 保留现有事务、锁、权限谓词、批次限制和清理逻辑，不为本次 CI 重写既有 SQL。
- 此审查不批准线上运行历史去重或回填。目标线上数据库已是 SQLite v57，本次升级只需执行新增 v58 单表 DDL。
