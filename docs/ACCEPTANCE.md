# 验收清单

勾选前必须实际点过 / 跑过。代码存在 ≠ 已验收。品牌 SVG、真实模型、k6 数字未测项不要勾。

## A. 启动与账号

- [ ] `cp .env.example .env` 后按注释填密钥
- [ ] `docker compose -f docker-compose.dev.yml up -d`
- [ ] `pnpm db:migrate && pnpm db:seed`
- [ ] `pnpm admin:init` 能登录 `/admin/login`(BrandLogo + JUNE-Commerce-Platform)
- [ ] `pnpm dev`;站点 `/login` 与管理站会话互不通用
- [ ] 演示数据仅 `@demo.june.invalid`(可选 `SEED_DEMO=true`)

## B. 品牌与主题

- [ ] 所有 Logo 来自 `<BrandLogo>`,无手写品牌 SVG
- [ ] 登录 / 首页 / 工作台深色,社区与 `/admin` 浅色
- [ ] 页面标题为「页面名 · JUNE」
- [ ] 品牌初稿待对照参考图(见 `docs/BRAND.md`)——此项保持不勾,直到校准完成

## C. 社区

- [ ] 大厅列表、搜索、最新/热门、置顶、分页/加载更多
- [ ] 热门口径可从 InfoHint 读到,与代码 `HOT_SCORE_WEIGHTS` 一致
- [ ] 未登录可打开已发布公开链接;草稿/隐藏不可
- [ ] 发布、编辑、草稿自动保存状态真实
- [ ] 点赞、评论/回复、删除自己的评论
- [ ] 分享:未配置微信时明确提示并降级复制链接/二维码,不假装成功

## D. 工作台

- [ ] 生图:无凭据时模型不可选,不伪造成功
- [ ] 提交快速返回;进度无真实百分比时只显示阶段
- [ ] 幂等键重复提交返回同一任务
- [ ] 失败项可重试且已成功张数不重出
- [ ] 上游 UNKNOWN 不盲重试付费调用
- [ ] 文案:输入/输出检查,未通过不展示违规正文
- [ ] 店铺主子、继承/覆盖、关系图
- [ ] 店铺密码默认掩码,重验后可看;复制写审计
- [ ] 商品 CRUD、图片上传真实进度、CSV 导入逐行错误
- [ ] 存储用量与配额提示
- [ ] 390 宽:导航为抽屉,生图上下结构

## E. 管理站

- [ ] `/admin/login` 独立 Cookie
- [ ] 仪表盘数字均有口径 InfoHint,日期筛选,趋势图
- [ ] 用户列表搜索分页启用禁用(禁用作废会话)
- [ ] 用户详情店铺主子 + 商品下钻;文案写明不能查看店铺密码
- [ ] 帖子隐藏/恢复/置顶/排序(`PUT /admin/posts/pin-order`)/编辑
- [ ] 评论隐藏/恢复/删除
- [ ] 供应商/模型 CRUD、连接测试、user_selectable/fixed;API Key 仅掩码可替换
- [ ] 内容规则 CRUD、启停、版本列表
- [ ] 分享配置掩码
- [ ] 任务失败原因(脱敏)
- [ ] 存储预览 dryRun / 执行二次确认
- [ ] 系统配置仅超管
- [ ] 审计只读
- [ ] 管理员页可创建管理员(`POST /admin/users`);最后一个超管不能撤;首个超管仍用 `pnpm admin:init`

## F. 安全

- [ ] CSRF:去掉 `x-june-csrf` 写请求失败
- [ ] 越权:用户 A 打用户 B 的店铺/资产/任务 403
- [ ] 供应商 URL 指向 `127.0.0.1` 被拒(压测开关关闭时)
- [ ] 前端源码与网络响应无 API Key 明文
- [ ] 前端隐藏按钮不能代替后端拒绝

## G. 部署与备份

- [ ] `docs/DEPLOYMENT.md` 按脚本走通一次(可在预发)
- [ ] 迁移不在 api 启动时自动执行
- [ ] `backup-db.sh` 产出 `.dump.gz` 且 `pg_restore --list` 可读
- [ ] `verify-backup.sh` 演练成功
- [ ] 图片桶已开版本控制;备份桶与图片桶分离

## H. 性能(必须贴实测,禁止空勾)

- [ ] `pnpm loadtest:seed` + MOCK provider
- [ ] `k6 run loadtest/k6/mixed-50vu-30m.js` — 把 P95/失败率记入 `docs/PERFORMANCE.md`
- [ ] `business-20rps.js`
- [ ] `ai-submit-p95.js`(提交延迟,不是出图完成)
- [ ] `image-submit-50.js`(记录 accepted/rejected,含 `QUEUE_FULL` 为有效结果)

## I. 明确不验收

- 真实五家模型画质与计费(未配 Key 或 `verified=false`)
- 微信/QQ 正式环境 JS-SDK(缺域名与密钥)
- 品牌设计图像素级还原(无参考图)
- 多机高可用 / K8s
