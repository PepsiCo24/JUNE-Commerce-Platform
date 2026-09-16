# API

前缀:`http://localhost:3001/api`(生产由 Nginx 反代到同源 `/api`)。

例外:存活探针 `GET /health`、详情 `GET /health/detail` **没有** `/api` 前缀(`main.ts` `setGlobalPrefix` exclude)。就绪探针是 `GET /api/health/ready`。

整理自 `apps/api/src/modules/*/*.controller.ts`。

## 认证

| 作用域 | Cookie | 登录 | 当前用户 | 退出 |
| --- | --- | --- | --- | --- |
| 站点(社区+工作台) | `june_session` | `POST /api/auth/login` | `GET /api/auth/me` | `POST /api/auth/logout` |
| 管理站 | `june_admin_session`(路径限定 /api/admin) | `POST /api/admin/auth/login` | `GET /api/admin/auth/me` | `POST /api/admin/auth/logout` |

另有:`POST /api/auth/register`、`POST /api/auth/logout-all`、`PATCH /api/auth/profile`、`POST /api/auth/change-password`、`POST /api/auth/reauth`(店铺密码揭示)。

会话 HttpOnly + Secure(生产) + SameSite=Lax。管理登录会校验管理员角色;非管理员与密码错误一样返回 `INVALID_CREDENTIALS`,避免枚举。

## CSRF

非 GET/HEAD/OPTIONS 必须带请求头 `x-june-csrf`,值等于可读 Cookie `june_csrf`(双提交)。

登录/注册带 `@SkipCsrf()`。管理站前端写操作走 `adminApi`(每次从 Cookie 读令牌),不依赖站点 `AuthProvider` 的内存 CSRF。

## 错误体

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "面向用户的中文,已脱敏",
    "details": [{ "path": "email", "message": "邮箱格式不正确" }],
    "requestId": "…",
    "retryAfterSeconds": 60
  }
}
```

前端按 `code` 分支,见 `packages/shared/src/errors.ts` 的 `ERROR_CODES`。常见:

| code | HTTP 约 | 含义 |
| --- | --- | --- |
| `UNAUTHENTICATED` / `SESSION_EXPIRED` | 401 | 未登录或会话失效 |
| `CSRF_FAILED` | 403 | 缺/错 CSRF |
| `FORBIDDEN` / `ADMIN_REQUIRED` | 403 | 权限 |
| `LAST_SUPER_ADMIN` | 400 | 不能拿掉最后一个超管 |
| `RATE_LIMITED` | 429 | 限流,看 `retryAfterSeconds` |
| `QUEUE_FULL` / `USER_CONCURRENCY_LIMIT` | 429/400 | 队列或单用户并发 |
| `MODEL_CREDENTIAL_MISSING` | 400 | 未配 Key |
| `PROVIDER_URL_NOT_ALLOWED` | 400 | SSRF 拦截 |

## 健康与 SSE

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活,不查依赖 |
| GET | `/api/health/ready` | 就绪:Postgres + Redis |
| GET | `/health/detail` | 队列/对象存储,需内部令牌 |
| GET | `/api/events/stream` | SSE,需登录。只推版本号与本人任务事件 |
| GET | `/api/events/versions` | SSE 降级轮询用的配置版本 |

## 社区 ` /api/community`

| 方法 | 路径 |
| --- | --- |
| GET | `/community/posts` 大厅,游客可 |
| GET | `/community/my/posts` |
| GET | `/community/posts/:slug` |
| POST/PATCH/DELETE | `/community/posts`、`/community/posts/:id` |
| GET/POST | `/community/posts/:postId/comments` |
| DELETE | `/community/comments/:id` |
| POST/DELETE | `/community/posts/:id/like` |
| GET | `/community/posts/:slug/share` |
| CRUD | `/community/drafts`、`POST .../drafts/:id/publish` |

## 工作台

店铺 `/api/shops`(含 `/stats` `/graph`)、商品 `/api/products`、凭据 `/api/shops/:shopId/credentials`(揭示需 reauth)、导入 `/api/products/import`。

资产:`POST /api/assets/upload-ticket`、`POST /api/assets/:id/confirm`、`GET /api/assets/usage`、`GET /api/assets/:id/download`、`DELETE /api/assets/:id`。

生成:

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/models/config` | 公开模型清单,无 Key |
| POST | `/api/generation/image` | 202 + taskId,限流 `RATE_LIMIT_AI_SUBMIT_PER_MINUTE` |
| POST | `/api/generation/image/:taskId/retry` | 只重试失败 seq |
| POST | `/api/generation/copy` | 文案 |
| GET | `/api/generation/tasks`、`/tasks/:taskId` | |
| POST | `/api/generation/tasks/:taskId/save-to-product` 等 | |
| POST | `/api/copy/save`、`/api/copy/check` | 保存前再检查 |

## 管理站 `/api/admin`

均需管理员会话。超管接口另加 `@MinRoleLevel(super_admin)`。

| 模块 | 路径 |
| --- | --- |
| 仪表盘 | `GET /admin/dashboard` `GET /admin/dashboard/meta` `GET /admin/dashboard/refresh` |
| 用户 | `GET /admin/users` `POST /admin/users`(超管创建管理员) `GET /admin/users/:id` `GET .../shops` `GET .../shops/:shopId/products` `PUT .../status` `PUT .../roles`(超管) `DELETE /admin/users/:id`(超管) |
| 帖子 | `GET /admin/posts` `GET/PATCH /admin/posts/:id` `POST .../visibility` `POST .../pin` `PUT /admin/posts/pin-order` |
| 评论 | `GET /admin/comments` `POST /admin/comments/:id/action` |
| 模型 | `/admin/models/providers` CRUD + `POST .../test`;`GET/PUT /admin/models/policy`;`/admin/models` CRUD + `POST .../default` |
| 内容规则 | `/admin/content-rules` CRUD + `GET .../versions` `POST .../enabled` |
| 分享 | `GET/PUT /admin/share-config` |
| 任务 | `GET /admin/tasks` `GET /admin/tasks/stats` `GET /admin/tasks/:id` |
| 存储 | `GET /admin/storage/overview` `GET .../quota-bounds` `PUT .../users/:userId/quota`(超管) `POST .../cleanup`(超管,202) `GET .../cleanup-runs` |
| 系统配置 | `/admin/system-configs`(超管) |
| 审计 | `GET /admin/audit-logs` `GET /admin/audit-logs/actions`(只读) |

**没有** `POST /admin/admins`。创建管理员:`pnpm admin:init`。

## 幂等

生图/文案提交请求头 `x-june-idempotency-key`(或 body `idempotencyKey`)。同一用户同一键返回同一任务,`deduplicated: true`。
