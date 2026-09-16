#!/usr/bin/env bash
# ============================================================================
# 首次部署
# ----------------------------------------------------------------------------
# 做什么(每一步都可重复执行,失败后修好再跑一遍即可):
#   1. 检查 docker / compose 版本与磁盘空间
#   2. 校验 .env 必填项(含"是否还是模板占位值")
#   3. 检查 TLS 证书是否就位
#   4. 拉起 postgres + redis 并等待健康
#   5. 创建 pg_stat_statements 扩展(慢查询定位的前提)
#   6. 执行数据库迁移(一次性 migrate job)
#   7. 初始化管理员账号
#   8. 拉起 api / worker / web / nginx 并做健康检查
#
# 用法:
#   ./deploy/scripts/bootstrap.sh
#   JUNE_IMAGE_TAG=v1.0.0 ./deploy/scripts/bootstrap.sh
#   SKIP_ADMIN_INIT=1 ./deploy/scripts/bootstrap.sh    # 跳过管理员初始化
# ============================================================================
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

export JUNE_IMAGE_TAG="${JUNE_IMAGE_TAG:-$(read_current_tag)}"
export JUNE_IMAGE_PREFIX="${JUNE_IMAGE_PREFIX:-june}"

# ---------------------------------------------------------------------------
step "1/8 环境检查"
# ---------------------------------------------------------------------------
require_cmd docker awk sed grep

docker compose version >/dev/null 2>&1 || die "需要 Docker Compose v2(docker compose ...),v1 的 docker-compose 不支持 profiles 与 depends_on.condition"

docker_ver="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 0)"
compose_ver="$(docker compose version --short 2>/dev/null || echo 0)"
log "Docker Server:$docker_ver"
log "Compose      :$compose_ver"

ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]; }
ver_ge "$docker_ver" "24.0" || warn "建议 Docker ≥ 24.0(当前 $docker_ver)。Dockerfile 用了 COPY --parents,需要 BuildKit;生产机只拉镜像的话可以忽略。"
ver_ge "$compose_ver" "2.20" || die "需要 Compose ≥ 2.20(当前 $compose_ver):低版本对 deploy.resources.limits 与 profiles 支持不完整"

# 磁盘:100GB 盘,pgdata + 备份 + 镜像 + 日志都在上面
avail_kb="$(df -Pk "$REPO_ROOT" | awk 'NR==2{print $4}')"
avail_gb=$((avail_kb / 1024 / 1024))
log "可用磁盘:${avail_gb}GB"
[ "$avail_gb" -ge 20 ] || die "可用磁盘不足 20GB(当前 ${avail_gb}GB),不要在这种状态下初始化数据库"
[ "$avail_gb" -ge 40 ] || warn "可用磁盘 ${avail_gb}GB 偏少:备份 + 镜像 + WAL 建议至少留 40GB"

# 内存
if [ -r /proc/meminfo ]; then
  mem_gb="$(awk '/MemTotal/{printf "%.1f", $2/1024/1024}' /proc/meminfo)"
  log "物理内存:${mem_gb}GB"
  if awk -v m="$mem_gb" 'BEGIN{exit !(m < 7.0)}'; then
    warn "内存少于 7GB:docker-compose.yml 的资源限制总和约 7.1G,请按 docs/DEPLOYMENT.md 下调各服务 limits"
  fi
fi

ok "环境检查通过"

# ---------------------------------------------------------------------------
step "2/8 校验 .env"
# ---------------------------------------------------------------------------
require_file "$ENV_FILE"

# 必填且不能是占位值。变量名与 .env.example 完全一致。
for key in \
  PUBLIC_WEB_ORIGIN PUBLIC_API_ORIGIN CORS_ALLOWED_ORIGINS \
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB \
  REDIS_PASSWORD \
  SESSION_SECRET CSRF_SECRET \
  CREDENTIAL_ENCRYPTION_KEY PROVIDER_SECRET_ENCRYPTION_KEY \
  S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
do
  require_env_value "$key" >/dev/null
  ok "$key 已配置"
done

# NODE_ENV 必须是 production:apps/api/src/config/env.ts 的 superRefine 只在
# production 下强制 HTTPS、拒绝示例密钥、要求 CORS 白名单非空。
node_env="$(env_value NODE_ENV)"
[ "$node_env" = "production" ] || die "NODE_ENV 必须为 production(当前:${node_env:-空})。否则 API 不会启用生产环境的强制校验"

