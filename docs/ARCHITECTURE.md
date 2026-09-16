# JUNE-Commerce-Platform 架构说明

> 品牌简称 **JUNE**;完整项目名 **JUNE-Commerce-Platform**;Logo 副标 `COMMERCE PLATFORM`。

## 1. 总体形态

模块化单体(modular monolith),单机 Docker Compose 部署。保留后续拆分数据库、横向增加 Worker 的能力,**当前不引入**微服务集群、Kubernetes 或独立工作流编排平台。

```
                       ┌──────────────────────────────┐
   浏览器 ──HTTPS──▶   │  Nginx (TLS / 压缩 / 反代)     │
                       │  SSE 关闭 proxy_buffering      │
                       └───────┬──────────────┬────────┘
                               │              │
                    ┌──────────▼───┐   ┌──────▼──────────────┐
                    │ apps/web     │   │ apps/api            │
                    │ Next.js 16   │   │ NestJS 12 (Express) │
                    │ 社区/工作台/  │──▶│ 认证·权限·业务·SSE   │
                    │ /admin       │   └──┬───────┬──────┬───┘
                    └──────────────┘      │       │      │
                                          │       │      │
                        ┌─────────────────▼─┐ ┌───▼────┐ │
                        │ PostgreSQL 17     │ │ Redis 7│ │
                        │ 权威业务数据       │ │ 队列+  │ │
                        │ (内网 only)       │ │ 缓存+  │ │
                        └───────────────────┘ │ PubSub │ │
                                              └───┬────┘ │
                                                  │      │
                                     ┌────────────▼──────▼──────┐
                                     │ apps/worker              │
                                     │ BullMQ 消费者            │
                                     │ 生图·文案·缩略图·导入·清理 │
                                     └────────────┬─────────────┘
                                                  │
                        ┌─────────────────────────▼────────────────┐
                        │ 对象存储 (S3 兼容)                        │
                        │ 原图 + 派生图;私有资源走短时签名 URL      │
                        └──────────────────────────────────────────┘
                                                  │
                                     ┌────────────▼─────────────┐
                                     │ 第三方模型 API(服务器侧)  │
                                     │ OpenAI / Gemini / 方舟    │
                                     │ Seedream / 通义万相 / FLUX │
                                     └──────────────────────────┘
```

无本地 GPU:所有模型能力通过服务器调用第三方 API 实现。

## 2. 仓库结构

```
apps/
  web/        Next.js 16(App Router):社区、工作台、/admin 管理员站
  api/        NestJS 12:统一认证、权限、业务接口、SSE
  worker/     独立进程:模型任务、缩略图派生、CSV 导入、清理、备份编排
packages/
  shared/     常量、zod 校验契约、设计令牌、SSE 事件契约(前后端共用同一份)
  db/         Prisma 7 schema、迁移、种子、管理员初始化
  providers/  模型供应商适配层(5 家生图 + 2 种文本协议 + 压测模拟服务)
  brand/      BrandLogo 组件与全套品牌 SVG / 图标资产
deploy/       Dockerfile、docker-compose.prod.yml、Nginx、备份脚本
loadtest/     k6 压测脚本 + 可控模拟供应商服务
docs/         架构、品牌、API、部署、备份恢复、性能、验收清单
```

