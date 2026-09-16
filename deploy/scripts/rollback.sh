#!/usr/bin/env bash
# ============================================================================
# 回滚到指定镜像 tag
# ----------------------------------------------------------------------------
# ⚠⚠ 本脚本只回滚**应用镜像**,绝不自动回滚数据库 schema。原因:
#   1. `prisma migrate` 没有"自动反向迁移";Prisma 官方的做法是写一个新的
#      前向迁移来撤销改动,而不是执行 down 脚本。
#   2. 自动 down 极易丢数据:删列/删表是不可逆的,而回滚往往发生在慌乱的
#      故障处理中,最不该做不可逆操作。
#   3. 数据库比代码"活得更久":旧代码大多能在新 schema 上跑
#      (前提是迁移向后兼容),反过来不成立。
#
#   → 因此发布纪律是:**迁移必须向后兼容**(加列给默认值 / 新表 / 加索引),
#     破坏性变更拆成两次发布(先发新代码不再用旧列 → 下个版本再删列)。
#     详见 docs/DEPLOYMENT.md「迁移策略」。
#
#   需要真正回退 schema 时的人工步骤(务必在维护窗口内):
#     1. 停 api/worker/web:docker compose stop api worker web
#     2. 确认最近一次备份可用:./deploy/scripts/verify-backup.sh
#     3. 从备份恢复:./deploy/scripts/restore-db.sh <备份文件>
#        (恢复会把数据回到备份时刻 —— 之后产生的业务数据会丢,
#         必须先评估 RPO 影响,见 docs/BACKUP_RECOVERY.md)
#     4. 用旧 tag 启动:./deploy/scripts/rollback.sh <旧 tag>
#     5. 在 docs/BACKUP_RECOVERY.md 的演练/事故记录表里登记本次操作
#
# 用法:
#   ./deploy/scripts/rollback.sh --list            # 列出本地可回滚的 tag
#   ./deploy/scripts/rollback.sh v1.1.0            # 回滚到指定 tag
#   ./deploy/scripts/rollback.sh --previous        # 回滚到上一个成功发布的 tag
# ============================================================================
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

export JUNE_IMAGE_PREFIX="${JUNE_IMAGE_PREFIX:-june}"
require_cmd docker

list_tags() {
  step "本地可用的 api 镜像 tag(按创建时间倒序)"
  docker image ls "${JUNE_IMAGE_PREFIX}/api" \
    --format '  {{.Tag}}\t{{.CreatedSince}}\t{{.Size}}' | sed 's/\t/  /g'
  echo
  log "当前运行 tag :$(read_current_tag)"
  log "上一个成功 tag:$(read_previous_tag)"
}

TARGET="${1:-}"
case "$TARGET" in
  ""|-h|--help) sed -n '1,45p' "$0"; echo; list_tags; exit 0 ;;
  --list) list_tags; exit 0 ;;
  --previous)
    TARGET="$(read_previous_tag)"
    [ -n "$TARGET" ] || die "没有记录上一个 tag(deploy/.state/previous-image-tag 为空),请显式指定"
    ;;
esac

CURRENT="$(read_current_tag)"
[ "$TARGET" != "$CURRENT" ] || die "目标 tag 与当前运行的 tag 相同($TARGET),无需回滚"

# ---- 确认镜像在本地(回滚时不指望能拉到镜像:仓库可能正好不可用)----
for svc in api worker web migrate; do
  image="${JUNE_IMAGE_PREFIX}/${svc}:${TARGET}"
  docker image inspect "$image" >/dev/null 2>&1 \
    || docker pull "$image" >/dev/null 2>&1 \
    || die "本地与远端都找不到 $image。可回滚的 tag:$(docker image ls "${JUNE_IMAGE_PREFIX}/api" --format '{{.Tag}}' | tr '\n' ' ')"
done
ok "镜像齐备:$TARGET"

step "回滚概要"
cat <<EOF
  当前 tag  : $CURRENT
  回滚到    : $TARGET
  影响       : worker / api / web 会依次重启,发布期间接口短暂中断
  不会做     : 不动 postgres / redis 容器,不回滚数据库 schema
EOF
maybe_confirm_word "ROLLBACK" "确认执行回滚?"

export JUNE_IMAGE_TAG="$TARGET"

step "重启服务"
for svc in worker api web; do
  log "切换 $svc → $TARGET"
  compose up -d --no-deps "$svc"
done

compose exec -T nginx nginx -s reload >/dev/null 2>&1 || warn "nginx reload 未成功(不影响上游解析)"

step "健康检查"
failed=0
for svc in api worker web; do
  state=""
  for _ in $(seq 1 40); do
    state="$(compose ps --format '{{.Health}}' "$svc" 2>/dev/null | head -n 1)"
    [ "$state" = "healthy" ] && break
    sleep 3
  done
  if [ "$state" = "healthy" ]; then
    ok "$svc 健康"
  else
    err "$svc 回滚后仍不健康(state=$state)"
    failed=1
  fi
done

if [ "$failed" = "1" ]; then
  err "回滚未能恢复健康 —— 这通常意味着故障不在应用镜像,而在数据层或外部依赖"
  err "下一步:docker compose logs --tail=300 api worker;检查 postgres/redis;必要时按文件头部的人工步骤恢复数据库"
  exit 1
fi

record_tag "$TARGET"
ok "回滚完成:$CURRENT → $TARGET"
warn "别忘了:如果本次发布带了数据库迁移,schema 仍是新的。"
warn "确认旧代码在新 schema 上工作正常;不正常就按文件头部的人工步骤处理。"
