# 开发约定(所有模块必须遵守)

本文件是 monorepo 内各模块协作的唯一约定来源。新增代码前先读本文件,不要另立一套模式。

## 1. 依赖版本(已锁定,不要改动)

| 用途 | 版本 |
|---|---|
| TypeScript | `5.9.3` |
| Node 类型 | `@types/node` `22.20.2` |
| zod | `4.6.5` |
| NestJS 全家桶 | `12.0.1`(`@nestjs/config` 用 `12.0.0`,`@nestjs/throttler` 用 `6.5.0`) |
| Prisma | `7.10.0` + `@prisma/adapter-pg` `7.10.0` + `pg` `8.23.0` |
| Next.js / React | `16.3.5` / `19.3.0`(`@types/react` `19.3.0`) |
| Tailwind CSS | `4.3.3` + `@tailwindcss/postcss` `4.3.3` |
| BullMQ / ioredis | `5.81.5` / `5.11.1`(必须成对,BullMQ 5 内部依赖 ioredis 5) |
| Motion / Recharts / @xyflow/react / dagre | `13.3.0` / `3.10.1` / `12.11.6` / `0.8.5` |
| sharp | `0.35.4` |
| vitest | `5.0.0` |

> **不要运行 `pnpm install`**,除非你是负责整合的主任务。pnpm 12 启用了 `minimumReleaseAge` 供应链策略,
> 刚发布不到 24 小时的版本会被拒绝安装;新增依赖请选择已发布超过一天的版本。

## 2. 工作区包与导入

```
@june/shared     常量 / zod 契约 / 设计令牌 / SSE 事件(无运行时依赖,前后端共用)
@june/db         Prisma 客户端与枚举、角色常量
@june/providers  模型供应商适配层
@june/brand      BrandLogo 组件与品牌 SVG 资产
```

- **永远不要**从 `packages/db/generated/**` 直接导入,只用 `@june/db` 的出口。
- 校验规则**只在 `@june/shared` 定义一次**,前端与后端都引用同一个 schema。禁止在前端另写一套规则。
- 后端(api / worker)是 CommonJS,`tsconfig` 用 `module: CommonJS` + `moduleResolution: Node10`。

## 3. Prisma 使用

```ts
constructor(private readonly prisma: PrismaService) {}
// 访问方式是 this.prisma.db.xxx(客户端经 $extends 包装,PrismaService 不继承 PrismaClient)
const user = await this.prisma.db.user.findUnique({ where: { id } });
```

- 时间字段是 `timestamptz`,存 UTC。返回给前端统一用 `.toISOString()`。
- 金额用 `Decimal`,返回前端用字符串,禁止转 number。
- `BigInt`(存储字节数)返回前端也用字符串。
- 软删除:查询默认要带 `deletedAt: null`。
- 列表查询必须有分页:小列表用 `pageQuerySchema`,大列表(帖子、商品、任务、审计)用 `cursorQuerySchema`;默认每页 20,上限 100。
- 禁止 N+1:关联数据用 `include`/`select` 一次取出,或先批量查再在内存里组装。

## 4. 接口与校验

- 路由前缀统一 `/api`;管理站接口一律挂在 `/api/admin/**`。
- 校验用 zod 管道:
```ts
@Post()
create(@Body(zodBody(postPublishSchema)) dto: PostPublishInput) {}
@Get()
list(@Query(zodQuery(postListQuerySchema)) query: PostListQuery) {}
```
- 抛错只用 `AppException`,必须带 `@june/shared` 的错误码:
```ts
throw AppException.badRequest(ERROR_CODES.QUOTA_EXCEEDED, '存储空间不足');
throw AppException.notOwner();   // 资源不属于当前用户,统一按 404 语义返回
```
- 不要自己拼错误响应体,`AllExceptionsFilter` 会统一成 `ApiErrorBody`。

## 5. 认证与鉴权(已实现,直接用)

全局守卫顺序:`SessionGuard` → `CsrfGuard` → `RolesGuard` → `ReauthGuard`。

```ts
@Public()                       // 跳过登录校验(仍会尝试解析会话,用于"是否已点赞")
@SkipCsrf()                     // 仅登录/注册这类还没有会话的写接口
@MinRoleLevel(50)               // 最低角色等级
@RequirePermissions('post.manage')
@RequireReauth()                // 查看店铺密码这类敏感操作
@CurrentUser() user: AuthUser    // 注入当前用户(未登录直接抛异常)
@OptionalUser() user: AuthUser | null
@ClientInfo() meta              // { ip, userAgent },审计用
```

