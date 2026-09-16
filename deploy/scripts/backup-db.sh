#!/usr/bin/env bash
# ============================================================================
# 数据库备份:pg_dump 自定义格式 → 完整性试读 → gzip → 上传独立存储 → 清理过期
# ----------------------------------------------------------------------------
# 设计要点:
#  1. 用 `pg_dump -Fc`(自定义格式):支持并行恢复与"只恢复某张表",
#     比 SQL 文本格式灵活得多,也是 pg_restore 的输入格式。
#     这里加 `-Z 0` 关掉 pg_dump 自带的压缩,再统一用 gzip -9 —— 避免
#     "压缩两遍"既费 CPU 又几乎不减体积(按需求要求保留 gzip 环节)。
#  2. **每次备份都验证可读性**:gzip 前用 `pg_restore --list` 试读目录,
#     读不出目录说明这份备份根本没法恢复,当场失败而不是留个坏文件。
#  3. 备份必须离开本机:本地磁盘和数据库在同一块盘上,盘坏了两者一起没。
#     上传到 S3 兼容存储(优先 aws cli,其次 mc),**且应该与图片资产
#     使用不同的桶/账号**(BACKUP_S3_BUCKET),避免一次误删全军覆没。
#  4. 失败一定要"响":非零退出 + 写日志 + 可选告警命令(JUNE_ALERT_COMMAND)。
#     cron 静默失败是备份体系最常见的死法。
#
# 用法:
#   ./deploy/scripts/backup-db.sh
#   ./deploy/scripts/backup-db.sh --tag predeploy-v1.2.0
#   ./deploy/scripts/backup-db.sh --local-only          # 不上传(临时/离线环境)
#
# 读取的 .env 项:BACKUP_ENABLED / BACKUP_RETENTION_DAYS / BACKUP_S3_BUCKET /
#                 BACKUP_LOCAL_DIR / S3_ENDPOINT / S3_REGION /
#                 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
# ============================================================================
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

LABEL="auto"
LOCAL_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) LABEL="${2:?--tag 需要参数}"; shift 2 ;;
    --local-only) LOCAL_ONLY=1; shift ;;
    -h|--help) sed -n '1,30p' "$0"; exit 0 ;;
    *) die "未知参数:$1" ;;
  esac
done

require_cmd docker gzip awk
require_file "$ENV_FILE"

BACKUP_DIR="$(env_value BACKUP_LOCAL_DIR)"; BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
RETENTION_DAYS="$(env_value BACKUP_RETENTION_DAYS)"; RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_BUCKET="$(env_value BACKUP_S3_BUCKET)"
PG_DB="$(env_value POSTGRES_DB)"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
BASENAME="june-${PG_DB}-${STAMP}-${LABEL}"
DUMP_PATH="$BACKUP_DIR/${BASENAME}.dump"
GZ_PATH="${DUMP_PATH}.gz"

mkdir -p "$BACKUP_DIR"
# 备份目录里是全站数据,权限必须收紧
chmod 700 "$BACKUP_DIR"

# 失败清理:不留半截文件冒充备份
cleanup_partial() {
  local code=$?
  if [ "$code" != "0" ]; then
    rm -f "$DUMP_PATH" "$GZ_PATH"
    err "备份失败(退出码 $code),已删除半成品文件"
  fi
}
trap cleanup_partial EXIT

# ---------------------------------------------------------------------------
step "1/6 前置检查"
# ---------------------------------------------------------------------------
if [ "$(env_value BACKUP_ENABLED)" != "true" ]; then
  warn "BACKUP_ENABLED 不是 true:仍然执行本次备份(手动触发优先),"
  warn "但请把 .env 的 BACKUP_ENABLED 改成 true,以明确表达「这套环境有备份」。"
fi

pg_state="$(compose ps --format '{{.Health}}' postgres 2>/dev/null | head -n 1)"
[ "$pg_state" = "healthy" ] || die "postgres 容器不健康(state=$pg_state),不在异常状态下取备份"

