# JUNE-Commerce-Platform

品牌简称 **JUNE**。完整项目名 **JUNE-Commerce-Platform**。Logo 副标 `COMMERCE PLATFORM`。

面向电商团队的创作与运营平台,包含社区、工作台(生图 / 文案 / 店铺商品)和管理员站。

> 品牌 SVG 为按书面规则绘制的初稿,开发环境未收到参考图。对照清单见 [`docs/BRAND.md`](docs/BRAND.md)。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Web | Next.js 16、React 19、Tailwind CSS 4、Motion |
| API | NestJS 12 |
| Worker | BullMQ |
| 数据 | PostgreSQL 17、Prisma 7、Redis 7 |
| 存储 | S3 兼容对象存储 |
| 部署 | Docker Compose + Nginx(单机,非多机高可用) |

## 本地启动

```bash
cp .env.example .env
# 至少填写 SESSION_SECRET、CSRF_SECRET、CREDENTIAL_ENCRYPTION_KEY、PROVIDER_SECRET_ENCRYPTION_KEY
# 对象存储可用 docker compose 里的 MinIO;密钥用: openssl rand -base64 32

docker compose -f docker-compose.dev.yml up -d
pnpm install
pnpm db:generate
pnpm db:migrate && pnpm db:seed
pnpm admin:init
pnpm dev
```

- 站点:http://localhost:3000
- 管理站:http://localhost:3000/admin/login
- API 存活:http://localhost:3001/health
- API 就绪:http://localhost:3001/api/health/ready

演示数据(与真实数据隔离,邮箱域 `@demo.june.invalid`):

```bash
SEED_DEMO=true pnpm db:seed
```

## 生产部署

见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。镜像在开发机或 CI 构建,生产机不要现场编译。

```bash
./deploy/scripts/build-images.sh
./deploy/scripts/deploy.sh
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm admin:init` | 初始化超级管理员(不写死默认密码) |
| `pnpm db:studio` | Prisma Studio |
| `pnpm typecheck` / `pnpm test` | 类型检查 / 测试 |
| `pnpm loadtest:seed` | 压测规模数据(`@loadtest.invalid`,与业务数据隔离) |

## 文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 架构与页面清单
- [`docs/BRAND.md`](docs/BRAND.md) 品牌规范
- [`docs/API.md`](docs/API.md) 接口说明
- [`docs/REQUIREMENTS-MATRIX.md`](docs/REQUIREMENTS-MATRIX.md) 需求对应
- [`docs/BACKUP.md`](docs/BACKUP.md) 备份恢复
- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) 性能与连接池
- [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) 验收清单
- [`loadtest/README.md`](loadtest/README.md) 压测

## 待配置的外部凭据

在管理后台「模型」中填写供应商 API Key 与地址后才会出现在用户可选列表。未配置时功能可验证,但不会冒充生成成功。

- OpenAI / Google Gemini / 火山方舟 Seedream / 阿里云通义万相 / Black Forest Labs FLUX
- 微信 JS-SDK(分享)appId / appSecret / JS 安全域名
- 生产对象存储、HTTPS 证书、备份目标存储