# API 会拒绝非 https 的 PUBLIC_WEB_ORIGIN(生产环境)
web_origin="$(env_value PUBLIC_WEB_ORIGIN)"
case "$web_origin" in
  https://*) ok "PUBLIC_WEB_ORIGIN 使用 HTTPS" ;;
  *) die "生产环境 PUBLIC_WEB_ORIGIN 必须是 https://(当前:$web_origin),API 启动时会直接失败" ;;
esac

# 32 字节 base64 密钥的长度校验(base64 编码后 44 字符,含一个 = 填充)
for key in CREDENTIAL_ENCRYPTION_KEY PROVIDER_SECRET_ENCRYPTION_KEY; do
  v="$(env_value "$key")"
  decoded_len="$(printf '%s' "$v" | base64 -d 2>/dev/null | wc -c | tr -d ' ')"
  [ "$decoded_len" = "32" ] || die "$key 必须是 base64 编码的 32 字节(当前解码后 ${decoded_len} 字节)。生成:openssl rand -base64 32"
  ok "$key 长度正确"
done

for key in SESSION_SECRET CSRF_SECRET; do
  v="$(env_value "$key")"
  [ "${#v}" -ge 32 ] || die "$key 至少 32 个字符(当前 ${#v})。生成:openssl rand -base64 48"
done

# 连接数预算:API 池 + Worker 池 必须明显小于 postgres 的 max_connections=100
api_pool="$(env_value API_DB_POOL_MAX)"; api_pool="${api_pool:-20}"
worker_pool="$(env_value WORKER_DB_POOL_MAX)"; worker_pool="${worker_pool:-10}"
total_pool=$((api_pool + worker_pool))
log "数据库连接预算:API $api_pool + Worker $worker_pool = $total_pool / max_connections 100"
[ "$total_pool" -le 70 ] || die "连接池总和 $total_pool 过大:要给迁移作业、备份与人工 psql 留余量(建议 ≤ 70)"

# 密码里的特殊字符会破坏 compose 里拼出来的 DATABASE_URL
pg_pass="$(env_value POSTGRES_PASSWORD)"
if printf '%s' "$pg_pass" | grep -Eq '[^A-Za-z0-9._~-]'; then
  warn "POSTGRES_PASSWORD 含 URL 保留字符:docker-compose.yml 会用它拼 DATABASE_URL,"
  warn "请改用仅含 A-Za-z0-9 与 -._~ 的密码,或自行做百分号编码,否则连接串会被截断"
fi

mock_enabled="$(env_value MOCK_PROVIDER_ENABLED)"
if [ "$mock_enabled" = "true" ]; then
  warn "MOCK_PROVIDER_ENABLED=true:模拟供应商只用于压测,正式环境请改回 false"
fi
allow_private="$(env_value PROVIDER_URL_ALLOW_PRIVATE_NETWORK)"
if [ "$allow_private" = "true" ]; then
  warn "PROVIDER_URL_ALLOW_PRIVATE_NETWORK=true:SSRF 防护已放开,压测后务必改回 false"
fi

ok ".env 校验通过"

# ---------------------------------------------------------------------------
step "3/8 TLS 证书"
# ---------------------------------------------------------------------------
cert_dir="${JUNE_TLS_CERT_DIR:-$REPO_ROOT/deploy/nginx/certs}"
if [ -f "$cert_dir/fullchain.pem" ] && [ -f "$cert_dir/privkey.pem" ]; then
  if command -v openssl >/dev/null 2>&1; then
    not_after="$(openssl x509 -in "$cert_dir/fullchain.pem" -noout -enddate | cut -d= -f2)"
    log "证书有效期至:$not_after"
    openssl x509 -in "$cert_dir/fullchain.pem" -noout -checkend 604800 >/dev/null \
      || warn "证书将在 7 天内过期,请先续期(certbot renew)"
  fi
  [ -f "$cert_dir/chain.pem" ] || warn "缺少 chain.pem:OCSP stapling 会被忽略(只影响握手优化,不影响可用性)"
  ok "证书就位:$cert_dir"
else
  die "缺少证书:$cert_dir/{fullchain.pem,privkey.pem}
  Let's Encrypt:见 docs/DEPLOYMENT.md「TLS 证书」
  内网自签    :./deploy/scripts/gen-selfsigned-cert.sh your-domain"
fi

# ---------------------------------------------------------------------------
step "4/8 拉起 postgres 与 redis"
# ---------------------------------------------------------------------------
compose up -d postgres redis