# 空间检查:至少要有数据库大小 2.5 倍的余量(dump + gz 同时存在)
db_size_bytes="$(echo "SELECT pg_database_size(current_database());" | pg_sql)"
avail_bytes=$(( $(df -Pk "$BACKUP_DIR" | awk 'NR==2{print $4}') * 1024 ))
need_bytes=$(( db_size_bytes * 5 / 2 ))
log "数据库大小:$(human_bytes "$db_size_bytes");备份盘可用:$(human_bytes "$avail_bytes")"
[ "$avail_bytes" -gt "$need_bytes" ] || die "备份目录空间不足:需要约 $(human_bytes "$need_bytes"),仅剩 $(human_bytes "$avail_bytes")"

# ---------------------------------------------------------------------------
step "2/6 pg_dump(自定义格式,不压缩)"
# ---------------------------------------------------------------------------
# 通过容器执行,宿主机不需要装 postgresql-client;密码只在容器内部环境变量里。
# --no-owner / --no-privileges:恢复到临时库或不同用户名的环境时不会因
#   角色不存在而报错(恢复演练必需)。
compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z 0 --no-owner --no-privileges' \
  >"$DUMP_PATH"

dump_size="$(wc -c <"$DUMP_PATH")"
[ "$dump_size" -gt 1024 ] || die "dump 文件异常小($(human_bytes "$dump_size")),判定为失败"
ok "dump 完成:$(human_bytes "$dump_size")"

# ---------------------------------------------------------------------------
step "3/6 完整性试读(pg_restore --list)"
# ---------------------------------------------------------------------------
# 把 dump 送回容器里用 pg_restore 解析目录。能列出条目才说明文件结构完好。
# 注意:这只验证"文件可解析",真正的"能恢复出可用数据库"由
# verify-backup.sh 的恢复演练验证(每周一次)。
entry_count="$(compose exec -T postgres sh -c 'cat > /tmp/verify.dump && pg_restore --list /tmp/verify.dump | grep -c "^[0-9]" ; rm -f /tmp/verify.dump' <"$DUMP_PATH" || true)"
entry_count="$(printf '%s' "$entry_count" | tr -dc '0-9')"
[ -n "$entry_count" ] && [ "$entry_count" -gt 10 ] \
  || die "pg_restore --list 只读出 ${entry_count:-0} 个条目,备份不可信"
ok "目录可读,共 $entry_count 个归档条目"

# ---------------------------------------------------------------------------
step "4/6 gzip 压缩 + 校验和"
# ---------------------------------------------------------------------------
gzip -9 "$DUMP_PATH"
[ -f "$GZ_PATH" ] || die "压缩后文件不存在:$GZ_PATH"
gzip -t "$GZ_PATH" || die "gzip 自检失败:$GZ_PATH"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$GZ_PATH" | awk '{print $1"  "$2}' >"${GZ_PATH}.sha256"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$GZ_PATH" >"${GZ_PATH}.sha256"
fi
chmod 600 "$GZ_PATH" "${GZ_PATH}.sha256" 2>/dev/null || true
gz_size="$(wc -c <"$GZ_PATH")"
ok "压缩完成:$(human_bytes "$gz_size")($GZ_PATH)"

# ---------------------------------------------------------------------------
step "5/6 上传到独立对象存储"
# ---------------------------------------------------------------------------
upload_done=0
if [ "$LOCAL_ONLY" = "1" ]; then
  warn "--local-only:跳过上传。⚠ 只有本地副本 = 磁盘坏了就没有备份"
elif [ -z "$BACKUP_BUCKET" ]; then
  warn "BACKUP_S3_BUCKET 未配置,跳过上传。"
  warn "⚠ 强烈建议配置一个**独立于 S3_BUCKET(图片桶)**的备份桶:"
  warn "  同桶存放意味着一次误删/一次凭据泄漏就同时失去数据和备份。"
