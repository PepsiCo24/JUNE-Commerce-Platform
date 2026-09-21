# 生产部署(单机 Docker Compose + Nginx)

目标机:Linux / 4 核 / 8GB / 磁盘按对象存储外置估算 100GB SSD。**不是**多机高可用。发布、迁移、回滚都需要维护窗口。

脚本目录:`deploy/scripts/`。镜像名默认 `june/{api,web,worker}:$JUNE_IMAGE_TAG`。

GitHub 推送后自动发布：见 [自动部署接入说明](AUTO_DEPLOY.md)，复用本文的首次上线、备份和回滚流程。

## 0. 在开发机或 CI 构建镜像

生产 compose **故意不写 `build:`**,避免在 4C8G 上现场编译 OOM。

```bash
# 仓库根,已填写 .env
export JUNE_IMAGE_TAG=v0.1.0
./deploy/scripts/build-images.sh
# 将镜像导入/推送到生产机可见的仓库,或 docker save | ssh 到生产机 docker load
```

## 1. 首次上线

在生产机仓库根:

```bash
cp .env.example .env
# 按 .env.example 注释填完所有 ? 必填项,替换全部 change-me / 空密钥
# PUBLIC_WEB_ORIGIN 必须是 https://你的域名
# COOKIE_DOMAIN 按实际填写;TRUST_PROXY_HOPS=1

# TLS:Let's Encrypt webroot 或自签
./deploy/scripts/gen-selfsigned-cert.sh   # 仅内网联调
# 证书放到 deploy/nginx/certs/{fullchain.pem,privkey.pem,chain.pem}

./deploy/scripts/bootstrap.sh
# 步骤:检查 docker → 校验 .env → 证书 → 起 postgres/redis → 扩展 → migrate → admin:init → 起 api/worker/web/nginx
```

跳过交互式管理员:`SKIP_ADMIN_INIT=1 ./deploy/scripts/bootstrap.sh`,然后:

```bash
docker compose --profile migrate run --rm migrate pnpm admin:init
# 或环境变量 ADMIN_INIT_EMAIL / ADMIN_INIT_PASSWORD
```

健康:

```bash
./deploy/scripts/healthcheck.sh
curl -k https://127.0.0.1/healthz          # Nginx 入口
curl -k https://127.0.0.1/api/health/ready # 业务就绪
```

装定时任务(每日备份 / 每周恢复演练 / 巡检):

```bash
./deploy/scripts/install-cron.sh --show
./deploy/scripts/install-cron.sh
```

## 2. 日常发布(维护窗口)

窗口建议:业务低峰,至少 15–30 分钟。发布期会短暂不可用(单机滚动,无多副本)。

```bash
export JUNE_IMAGE_TAG=v0.1.1
./deploy/scripts/deploy.sh
```

`deploy.sh` 顺序:

1. 默认先 `backup-db.sh --tag predeploy-$TAG`(可用 `SKIP_BACKUP=1` 跳过)
2. 确认新镜像存在
3. `docker compose --profile migrate run --rm migrate` 执行 `pnpm db:migrate:deploy`(**不在 api 启动时自动迁移**)
4. 按 **worker → api → web** 重启
5. 健康检查失败则自动把应用镜像滚回上一 tag

排障保留现场:`NO_ROLLBACK=1 JUNE_IMAGE_TAG=v0.1.1 ./deploy/scripts/deploy.sh`

## 3. 迁移策略

Prisma 没有可靠的自动 down。因此:

1. 破坏性变更拆两次发布:先加列(默认值)/加表/加索引并部署读新列的代码;确认无旧代码后再发删除旧列的迁移。
2. 自动回滚**只回镜像,不回 schema**。见 `deploy/scripts/rollback.sh` 头部注释。
3. 必须回数据时走备份,见 `docs/BACKUP.md`,RPO = 备份点之后的数据丢失。

手工回镜像:

```bash
./deploy/scripts/rollback.sh --list
./deploy/scripts/rollback.sh --previous
./deploy/scripts/rollback.sh v0.1.0
```

## 4. Nginx 要点

配置:`deploy/nginx/conf.d/june.conf`。

- 80 → 443;ACME 在跳转前
- `/api/events/`:`proxy_buffering off`、`gzip off`、读超时 3600s(SSE 2 秒配置同步依赖这项)
- 上传 `client_max_body_size 25m`(与 `UPLOAD_MAX_BYTES` 对齐)

改域名:改 `.env` 的 `PUBLIC_WEB_ORIGIN`,不必改 `server_name _`。

## 5. 维护窗口检查单

发布前:

- [ ] 通知用户维护窗口
- [ ] `./deploy/scripts/backup-db.sh --tag predeploy`
- [ ] 迁移是向后兼容的
- [ ] 镜像 tag 已 load 到生产机

发布中:

- [ ] `JUNE_IMAGE_TAG=... ./deploy/scripts/deploy.sh`
- [ ] `/api/health/ready` 200
- [ ] 登录站点 + `/admin/login`
- [ ] SSE:改一条公开配置,工作台 2 秒内刷新模型列表

发布后:

- [ ] `docker compose logs --tail=100 api worker`
- [ ] 抽样生图/发帖
- [ ] 失败则 `./deploy/scripts/rollback.sh --previous` 并评估是否需要 `restore-db.sh`