## 3. 依赖版本锁定(已核对官方文档与互相兼容性)

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22.11(容器用 24) | Next 16 要求 ≥ 20.9 |
| TypeScript | 5.9.3 | 未采用 7.x 原生编译器,以保证 NestJS 装饰器元数据稳定 |
| Next.js / React | 16.3.5 / 19.3.0 | Next 16 peer 要求 React ^19 |
| NestJS | 12.0.3(全家桶同版本) | platform-express,rxjs 7 |
| Prisma | 7.10.0 + `@prisma/adapter-pg` 7.10.0 + pg 8.23.0 | v7 为无 Rust 客户端,**必须**用 driver adapter;generator 为 `prisma-client` 且 `output` 必填;连接串配置在 `prisma.config.ts` |
| PostgreSQL | 17 | |
| Redis | 7 | 队列 db0(noeviction)+ 缓存 db1(allkeys-lru + TTL) |
| BullMQ / ioredis | 5.81.5 / 5.11.1 | ioredis 5 是 BullMQ 5 的 peer 要求;队列连接必须 `maxRetriesPerRequest: null` |
| Tailwind CSS | 4.3.3(`@tailwindcss/postcss`) | CSS-first 配置,无 tailwind.config.js |
| zod | 4.6.5 | 前后端共用校验 |
| Motion / Recharts / @xyflow/react / dagre | 13.3.0 / 3.10.1 / 12.11.6 / 0.8.5 | 动效 / 图表 / 关系图 |

> Prisma 7 生成的客户端在 `packages/db/generated/`(不入库),`moduleFormat = "cjs"` 以匹配 NestJS/Worker 的 CommonJS 产物。

## 4. 数据模型

需求要求的 17 个实体全部落地,另补 7 个支撑实体:

| 分组 | 实体 |
|---|---|
| 账号权限 | `User`、`Role`、`UserRole`、`Session`、`ReauthToken`(敏感操作重验令牌) |
| 社区 | `Post`(草稿用 status=DRAFT)、`Comment`、`Like` |
| 商业 | `Shop`、`ShopCredential`、`Product`、`ImportJob`(CSV 导入作业) |
| 存储 | `Asset`、`StorageUsage`(每用户配额与用量) |
| 模型 | `ModelProvider`、`ModelConfig` |
| 任务 | `GenerationTask`、`GenerationResult` |
| 治理 | `ContentRule`、`ContentRuleVersion`(版本记录)、`SystemConfig`、`ConfigRevision`(SSE 配置版本)、`AuditLog`、`CleanupRun`(清理执行记录) |

关键约束:

- `Like` 有 `@@unique([postId, userId])` —— 用唯一约束而非应用层判断防重复点赞。
- `GenerationTask` 有 `@@unique([userId, idempotencyKey])` —— 幂等提交的数据库级保证。
- `Asset` 有 `@@unique([ownerId, sha256, kind])` —— 去重默认限同一用户。
- `Product` 有 `@@unique([shopId, sku])`。
- 软删除:`deletedAt` + 状态枚举;时间统一 `timestamptz` 存 UTC,展示时区在前端本地化。
- 会话失效:`User.sessionEpoch` 与 `Session.epoch` 比对,退出/禁用/改密码时前移 epoch,一次性使所有旧会话失效。

## 5. 页面清单

### 5.1 公共 / 认证(深色)
| 路由 | 页面 | 关键要素 |
|---|---|---|
| `/login` | 登录 | BrandLogo + 简洁表单,克制光晕渐变背景,页脚含完整名称 |
| `/register` | 注册 | 同上视觉语言 |
| `/` | 登录后首页 | 深靛蓝全屏、青紫柔光晕、细纹理、轻量缓慢动效;**屏幕正中央「社区」「工作台」两张大型入口卡片**;半透明材质 + 细边框 + 轻悬停反馈;顶部品牌与用户菜单;完整品牌组合置于中央入口上方 |
| `/settings/profile` | 个人资料 | 昵称、简介、头像上传 |
| `/settings/security` | 安全 | 修改密码(改后所有会话失效) |

### 5.2 社区(浅色)
| 路由 | 页面 |
|---|---|
| `/community` | 帖子大厅:封面/标题/摘要/作者/时间/点赞数/评论数/置顶标识;搜索 + 最新/热门 + 分页 |
| `/community/posts/[slug]` | 已发布帖公开详情:完整图文、作者、发布与编辑时间、点赞、评论与回复、分享面板(隐藏/草稿/删除不可访问) |
| `/p/[slug]` | 稳定短链,永久跳转到 `/community/posts/[slug]` |
| `/community/posts/new` | 发布:标题 + 富文本 + 多图上传 + 预览 + 草稿自动保存状态 |
| `/community/new` | 兼容跳转到 `/community/posts/new` |
| `/community/posts/[slug]/edit` | 编辑已发布帖子 |
| `/community/drafts` | 我的草稿:继续编辑 / 发布 / 删除 |
| `/community/drafts/[id]` | 继续编辑指定草稿 |
| `/community/mine` | 我的帖子管理 |

