#!/usr/bin/env bash
# ============================================================================
# 日常发布
# ----------------------------------------------------------------------------
# 顺序(单机部署,发布期会有短暂不可用 —— 需要维护窗口):
#   0. 发布前自动备份数据库(默认开启,可 SKIP_BACKUP=1 跳过)
#   1. 拉取/确认新镜像存在
#   2. 跑一次性 migrate job(**不在 api 启动时自动迁移**)
#   3. 按 worker → api → web 顺序重启
#   4. 健康检查(容器 health + /api/health/ready + 入口 /healthz)
#   5. 任一步失败:自动回滚到上一个成功的镜像 tag
#
# 为什么是 worker → api → web:
#   worker 先起来,保证新代码入队的任务有对应版本的消费者;
#   api 其次;web 最后(前端引用的 API 契约向后兼容更容易保证)。
#
# ⚠ 关于数据库回滚:本脚本的自动回滚**只回滚镜像,不回滚数据库 schema**。
#   原因见 rollback.sh 的说明。因此迁移必须是"向后兼容"的(见
#   docs/DEPLOYMENT.md「迁移策略」:先加列 → 发布 → 再清理)。
#
# 用法:
#   JUNE_IMAGE_TAG=v1.2.0 ./deploy/scripts/deploy.sh
#   JUNE_IMAGE_TAG=v1.2.0 SKIP_BACKUP=1 ./deploy/scripts/deploy.sh
#   JUNE_IMAGE_TAG=v1.2.0 NO_ROLLBACK=1 ./deploy/scripts/deploy.sh   # 排障时保留现场
# ============================================================================
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

NEW_TAG="${JUNE_IMAGE_TAG:-}"
[ -n "$NEW_TAG" ] || die "必须指定镜像 tag:JUNE_IMAGE_TAG=<tag> $0"
export JUNE_IMAGE_TAG="$NEW_TAG"
export JUNE_IMAGE_PREFIX="${JUNE_IMAGE_PREFIX:-$(env_value JUNE_IMAGE_PREFIX)}"
export JUNE_IMAGE_PREFIX="${JUNE_IMAGE_PREFIX:-june}"

PREV_TAG="$(read_current_tag)"
require_file "$ENV_FILE"
require_cmd docker

log "当前运行 tag:$PREV_TAG"
log "本次发布 tag:$NEW_TAG"
[ "$PREV_TAG" = "$NEW_TAG" ] && warn "新旧 tag 相同,本次发布等价于重启"

ROLLED_BACK=0

rollback_to_prev() {
  local reason="$1"
  err "发布失败:$reason"
  if [ "${NO_ROLLBACK:-0}" = "1" ]; then
    warn "NO_ROLLBACK=1,保留当前现场以便排查。手动回滚:JUNE_IMAGE_TAG=$PREV_TAG ./deploy/scripts/deploy.sh"
    return 0
  fi
  if [ "$PREV_TAG" = "$NEW_TAG" ]; then
    warn "新旧 tag 相同,无法自动回滚镜像。请用 rollback.sh 指定一个已知可用的 tag"
    return 0
  fi
  step "自动回滚到 $PREV_TAG"
  ROLLED_BACK=1
  if JUNE_IMAGE_TAG="$PREV_TAG" compose up -d --no-deps worker api web; then
    sleep 5
    if wait_healthy api 40; then
      ok "已回滚到 $PREV_TAG 并恢复健康"
    else
      err "回滚后 api 仍不健康!这是需要人工介入的严重故障"
      err "排查:docker compose logs --tail=300 api;必要时 ./deploy/scripts/rollback.sh --list"
    fi
  else
    err "回滚命令本身失败,立即人工介入"
  fi
}

# 统一的失败出口:任何未捕获的失败都走回滚
on_error() {
  local code=$?
  trap - ERR EXIT
  rollback_to_prev "脚本在第 ${BASH_LINENO[0]} 行以状态 $code 退出"
  exit "$code"
}
trap on_error ERR

wait_healthy() {
  local svc="$1" tries="${2:-40}" state
  for i in $(seq 1 "$tries"); do
    state="$(compose ps --format '{{.Health}}' "$svc" 2>/dev/null | head -n 1)"
    [ "$state" = "healthy" ] && return 0
    # 没有配置 healthcheck 的服务返回空,退化为"容器在运行即可"
    if [ -z "$state" ]; then
      [ "$(compose ps --format '{{.State}}' "$svc" | head -n 1)" = "running" ] && return 0
    fi
    sleep 3
  done
  return 1
}

