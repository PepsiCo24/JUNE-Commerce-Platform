# GitHub 推送后自动更新服务器

适用环境：单台 Linux x86_64（建议 Ubuntu 24.04）、Docker ≥ 24、Compose ≥ 2.20。
ARM 服务器需要先调整 `docker-bake.hcl` 的平台及构建 runner，不能直接使用当前 amd64 镜像。

## 发布流程

合并或推送到 `main` → 类型检查及测试 → 一次构建四个镜像并推送 GHCR → SSH 更新服务器源码到同一提交 → 备份数据库 → 执行迁移 → 更新 Worker/API/Web → 健康检查。

工作流：`.github/workflows/release.yml`。镜像标签是完整的 Git 提交号，避免使用会漂移的 `latest`。
PR 也检查并构建，但不推镜像、不连接生产服务器。手动运行工作流时选择 `main`。
GitHub 的运行并发锁和服务器的 `flock` 防止重叠发布；排队的过时提交会跳过，不会把服务器降回旧版本。

**完成下面的一次性接入后，后续推送 `main` 才会自动更新服务器。**
仓库默认未设置 `DEPLOY_ENABLED=true`，因此没有服务器时只做检查和镜像发布。
自动部署不等于零停机：当前是单机 Compose，更新期间可能短暂不可用。

## 1. 首次准备服务器

安装 Docker、Compose、Git、curl、util-linux（包含 flock），以及备份脚本所需的 AWS CLI 或 MinIO mc。
部署用户需能使用 Docker、读写项目目录，并以该用户执行以下操作。服务器须能访问 GitHub、GHCR 和所用对象存储。

```bash
git clone https://github.com/PepsiCo24/JUNE-Commerce-Platform.git /opt/june
cd /opt/june
cp .env.example .env
chmod 600 .env
```

按照 [生产部署说明](DEPLOYMENT.md) 填写生产 `.env`、域名、HTTPS 证书、对象存储、数据库密码和加密密钥。
设置 `NODE_ENV=production`、`MOCK_PROVIDER_ENABLED=false`，并在管理端配置真实供应商。
设置备份桶及其访问权限，见 [备份说明](BACKUP.md)。`.env`、证书、备份和发布状态不会同步到 GitHub。
不要在服务器修改受 Git 跟踪的代码或 Nginx 配置；应在仓库提交后发布。本地修改会阻止自动更新。

等待 GitHub Actions 中 `images` 作业成功，从该次运行获取完整 40 位提交号，将以下两项写入服务器 `.env`：

```dotenv
JUNE_IMAGE_PREFIX=ghcr.io/pepsico24/june-commerce-platform
JUNE_IMAGE_TAG=替换为已成功构建的完整提交号
```

GHCR 的包首次创建可能为私有。可以把四个包设为公开，或者在服务器上用具有 `read:packages` 权限的 GitHub classic PAT 登录（不要把 PAT 放在命令行、代码或聊天中）：

```bash
docker login ghcr.io -u PepsiCo24
# 在交互提示处输入 PAT；此操作必须由执行部署的同一用户完成。
docker compose --profile migrate pull api worker web migrate
bash deploy/scripts/bootstrap.sh
bash deploy/scripts/healthcheck.sh
bash deploy/scripts/backup-db.sh --tag initial-check
```

在第一次 bootstrap 前，确保服务器 checkout 对应上述镜像提交。
管理员初始化、真实证书和备份均成功后再启用自动部署。
私有仓库还需要服务器的只读 Git deploy key；当前公开仓库用 HTTPS 拉取即可。

## 2. 配置 GitHub Actions

打开 [仓库 Actions 配置](https://github.com/PepsiCo24/JUNE-Commerce-Platform/settings/secrets/actions)。
在 **Variables（仓库级变量）** 添加：

| 名称                     | 内容                                                                             |
| ------------------------ | -------------------------------------------------------------------------------- |
| `DEPLOY_HOST`            | 服务器公网 IPv4 或域名，不带协议                                                 |
| `DEPLOY_USER`            | 上述部署用户                                                                     |
| `DEPLOY_PORT`            | SSH 端口，默认 `22`                                                              |
| `DEPLOY_PATH`            | 服务器仓库绝对路径，例如 `/opt/june`，不含空格                                   |
| `NEXT_PUBLIC_ASSET_HOST` | 可选：图片公共访问完整地址，如 `https://assets.your-domain.cn`；修改后要重新构建 |
| `DEPLOY_ENABLED`         | 首次部署验证完成后设置为 `true`；停止自动发布时改为 `false`                      |

在 **Secrets** 添加：

| 名称                 | 内容                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `DEPLOY_SSH_KEY`     | 专用 SSH 私钥；对应公钥加入部署用户 `~/.ssh/authorized_keys`              |
| `DEPLOY_KNOWN_HOSTS` | 已核对指纹的服务器 SSH host key 条目；非 22 端口需使用 `[主机]:端口` 格式 |

在可信终端执行 `ssh-keyscan -p 22 服务器域名` 可获取候选 host key；通过服务器控制台核对其指纹后填入 Secret。
工作流使用 `StrictHostKeyChecking=yes`，不会在部署时自动信任扫描到的主机。
无需添加 `GITHUB_TOKEN`：GitHub 自动提供，工作流仅在构建作业授予 `packages: write`。

在 Settings → Environments 创建 `production`，部署分支限制为 `main`。如需完全自动发布，不配置 required reviewers；若配置了审批人，每次发布会等待审批。
仓库 Actions 必须启用，并允许所用的 GitHub/Docker/pnpm 官方 Actions。

## 3. 验证自动更新

1. 在 [Actions](https://github.com/PepsiCo24/JUNE-Commerce-Platform/actions/workflows/release.yml) 手动运行工作流（选择 `main`），或推送一个提交。
2. 确认 `check`、`images`、`deploy` 都成功；`deploy` 被跳过通常表示尚未启用或不是 main。
3. 服务器执行 `git rev-parse HEAD`，应等于本次提交号；`cat deploy/.state/current-image-tag` 应与之相同。
4. 执行 `docker compose ps`，确认服务健康；访问 `/admin/login` 和 `/api/health/ready`。

成功发布会同步 `.env` 的镜像标签，因此服务器重启、手动 `docker compose up -d` 会继续使用最新成功版本。
初次上线和真实 SSH/网络/权限只能在服务器配置完成后验证，不能仅凭仓库工作流文件保证已经连通。

## 失败处理与回滚

- 检查或镜像构建失败：不会触碰服务器。
- 备份或迁移失败：停止发布，不替换应用容器。
- 容器更新或健康检查失败：自动部署入口先恢复此前源码 checkout，再用旧版 Compose 配置和镜像标签重建应用及 Nginx，并等待健康检查。回滚失败会在 Actions 和服务器日志中报错，需人工处理。
- 数据库 schema 不会自动回滚，新增迁移必须保持旧代码兼容。本次手机号/微信号迁移保留旧 `website` 列，避免旧版本回滚后缺列。
- 日志位于 GitHub Actions 和服务器 `deploy/logs/`。部署中不要取消运行；连接断开或机器宕机等情况需核对实际服务状态。

紧急停止后续自动发布：将 `DEPLOY_ENABLED` 改为 `false`。
手工回滚镜像：`bash deploy/scripts/rollback.sh --previous`。若同时需要恢复源码，先记录目标提交，再 checkout 对应提交，且不要覆盖 `.env` 或删除数据卷。

参考：[GitHub 发布 Docker 镜像](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)、[GHCR 认证与包权限](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。