### 5.3 工作台(深色,左侧导航)
| 路由 | 页面 |
|---|---|
| `/workbench` | 概览:配额、进行中任务、最近生成 |
| `/workbench/image` | 生图工作流:参考图与提示词 → 参数 → 提交 → 结果 → 下载/保存到商品。右侧结果区自适应网格 |
| `/workbench/image/history` | 生图历史与失败重试 |
| `/workbench/copy` | 商品标题与文案:输入/选商品 → 后端生成与检查 → 展示 → 编辑/复制/保存 |
| `/workbench/copy/history` | 文案历史 |
| `/workbench/shops` | 店铺列表:总数/主店数/子店数/每店商品数,搜索 |
| `/workbench/shops/[id]` | 店铺详情:字段继承与覆盖状态、子店、凭据入口 |
| `/workbench/shops/graph` | 关系图:缩放、拖动、Dagre 自动布局、点击查看详情 |
| `/workbench/shops/[id]/credentials` | 店铺账号密码:掩码显示、重验后查看/复制 |
| `/workbench/products` | 商品列表:搜索、筛选、游标分页 |
| `/workbench/products/new`、`/workbench/products/[id]` | 商品表单、图片上传 |
| `/workbench/products/import` | CSV 导入:模板下载、预览、校验、逐行错误 |
| `/workbench/credentials` | 全部店铺凭据入口 |
| `/workbench/tasks` | 生成任务记录 |
| `/workbench/storage` | 存储用量与配额 |

移动端:导航折叠为抽屉;**生图页面由左右分栏切换为上下结构**。

### 5.4 管理员站 `/admin`(独立登录入口与布局)
| 路由 | 页面 |
|---|---|
| `/admin/login` | 独立登录入口(独立会话 Cookie) |
| `/admin` | 仪表盘:用户数/新增/活跃、店铺、商品、帖子、任务数与成功率,日期筛选 + 趋势图 + **口径说明** |
| `/admin/users`、`/admin/users/[id]` | 用户管理:搜索分页、启用禁用、逐级查看店铺(名称/主子关系)与商品 |
| `/admin/posts`、`/admin/posts/[id]` | 帖子增删改查、隐藏恢复、置顶与排序 |
| `/admin/comments` | 评论管理 |
| `/admin/models` | 供应商与模型:增删改停用、连接测试、固定模型策略 |
| `/admin/content-rules` | 系统提示词、违禁词、禁用表达、禁止类别、平台规则 + 版本记录 |
| `/admin/share` | 分享配置(应用信息、域名、密钥) |
| `/admin/tasks` | 任务记录与失败原因 |
| `/admin/storage` | 存储用量与清理(预览/执行/幂等重跑) |
| `/admin/system` | 并发与系统配置 |
| `/admin/audit` | 审计日志 |
| `/admin/admins` | 管理员账号管理(禁止删除/禁用最后一个超级管理员) |

## 6. 关键机制设计

### 6.1 认证与会话
HttpOnly + Secure + SameSite=Lax 会话 Cookie,数据库只存 `sha256(token)`。CSRF 采用双提交 Cookie:`june_csrf`(可读)+ 请求头 `x-june-csrf`,对所有非幂等方法校验。站点会话与 `/admin` 会话使用不同 Cookie 名与 `SessionScope`,管理员角色**在后端校验**,前端隐藏入口不作为安全边界。

