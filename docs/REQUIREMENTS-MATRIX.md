# 需求对照矩阵

按用户需求分条。状态:

- **已实现**:代码路径可指出,本机可按「验证」步骤复现。
- **未验证**:代码在,但本轮未在浏览器 / 压测机上跑通。
- **未做**:明确缺口。

| 状态图例 | 含义 |
| --- | --- |
| 已实现 | 有实现位置 |
| 未验证 | 有实现,缺实测记录 |
| 未做 | 无实现或仅占位 |

---

## 1. 品牌与视觉

| 需求 | 状态 | 实现位置 | 验证 |
| --- | --- | --- | --- |
| 完整名 JUNE-Commerce-Platform,简称 JUNE,副标 COMMERCE PLATFORM | 已实现 | `packages/shared/src/constants.ts`;`packages/brand` | 登录页 / 管理站侧栏 BrandLogo,页脚全文 |
| 只用 BrandLogo,禁止自拼 SVG | 已实现 | 各布局引用 `@june/brand` | 源码检索不得出现手写品牌 path |
| 品牌 SVG 对照参考图校准 | 未做 | `docs/BRAND.md` 已声明初稿 | 拿到设计图后按 BRAND.md 文末清单校准 |
| 深色:登录/首页/工作台;浅色:社区、/admin | 已实现 | `app/layout.tsx` `data-theme`;`(admin)/layout.tsx` + `(console)/layout.tsx`;`app-shell.tsx` | 打开对应路由看 `data-theme` |
| 语义色,浅色小字号青绿用 `text-accent` | 已实现 | `docs/WEB_UI_CONTRACT.md`;globals.css | 管理站数字旁 InfoHint 对比度 |

## 2. 认证与会话

| 需求 | 状态 | 实现位置 | 验证 |
| --- | --- | --- | --- |
| 社区与工作台共用账号 | 已实现 | `AuthController`;`apps/web` `(app)` 布局 | 登录后 `/` 双入口可进两边 |
| /admin 独立登录与 Cookie | 已实现 | `AdminAuthController`;`SESSION_COOKIE_ADMIN`;`admin-auth-provider.tsx`;`app/(admin)/admin/login` | 站点登录后直接开 `/admin` 应被要求管理登录 |
| CSRF 双提交 Cookie | 已实现 | `june_csrf` + `x-june-csrf`;管理站写请求走 `adminApi` | 去掉请求头后写接口返回 `CSRF_FAILED` |
| 改密码 / 禁用作废全部会话 | 已实现 | `User.sessionEpoch` | 改密后旧标签页再请求 401 |
| 管理员角色后端校验 | 已实现 | `RolesGuard` 对 `/api/admin/**` | 非管理员调 `/api/admin/dashboard` 失败,与密码错误码不泄露身份(管理登录) |

## 3. 社区

| 需求 | 状态 | 实现位置 | 验证 |
| --- | --- | --- | --- |
| 大厅:封面/标题/摘要/作者/时间/赞评/置顶,搜索,最新/热门,分页 | 已实现 | `apps/web/src/app/(app)/community`;`PostsController` | 打开 `/community` |
| 详情、评论回复、点赞、分享 | 已实现 | `community/*` 控制器与 hooks | 点一篇已发布帖 |
| 发布/编辑/草稿自动保存 | 已实现 | `drafts.controller.ts`;`use-draft-autosave.ts` | `/community/new` 断网再连看保存状态 |
| 热门口径与提示 | 已实现 | `HOT_SCORE_WEIGHTS`;`hot-sort-hint.tsx` | 切到热门排序看问号说明 |
| 公开链接未登录可看已发布 | 已实现 | middleware `PUBLIC_PREFIXES`;`@Public()` | 无 Cookie 打开 `/community/posts/:slug` |

## 4. 工作台

| 需求 | 状态 | 实现位置 | 验证 |
| --- | --- | --- | --- |
| 生图:参考图、参数、提交、结果、下载/保存商品 | 已实现 | `generation.controller.ts`;`/workbench/image` | 需配置真实 Key 或 MOCK;未配置不可选,不得伪造成功 |
| 文案生成与检查 | 已实现 | `POST /api/generation/copy`;`POST /api/copy/check` | 输入违禁词应被拦 |
| 店铺主子、继承、关系图 | 已实现 | `shops.controller.ts`;`/workbench/shops/graph` | 建主店+子店,改主店字段看未覆盖项同步 |
| 店铺密码掩码,重验后查看 | 已实现 | `POST .../credentials/:id/reveal` + `REAUTH_HEADER` | 管理员接口仍不能看密码 |
| 商品 CRUD、CSV 导入 | 已实现 | `products.controller.ts`;`product-import.controller.ts` | 下载模板、预览、提交 |
| 存储用量 | 已实现 | `GET /api/assets/usage`;`/workbench/storage` | 上传后数字增加 |
| 移动端生图上下结构 | 未验证 | 工作台 layout / 生图页 | 390 宽视口走查 |

## 5. 模型与任务