log "等待健康检查通过(最多 180 秒)..."
for i in $(seq 1 60); do
  pg_state="$(compose ps --format '{{.Name}} {{.Health}}' postgres | awk '{print $2}')"
  redis_state="$(compose ps --format '{{.Name}} {{.Health}}' redis | awk '{print $2}')"
  if [ "$pg_state" = "healthy" ] && [ "$redis_state" = "healthy" ]; then
    ok "postgres / redis 均健康"
    break
  fi
  [ "$i" = "60" ] && die "依赖服务未在 180 秒内就绪(postgres=$pg_state redis=$redis_state)。看日志:docker compose logs postgres redis"
  sleep 3
done

# ---------------------------------------------------------------------------
step "5/8 创建 pg_stat_statements 扩展"
# ---------------------------------------------------------------------------
# docker-compose.yml 已经用 shared_preload_libraries 预加载了模块,
# 但扩展本身必须在库里 CREATE 一次。docs/LOAD_TEST.md 的"看慢查询"流程依赖它。
echo "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;" | pg_sql >/dev/null
ext_ok="$(echo "SELECT count(*) FROM pg_extension WHERE extname='pg_stat_statements';" | pg_sql)"
[ "$ext_ok" = "1" ] || die "pg_stat_statements 创建失败:确认 postgres 启动参数里有 shared_preload_libraries=pg_stat_statements"
ok "pg_stat_statements 就绪"

# ---------------------------------------------------------------------------
step "6/8 数据库迁移"
# ---------------------------------------------------------------------------
log "当前迁移状态:"
compose --profile migrate run --rm migrate pnpm --filter @june/db migrate:status || true

log "执行 migrate deploy(只应用已生成的迁移文件,不会自动改 schema)"
compose --profile migrate run --rm migrate pnpm db:migrate:deploy \
  || die "迁移失败。常见原因:
  1. packages/db/prisma/migrations/ 为空 —— 迁移文件必须在开发机用
     \`pnpm db:migrate\` 生成并提交,生产环境只跑 deploy;
  2. DATABASE_URL 指向的库不可达或权限不足;
  3. 存在与线上数据冲突的迁移(看上面的报错)。"
ok "迁移完成"

# ---------------------------------------------------------------------------
step "7/8 初始化管理员"
# ---------------------------------------------------------------------------
if [ "${SKIP_ADMIN_INIT:-0}" = "1" ]; then
  warn "SKIP_ADMIN_INIT=1,跳过"
else
  admin_email="$(env_value ADMIN_INIT_EMAIL)"
  admin_pass="$(env_value ADMIN_INIT_PASSWORD)"
  if [ -z "$admin_email" ] || [ -z "$admin_pass" ]; then
    warn "ADMIN_INIT_EMAIL / ADMIN_INIT_PASSWORD 未配置,跳过管理员初始化。"
    warn "稍后手动执行:docker compose --profile migrate run --rm migrate pnpm admin:init"
  else
    compose --profile migrate run --rm migrate pnpm admin:init \
      || die "管理员初始化失败(若提示已存在属于正常,可用 SKIP_ADMIN_INIT=1 跳过)"
    ok "管理员已初始化:$admin_email"
    warn "安全提醒:登录后立刻修改密码,并把 .env 里的 ADMIN_INIT_PASSWORD 清空"
  fi
fi

# ---------------------------------------------------------------------------
step "8/8 拉起应用与入口"
# ---------------------------------------------------------------------------
compose up -d api worker web nginx

log "等待 api 就绪(/api/health/ready,最多 120 秒)..."
for i in $(seq 1 40); do
  state="$(compose ps --format '{{.Health}}' api | head -n 1)"
  if [ "$state" = "healthy" ]; then
    ok "api 就绪"
    break
  fi
  [ "$i" = "40" ] && die "api 未在 120 秒内就绪。排查:docker compose logs --tail=200 api"
  sleep 3
done

record_tag "$JUNE_IMAGE_TAG"

step "首次部署完成"
cat <<EOF

站点:      $web_origin
入口探活:  curl -fsS ${web_origin}/healthz
就绪检查:  curl -fsS ${web_origin}/api/health/ready

建议立刻做这三件事:
  1. 安装定时任务(每日备份 / 每周恢复演练 / 每 5 分钟健康检查):
       ./deploy/scripts/install-cron.sh
  2. 手动跑一次备份并验证可恢复(这是"至少验证一次恢复"的落地动作):
       ./deploy/scripts/backup-db.sh && ./deploy/scripts/verify-backup.sh
  3. 按 docs/DEPLOYMENT.md「对象存储与 CORS」配置桶策略、CORS 与版本控制。

注意:本平台是**单机部署,不具备多机高可用**。发布、迁移、恢复都需要
维护窗口,请按 docs/DEPLOYMENT.md「维护窗口」提前通知用户。
EOF
