# 性能与容量(4 核 8G)

单机 Docker Compose。数字是**初值**,必须用 `loadtest/` 在目标机实测后回填,禁止把未跑过的 k6 摘要写成已达标。

## 机器预算(见 `docker-compose.yml` 末尾)

| 服务 | 内存上限 | CPU 上限 |
| --- | --- | --- |
| postgres | 2G | 1.5 |
| redis | 1.2G | 0.5 |
| api | 1.5G | 1.2 |
| worker | 1.5G | 1.2 |
| web | 0.7G | 0.6 |
| nginx | 0.2G | 0.3 |
| 合计 | ~7.1G | 限额超额认购,峰值不重叠 |

压测 profile 另加 mock-provider 256M / 0.3 CPU。

PostgreSQL(`docker-compose.yml`):

- `shared_buffers=1GB`
- `effective_cache_size=3GB`(规划器提示,不占内存)
- `work_mem=16MB`
- `max_connections=100`

## 连接池(环境变量)

来自 `.env.example`,API 与 Worker **分开**池,总和必须 `< max_connections` 并留维护余量。

| 变量 | 初值 | 用途 |
| --- | --- | --- |
| `API_DB_POOL_MAX` | 20 | Nest Prisma/pg |
| `API_DB_IDLE_TIMEOUT_MS` | 30000 | |
| `API_DB_STATEMENT_TIMEOUT_MS` | 15000 | 防慢查询占连接 |
| `WORKER_DB_POOL_MAX` | 10 | Worker |
| `WORKER_DB_STATEMENT_TIMEOUT_MS` | 60000 | 生成任务允许更长 |
| `SLOW_QUERY_THRESHOLD_MS` | 300 | 超阈值打日志 |

预算(与 compose 注释一致):API 20 + Worker 10 + migrate/admin 5 + 备份/psql 10 + superuser 3 ≈ 48,相对 100 留一倍给发布期新旧容器重叠。

## 并发初值(可被管理站 `concurrency.limits` 覆盖)

| 变量 | 初值 | 含义 |
| --- | --- | --- |
| `CONCURRENCY_IMAGE_GLOBAL` | 5 | 全站同时生图(Redis 计数,跨 Worker) |
| `CONCURRENCY_TEXT_GLOBAL` | 10 | 文案 |
| `CONCURRENCY_IMAGE_PER_USER_RUNNING` | 1 | 每用户运行中生图 |
| `CONCURRENCY_IMAGE_PER_USER_PENDING` | 3 | 每用户排队生图 |
| `CONCURRENCY_IMAGE_PROCESS` | 2 | 图片处理(缩略图等) |
| `QUEUE_MAX_DEPTH_IMAGE` | 500 | 超限 `QUEUE_FULL` |
| `QUEUE_MAX_DEPTH_TEXT` | 1000 | |
| `TASK_IMAGE_TIMEOUT_MS` | 300000 | |
| `TASK_TEXT_TIMEOUT_MS` | 120000 | |

管理站硬上限(再往上会被 API 拒绝,见 `admin-config.service.ts` `CONCURRENCY_HARD_CAPS`):生图全局 50、文案 100、单用户运行 5 / 排队 20。4C8G 不要把全局生图拉到硬上限。

供应商级:`ModelProvider.rateLimitPerMinute` / `maxConcurrency`。

## Redis

| 变量 | 初值 | 策略 |
| --- | --- | --- |
| `REDIS_QUEUE_DB` | 0 | BullMQ,必须 `maxmemory-policy noeviction`(队列键不能被 LRU 掉) |
| `REDIS_CACHE_DB` | 1 | 缓存,`allkeys-lru` + TTL |
| `QUEUE_PREFIX` | `june` | 键前缀 |
| `REDIS_URL` | | 队列连接 `maxRetriesPerRequest: null`(BullMQ 要求) |

仪表盘统计短缓存 60 秒(`GET /admin/dashboard/meta` 的 `cacheTtlSeconds`)。模型公开配置按 `ConfigRevision` 失效。

## 限流

| 变量 | 初值 |
| --- | --- |
| `RATE_LIMIT_GLOBAL_PER_MINUTE` | 600 |
| `RATE_LIMIT_AUTH_PER_MINUTE` | 10 |
| `RATE_LIMIT_UPLOAD_PER_MINUTE` | 60 |
| `RATE_LIMIT_AI_SUBMIT_PER_MINUTE` | 20 |

AI 提交另有命名限流器 `ai`(见 `generation.controller.ts`)。

## SSE / Nginx

心跳 `SSE_HEARTBEAT_MS=20000`。Nginx `/api/events/` 必须 `proxy_buffering off`,否则 2 秒配置同步做不到。降级轮询 `SSE_FALLBACK_POLL_MS=15000`。

## 压测怎么跑

见 [`loadtest/README.md`](../loadtest/README.md)。供应商必须是 MOCK。把 k6 摘要(P95、失败率、`QUEUE_FULL` 次数)贴回本文件「实测」节,未跑过保持空白。

### 实测(本地 Colima + pnpm dev,2026-09-16)

限流说明:Nest Throttler 会对「已注册的每个命名限流器」在所有路由计数。已改为只注册 `default`,auth/upload/ai 用路由级 `@Throttle` 收紧。本地 `.env` 将 `RATE_LIMIT_GLOBAL_PER_MINUTE=5000`(便于压测;生产仍用文档初值)。

k6 Cookie:部分 executor 会在 iteration 间清空 CookieJar,`loadtest/k6/lib.js` 现改为显式 `Cookie` 头携带会话。

| 场景 | 脚本 | P95 | 失败率 | 备注 |
| --- | --- | --- | --- | --- |
| 混合 50VU 30min | `mixed-50vu-30m.js` | _待测_ | _待测_ | |
| 普通业务 20 rps | `business-20rps.js` | **13.42ms** | **0.00%** | 本地 60s 节选;checks 100%;login/list/detail/shops/health 全绿 |
| AI 提交 P95 | `ai-submit-p95.js` | _待测_ | _待测_ | 只测入队 |
| 50 人同时生图 | `image-submit-50.js` | _待测_ | _待测_ | 看 accepted/rejected |

此前同脚本在 CookieJar 清空 + 多命名限流叠加时失败率可达 30%–85%,属脚本/限流配置问题,不代表业务容量。
