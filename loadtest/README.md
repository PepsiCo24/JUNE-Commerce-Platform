# 压测

本目录脚本用 **k6** 打 API,生图一律走 **MOCK 供应商**(`packages/providers/src/image/mock.ts`,`slug=mock-loadtest`)。产出图片带大写 MOCK 字样,`PublicModelOption.isMock === true`。没有 MOCK 模型时脚本会失败退出,不会改打真实上游,也不会把空跑写成达标。

## 1. 前置

```bash
# 依赖栈 + 基础种子(含 mock-loadtest 供应商目录)
cp .env.example .env
# 至少填写 SESSION_SECRET、CSRF_SECRET、CREDENTIAL_ENCRYPTION_KEY、PROVIDER_SECRET_ENCRYPTION_KEY
docker compose -f docker-compose.dev.yml up -d
pnpm install
pnpm db:migrate
pnpm db:seed

# 压测规模数据(与真实 / 演示数据隔离,邮箱域 @loadtest.invalid)
pnpm loadtest:seed
```

`pnpm loadtest:seed` 默认:

| 项 | 默认 | 环境变量 |
| --- | --- | --- |
| 用户 | 50 | `LOADTEST_USERS` |
| 帖子 | 200 | `LOADTEST_POSTS` |
| 店铺 / 商品 | 20 | `LOADTEST_SHOPS` |
| 密码 | `Loadtest-Passw0rd!` | `LOADTEST_PASSWORD` |

账号:`loadtest-001@loadtest.invalid` … `loadtest-050@loadtest.invalid`。

实现位置:`packages/db/scripts/loadtest-seed.ts`(root `package.json` 的 `loadtest:seed` 已指向它)。

启用 MOCK 上游(压测后改回):

```bash
# .env
MOCK_PROVIDER_ENABLED=true
MOCK_PROVIDER_BASE_URL=http://127.0.0.1:4010   # 生产 compose 内网用 http://mock-provider:4010
PROVIDER_URL_ALLOW_PRIVATE_NETWORK=true        # 否则 SSRF 防护会拒绝内网 base URL

docker compose --profile loadtest up -d mock-provider
pnpm dev
```

本地开发没有 compose 里的 mock-provider 容器时,Worker 仍使用进程内 `packages/providers/src/image/mock.ts` 适配器,**不发起外网请求**。`MOCK_PROVIDER_BASE_URL` 只影响管理站里登记的地址。

安装 k6:https://grafana.com/docs/k6/latest/set-up/install-k6/

## 2. 位置与命令

默认打 `http://127.0.0.1:3001`(Nest 直连)。若只起了 Next 反代,改成 `http://127.0.0.1:3000`。

```bash
export BASE_URL=http://127.0.0.1:3001
export LOADTEST_PASSWORD='Loadtest-Passw0rd!'

# 50 VU × 30 分钟混合
k6 run loadtest/k6/mixed-50vu-30m.js

# 普通业务 20 rps × 10 分钟
k6 run loadtest/k6/business-20rps.js

# AI 提交 P95(测入队延迟,不是出图完成)
k6 run loadtest/k6/ai-submit-p95.js

# 50 人同时提交生图
k6 run loadtest/k6/image-submit-50.js
```

## 3. 请求比例

### mixed-50vu-30m.js

| 比例 | 请求 | 说明 |
| --- | --- | --- |
| 40% | `GET /api/community/posts` | 大厅 |
| 20% | `GET /api/community/posts/loadtest-post-00N` | 详情 |
| 15% | `GET /api/shops` | 店铺列表 |
| 10% | `GET /health` | 存活(无 `/api` 前缀) |
| 10% | `POST /api/generation/image` | MOCK 生图提交 |
| 5% | `GET /api/auth/me` | 会话 |

### business-20rps.js

50% 大厅 / 25% 详情 / 15% 店铺 / 10% 健康检查。不含生图。

### ai-submit-p95.js

恒定约 5 次/秒提交 MOCK 生图。观察 `ai_submit_ms` 的 P95。目标线写在脚本 `thresholds` 里,**跑完以 k6 摘要为准,未跑过不得填写达标**。

### image-submit-50.js

50 VU 同时各提交 1 次。计数器 `image_submit_accepted` / `image_submit_rejected`。队列满时会出现 `QUEUE_FULL` / `USER_CONCURRENCY_LIMIT`,这是预期反馈,不是脚本缺陷。

## 4. 不要做的事

- 不要把 MOCK 结果当真实模型验收。
- 不要在未配置 `PROVIDER_SECRET_ENCRYPTION_KEY` 时宣称生图链路通过(`loadtest:seed` 会明确警告 `MODEL_CREDENTIAL_MISSING`)。
- 不要修改脚本去吞掉 4xx/5xx 再输出「成功」。