| 需求 | 状态 | 实现位置 | 验证 |
| --- | --- | --- | --- |
| 后台配置供应商/模型,Key 加密,读只掩码 | 已实现 | `model-admin.controller.ts`;`/admin/models` | 保存后刷新只见掩码 |
| 选择策略 user_selectable / fixed | 已实现 | `PUT /admin/models/policy`;模型页「选择策略」 | fixed 后工作台无选择器,改请求体仍被拒 `MODEL_SELECTION_LOCKED` |
| 配置 2 秒热更新(只推版本号) | 已实现 | `ConfigRevision` + SSE `config.updated` | 改模型后工作台补拉 `/api/models/config` |
| 幂等提交、失败项重试、未知结果不盲重试 | 已实现 | `GenerationTask.idempotencyKey`;`UNKNOWN` 状态 | 同一 idempotencyKey 返回同一 taskId |
| 未拿到真实百分比不编造进度 | 已实现 | `progressPercent` 可空;前端 `Progress` value=null | 运行中任务无数字百分比 |
| MOCK 供应商显著标识 | 已实现 | `packages/providers/src/image/mock.ts`;种子 `mock-loadtest` | 名称含 MOCK,图面有 MOCK 字 |

## 6. 管理站 `/admin`

| 需求 | 状态 | 实现位置 | 验证 |
| --- | --- | --- | --- |
| 独立登录 BrandLogo + 全名 | 已实现 | `app/(admin)/admin/login/page.tsx` | 打开 `/admin/login` |
| 仪表盘数字+口径 InfoHint、日期、Recharts | 已实现 | `DashboardScreen`;`AdminDashboardView` | `/admin` 每个数字旁有问号 |
| 用户列表搜索分页启用禁用 | 已实现 | `/admin/users` | 禁用后该用户站点会话失效 |
| 用户详情店铺主子、商品下钻、不能看店铺密码 | 已实现 | `/admin/users/[id]`;`canViewShopPasswords: false` | 凭据区无密码字段 |
| 帖子隐藏恢复置顶排序编辑 | 已实现 | `/admin/posts`;`PUT /admin/posts/pin-order` | 置顶上移下移后大厅顺序变 |
| 评论隐藏恢复删除 | 已实现 | `/admin/comments` | 操作后公开页不可见 |
| 模型 CRUD、连接测试、策略、Key 掩码可替换 | 已实现 | `/admin/models` | 替换 Key 输入框为空,不回显明文 |
| 内容规则 CRUD 启停版本 | 已实现 | `/admin/content-rules` | 保存后版本列表 +1 |
| 分享配置 | 已实现 | `/admin/share` | appSecret 仅掩码 |
| 任务记录与失败原因 | 已实现 | `/admin/tasks` | 失败行展示 errorCode/message(已脱敏) |
| 存储用量与清理预览/执行 | 已实现 | `/admin/storage` | 预览 dryRun=true,执行需二次确认 |
| 系统配置(超管) | 已实现 | `/admin/system` | 普通管理员 403 |
| 审计 | 已实现 | `/admin/audit` | 无删除按钮 |
| 创建管理员 REST | 已实现 | `POST /api/admin/users`(`adminCreateAdminSchema`);`AdminsScreen` 创建对话框;首个超管仍用 `pnpm admin:init` | 超管登录后 `/admin/admins` 创建;邮箱冲突返回 `CONFLICT` |
| 最后一个超管保护 | 已实现 | `LAST_SUPER_ADMIN` | 撤销唯一超管应失败 |

## 7. 存储与安全

| 需求 | 状态 | 实现位置 | 验证 |
| --- | --- | --- | --- |
| 直传 → confirm → 派生图 | 已实现 | `POST /api/assets/upload-ticket`;`POST /api/assets/:id/confirm` | 未 confirm 的对象不能当业务图 |
| 私有资源短时签名 URL | 已实现 | `AssetUrlService` | 过期链接 403 |
| 配额预检 | 已实现 | `QUOTA_EXCEEDED` | 把配额调到极小再上传 |
| SSRF 拒绝内网供应商 URL | 已实现 | `PROVIDER_URL_NOT_ALLOWED` | 填 `http://127.0.0.1` 应拒绝(除非显式放开压测开关) |
| 前端资源无 API Key 明文 | 已实现 | 管理站只存掩码;query cache 不含 apiKey | 网络面板与 React Query 缓存检索 |

## 8. 部署运维

| 需求 | 状态 | 实现位置 | 验证 |
| --- | --- | --- | --- |
| 单机 Docker Compose + Nginx | 已实现 | `docker-compose.yml`;`deploy/nginx` | 见 `docs/DEPLOYMENT.md` |
| 迁移不在 api 启动时自动跑 | 已实现 | `deploy/scripts/deploy.sh` 一次性 migrate job | 读脚本步骤 2 |
| 每日备份 / 恢复演练 | 已实现 | `deploy/scripts/backup-db.sh` `restore-db.sh` `verify-backup.sh` | 见 `docs/BACKUP.md` |
| 4 核 8G 连接池与并发初值 | 已实现 | `.env.example`;`docker-compose.yml` postgres 参数 | 见 `docs/PERFORMANCE.md` |
| 压测脚本 | 已实现 | `loadtest/k6/*` | **未验证**(未在本轮跑 k6 并记录数字) |
| 50 人同时生图达标数据 | 未验证 | 脚本有,无实测表 | 跑 `image-submit-50.js` 后把摘要贴进 PERFORMANCE |

## 9. 明确未做 / 未验证汇总

1. 品牌 SVG 对照官方设计图 — **未做**(无参考图)。
2. k6 四套脚本的 P95 / 失败率 — **未验证**,禁止把空结果写成达标。
3. 微信 / QQ 真实分享联调 — **未验证**(缺 appId/secret 与 JS 安全域名)。
4. 五家真实模型联调 — 种子 `limits.verified=false`,管理站标注待联调;**未验证**。
5. 390 / 768 / 1440 全页走查 — 布局已按断点写,**本轮未做完整视口验收**。
