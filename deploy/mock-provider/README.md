# 压测用 HTTP 模拟供应商

**这不是任何真实模型服务。** 仅用于容量压测与队列验证。返回的图片带 `X-June-Mock: 1` 响应头，JSON 里的 `model` 以 `mock-` 开头。

平台内还有一份进程内适配器 `packages/providers/src/image/mock.ts`（不发网络请求）。本服务是 Docker Compose `loadtest` profile 暴露的独立 HTTP 上游，便于：

- 注入延迟 / 失败率 / 429，而不改应用代码；
- 验证 SSRF 白名单（需临时 `PROVIDER_URL_ALLOW_PRIVATE_NETWORK=true`）。

## 启动

```bash
docker compose --profile loadtest up -d mock-provider
```

默认监听容器内 `4010`。压测时在 `.env` 设置：

```
MOCK_PROVIDER_ENABLED=true
MOCK_PROVIDER_BASE_URL=http://mock-provider:4010
PROVIDER_URL_ALLOW_PRIVATE_NETWORK=true
```

压测结束后务必改回，避免生产误连内网模拟服务。

## 环境变量

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `MOCK_PORT` | 4010 | 监听端口 |
| `MOCK_LATENCY_MS_MIN` | 600 | 最小延迟 |
| `MOCK_LATENCY_MS_MAX` | 2500 | 最大延迟 |
| `MOCK_ERROR_RATE` | 0.02 | 5xx 比例 |
| `MOCK_RATE_LIMIT_RATE` | 0.01 | 429 比例 |
| `MOCK_ASYNC_POLL_ROUNDS` | 3 | 异步任务需轮询次数 |

## 接口

- `GET /healthz` 存活
- `POST /v1/images/generations` OpenAI 兼容同步出图（body 可含 `n`、`size`、`prompt`）
- `POST /v1/images/edits` 参考图编辑（忽略真实图片内容，仍返回 MOCK PNG）
- `POST /v1/tasks` 创建异步任务
- `GET /v1/tasks/:id` 轮询异步任务

不接受真实 API Key；`Authorization` 头只做存在性检查，不会转发到外网。