else
  s3_endpoint="$(env_value S3_ENDPOINT)"
  s3_region="$(env_value S3_REGION)"
  key="db/${PG_DB}/$(date -u '+%Y/%m')/${BASENAME}.dump.gz"

  if command -v aws >/dev/null 2>&1; then
    log "使用 aws cli 上传到 s3://${BACKUP_BUCKET}/${key}"
    AWS_ACCESS_KEY_ID="$(env_value S3_ACCESS_KEY_ID)" \
    AWS_SECRET_ACCESS_KEY="$(env_value S3_SECRET_ACCESS_KEY)" \
    AWS_DEFAULT_REGION="$s3_region" \
    aws --endpoint-url "$s3_endpoint" s3 cp "$GZ_PATH" "s3://${BACKUP_BUCKET}/${key}" \
      && upload_done=1
    if [ -f "${GZ_PATH}.sha256" ]; then
      AWS_ACCESS_KEY_ID="$(env_value S3_ACCESS_KEY_ID)" \
      AWS_SECRET_ACCESS_KEY="$(env_value S3_SECRET_ACCESS_KEY)" \
      AWS_DEFAULT_REGION="$s3_region" \
      aws --endpoint-url "$s3_endpoint" s3 cp "${GZ_PATH}.sha256" "s3://${BACKUP_BUCKET}/${key}.sha256" || true
    fi
  elif command -v mc >/dev/null 2>&1; then
    log "使用 mc 上传到 june-backup/${BACKUP_BUCKET}/${key}"
    mc alias set june-backup "$s3_endpoint" "$(env_value S3_ACCESS_KEY_ID)" "$(env_value S3_SECRET_ACCESS_KEY)" >/dev/null
    mc cp "$GZ_PATH" "june-backup/${BACKUP_BUCKET}/${key}" && upload_done=1
    [ -f "${GZ_PATH}.sha256" ] && mc cp "${GZ_PATH}.sha256" "june-backup/${BACKUP_BUCKET}/${key}.sha256" || true
  else
    die "需要 aws cli 或 mc 才能上传备份。安装其中一个,或显式用 --local-only 承担只有本地副本的风险。"
  fi

  [ "$upload_done" = "1" ] || die "上传失败:备份没有离开本机,视为备份失败"
  ok "已上传:${BACKUP_BUCKET}/${key}"
fi

# ---------------------------------------------------------------------------
step "6/6 清理过期备份(保留 ${RETENTION_DAYS} 天)"
# ---------------------------------------------------------------------------
# 本地:按修改时间删。远端的生命周期**建议用桶的 lifecycle 规则**管理
# (见 docs/BACKUP_RECOVERY.md),比脚本删除更可靠:脚本不跑了规则还在。
deleted=0
while IFS= read -r old; do
  rm -f "$old" "${old}.sha256"
  deleted=$((deleted + 1))
  log "删除过期本地备份:$(basename "$old")"
done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'june-*.dump.gz' -type f -mtime "+${RETENTION_DAYS}" 2>/dev/null || true)
log "本地清理:$deleted 个文件"

remaining="$(find "$BACKUP_DIR" -maxdepth 1 -name 'june-*.dump.gz' -type f | wc -l | tr -d ' ')"
log "本地现存备份:$remaining 份"
[ "$remaining" -ge 1 ] || die "清理后本地一份备份都不剩,配置有问题(RETENTION_DAYS=$RETENTION_DAYS)"

trap - EXIT
step "备份成功"
cat <<EOF
  文件      : $GZ_PATH
  大小      : $(human_bytes "$gz_size")
  归档条目  : $entry_count
  远端      : $([ "$upload_done" = "1" ] && echo "${BACKUP_BUCKET}" || echo "未上传")
  保留期    : ${RETENTION_DAYS} 天

恢复演练(建议每周一次,install-cron.sh 已经安排):
  ./deploy/scripts/verify-backup.sh
EOF