# ---------------------------------------------------------------------------
step "0/5 发布前备份"
# ---------------------------------------------------------------------------
if [ "${SKIP_BACKUP:-0}" = "1" ]; then
  warn "SKIP_BACKUP=1,跳过发布前备份(仅当刚刚备份过才这么做)"
else
  # 备份失败不应该静默继续:有迁移的发布没有备份 = 出事无法回头
  "$SCRIPT_DIR/backup-db.sh" --tag "predeploy-$NEW_TAG" \
    || die "发布前备份失败,已中止发布(没有备份不做带迁移的发布)"
  ok "发布前备份完成"
fi

# ---------------------------------------------------------------------------
step "1/5 准备镜像"
# ---------------------------------------------------------------------------
for svc in api worker web migrate; do
  image="${JUNE_IMAGE_PREFIX}/${svc}:${NEW_TAG}"
  if docker image inspect "$image" >/dev/null 2>&1; then
    ok "本地已有 $image"
  else
    log "本地没有 $image,尝试 docker pull"
    docker pull "$image" || die "拉取 $image 失败。
  有镜像仓库:检查 JUNE_IMAGE_PREFIX 与 docker login;
  没有仓库  :在开发机执行 build-images.sh --save,把 tar 拷来后 docker load。"
  fi
done

# ---------------------------------------------------------------------------
step "2/5 数据库迁移(一次性 job)"
# ---------------------------------------------------------------------------
compose --profile migrate run --rm migrate pnpm --filter @june/db migrate:status || true
compose --profile migrate run --rm migrate pnpm db:migrate:deploy \
  || die "迁移失败,已中止发布(容器未替换,线上仍是 $PREV_TAG)"
ok "迁移完成"

# ---------------------------------------------------------------------------
step "3/5 重启服务(worker → api → web)"
# ---------------------------------------------------------------------------
if [ -n "${JUNE_DEPLOY_STARTED_FILE:-}" ]; then
  touch "$JUNE_DEPLOY_STARTED_FILE"
fi
# --no-deps:不因为依赖关系顺带重建 postgres/redis(有状态服务不参与发布)
for svc in worker api web; do
  log "更新 $svc"
  compose up -d --no-deps "$svc"
done

# Git checkout 会替换 bind mount 的文件 inode;重建入口确保读到新配置。
compose up -d --no-deps --force-recreate nginx

# ---------------------------------------------------------------------------
step "4/5 健康检查"
# ---------------------------------------------------------------------------
for svc in api worker web nginx; do
  if wait_healthy "$svc" 40; then
    ok "$svc 健康"
  else
    rollback_to_prev "$svc 未在 120 秒内变为 healthy"
    trap - ERR
    exit 1
  fi
done

# 从容器网络内部打就绪接口:绕开 DNS 与证书问题,直接验证 api 本体
if compose exec -T api node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/api/health/ready').then(async r=>{const t=await r.text();if(!r.ok){console.error(t);process.exit(1)}console.log(t);}).catch(e=>{console.error(e.message);process.exit(1)})"; then
  ok "/api/health/ready 通过"
else
  rollback_to_prev "/api/health/ready 返回非 2xx"
  trap - ERR
  exit 1
fi

# 从入口验证整链路(TLS + 反代)
web_origin="$(env_value PUBLIC_WEB_ORIGIN)"
if command -v curl >/dev/null 2>&1; then
  # -k:自签证书环境也能自测;这里只关心链路是否通,不做证书校验
  if curl -fsS -k --max-time 10 "${web_origin%/}/healthz" >/dev/null; then
    ok "入口 /healthz 通过"
  else
    warn "入口 /healthz 不通:可能是 DNS/防火墙问题而非本次发布导致,请人工确认"
  fi
fi

# ---------------------------------------------------------------------------
step "5/5 记录发布结果"
# ---------------------------------------------------------------------------
trap - ERR
record_tag "$NEW_TAG"
ok "发布成功:$PREV_TAG → $NEW_TAG"
log "回滚命令(如稍后发现问题):./deploy/scripts/rollback.sh $PREV_TAG"

# 清理无引用的旧镜像,避免 100GB 磁盘被历史版本吃掉。
# 只清 dangling(无 tag)镜像,不动带 tag 的历史版本 —— 回滚要用。
docker image prune -f >/dev/null 2>&1 || true
log "提示:保留最近若干个 tag 以便回滚,更早的可用 docker image rm 手动清理"