- `/api/admin/**` 的会话作用域由**路径**决定(独立 Cookie),且 `RolesGuard` 会无条件要求管理员等级——即使控制器忘了加装饰器也不会泄漏。
- **每个查询都要带归属条件**,不要"先查再比对":
```ts
// 正确
const shop = await this.prisma.db.shop.findFirst({ where: { id, ownerId: user.id, deletedAt: null } });
if (!shop) throw AppException.notOwner();
```
- 管理员可读业务数据,但**店铺密码解密接口对管理员同样关闭**。

## 6. 审计

管理操作、敏感操作、状态变更都要写审计:
```ts
await this.audit.record({
  actor: user, action: 'post.hide', targetType: 'Post', targetId: post.id,
  diff: this.audit.buildDiff(before, after), ip: meta.ip, userAgent: meta.userAgent,
});
```
`AuditService` 会在写库前把 password/secret/token/apiKey 等字段替换为 `[redacted]`;但**不要主动传这些字段**。

## 7. 资产与图片

- 上传链路:`POST /api/assets/upload-ticket` → 浏览器 PUT → `POST /api/assets/:id/confirm`。
- 业务关联图片前必须 `assetsService.assertOwnedActive(userId, assetIds, [AssetKind.XXX])`。
- 关联/解绑时维护引用计数:`assetsService.addRefs(ids, +1 / -1)`。
- 列表读 `thumbUrl`,详情读 `previewUrl`,下载读原图。用 `AssetUrlService` 生成地址,不要自己拼 URL。
- 生成图保存到商品/帖子时**复用同一 Asset**(`reuseForBusiness`),不复制文件。

## 8. 队列与耗时任务

API **不同步执行**生图、大图压缩、大批量导入。统一通过 `QueueProducerService` 入队,由 `apps/worker` 消费。
API 只负责:参数强校验 → 配额/并发/队列容量检查 → 幂等检查 → 入队 → 立刻返回 taskId。

## 9. SSE

- 每标签页复用一条连接:`GET /api/events/stream`。
- 事件类型见 `@june/shared` 的 `SseEvent`。
- 配置类事件**只推版本号**,前端收到后补拉公开配置接口。**绝不推送密钥或内部系统提示词**。
- 任务事件按 `userSseChannel(userId)` 定向推送;跨进程通过 Redis Pub/Sub 汇聚。

## 10. 前端约定(apps/web)

- 所有 Logo 只能用 `@june/brand` 的 `BrandLogo` 组件,禁止各页面自行拼 SVG 或用 `<img>`。
- 颜色、圆角、阴影、动效时长只用 `@june/shared` 的设计令牌映射出的 CSS 变量,不写魔法色值。
- **浅色背景上的小字号青绿必须用 `#0C7E72`(teal-700)**,`#56DECD` 在白底只有 1.6:1 对比度。
- 页面标题格式:`pageTitle('社区')` → `社区 · JUNE`。页脚/关于展示完整名称 `JUNE-Commerce-Platform`。
- 动效只用 `opacity` / `transform`,并且必须响应 `prefers-reduced-motion: reduce`。
- 必须实现的状态:加载、空状态、错误 + 重试、上传进度、保存状态、删除确认。
- 不用 emoji 充当功能图标(用 `lucide-react`)。
- 断点检查:390 / 768 / 1440。移动端导航折叠;生图页从左右分栏改为上下结构。
- 所有写请求都要带 CSRF 头:从 `june_csrf` Cookie 读值放进 `x-june-csrf`。

## 11. 禁止事项

- 禁止把供应商 API Key、内部系统提示词、店铺密码明文下发到前端或写入日志。
- 禁止用"性能优化"为理由删减业务功能。
- 禁止伪造进度百分比:上游没给真实百分比时只展示阶段文案。
- 禁止盲目重试可能已计费的上游调用:结果未知时先核对(状态 `UNKNOWN`)。
- 禁止让权限判定或"模型是否停用"依赖可能过期的缓存放行。
- 未实现或未验证的功能必须在 `docs/ACCEPTANCE.md` 显式列出,不得含糊表述。