### 6.2 逐资源鉴权
所有业务表带 `ownerId`。读写、文件访问、导出、SSE 订阅一律校验归属:
- 私有资产(店铺图、参考图、生成结果)只通过后端签发的短时 URL 访问;
- SSE 任务事件按 `userId` 定向频道推送;
- 管理员可读业务数据,但**店铺密码解密接口对管理员同样关闭**。

### 6.3 存储链路
`申请直传凭证 → 浏览器 PUT 到对象存储 → confirm 校验实际内容/大小/归属 → 关联业务 → Worker 派生缩略图/预览图`。
数据库只存对象键与元信息;列表读 `thumb`,详情读 `preview`(优先 WebP、保留透明通道),下载读原图。删除进入可配置回收期,`refCount > 0` 不物理删除。

### 6.4 模型配置热更新(目标 2 秒内)
配置写库 → `ConfigRevision.version` 自增 → 失效 Redis 缓存 → 通过 Redis Pub/Sub 广播 → 各 API 实例在 SSE 连接上推送 `config.updated{scope, version}` → 前端**补拉公开配置接口**。
只推版本号不推内容,从根本上避免密钥与内部系统提示词泄漏;重连时用版本号对齐最新状态。

### 6.5 生图任务生命周期
`提交(幂等校验/参数强校验/配额与队列容量检查) → 快速返回 taskId → BullMQ 排队 → Worker 取出前重新校验模型停用状态 → 适配器调用(同步或异步轮询) → 结果转存对象存储 → 更新 GenerationResult`。
- 批量拆分调用时每次调用都计入供应商限流与计费统计;
- 上游结果未知时置 `UNKNOWN` 并先核对,不盲目重试付费调用;
- 失败项重试只针对失败 `seq`,已成功图片不重复生成;
- 未拿到真实百分比时只上报阶段,不编造进度。

### 6.6 文案生成管线
`输入检查 → 注入系统规则(后端,不下发前端) → 模型结构化输出 → zod 校验格式 → 输出检查 → 必要时有限次数重写或拦截`。
用户输入被当作**待处理内容**,不能覆盖系统规则;未通过检查的内容不提前流式展示。

### 6.7 并发与队列
全局限制跨所有 Worker 生效(Redis 计数器 + BullMQ 分组),另设供应商级频率限制。初值:生图全局 5、文案全局 10、每用户生图运行中 1 / 待执行 3、图片处理 1~2。队列设容量上限与公平调度,满载显式反馈。

## 7. 实施顺序

1. **基础设施**:monorepo、TS 配置、环境模板、依赖版本锁定 ✅
2. **数据层**:Prisma schema(24 实体)、迁移、种子、管理员初始化命令 ✅(schema/客户端已通过校验)
3. **共享契约**:常量、zod 契约、设计令牌、SSE 事件 ✅
4. **品牌资产**:BrandLogo 组件 + 全套 SVG/图标
5. **供应商适配层**:5 家生图 + 2 种文本协议 + 模拟服务
6. **API 核心**:配置、Prisma/Redis 模块、会话认证、CSRF、RBAC、归属校验、统一错误与限流
7. **API 业务**:存储 → 社区 → 店铺/商品/凭据 → 模型与生成 → 文案规则 → 管理站 → SSE
8. **Worker**:队列、并发闸门、生图/文案处理器、缩略图、CSV 导入、清理与热门分重算
9. **Web**:设计系统 → 登录/首页 → 社区 → 工作台 → /admin ✅（页面已挂路由；浏览器验收见 `docs/ACCEPTANCE.md`）
10. **部署与运维**:Docker Compose、Nginx、健康检查、备份恢复、监控
11. **压测与验收**:模拟供应商、k6 脚本、参考数据规模播种、按清单逐项验收

## 8. 需求对应表

见 [`docs/REQUIREMENTS-MATRIX.md`](./REQUIREMENTS-MATRIX.md)——按需求条目逐项列出实现位置与验证方式,未实现项显式标注。
