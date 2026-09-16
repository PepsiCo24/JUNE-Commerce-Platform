#!/usr/bin/env bash
# ============================================================================
# 恢复演练:把最新备份恢复到临时库,跑基本查询验证,输出报告后清理
# ----------------------------------------------------------------------------
# 这是"备份必须至少验证过一次恢复"的落地脚本 —— 而且不是只验证一次:
# install-cron.sh 会把它挂成每周一次的定时任务。
#
# 没有演练过的备份不能算备份。常见的翻车方式:
#   - dump 一直在跑,但里面是空库(连错了库/权限不足只导出了 schema);
#   - 归档能列目录,但恢复时因为扩展/角色缺失中途失败;
#   - 备份成功但迁移表不完整,恢复后应用起不来。
# 这些都只有真正恢复一次才能发现。
#
# 演练**不碰线上库**:全程在 june_verify_<时间戳> 临时库里进行,结束即删。
#
# 用法:
#   ./deploy/scripts/verify-backup.sh                  # 用本地最新备份
#   ./deploy/scripts/verify-backup.sh backups/x.dump.gz
#   ./deploy/scripts/verify-backup.sh --from-remote    # 先从对象存储下载最新一份再演练
#                                                      #(更接近真实灾难场景)
#   ./deploy/scripts/verify-backup.sh --keep           # 保留临时库供人工检查
# ============================================================================
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

require_cmd docker gzip awk
require_file "$ENV_FILE"

BACKUP_DIR="$(env_value BACKUP_LOCAL_DIR)"; BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
BACKUP_BUCKET="$(env_value BACKUP_S3_BUCKET)"
KEEP=0
FROM_REMOTE=0
FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --from-remote) FROM_REMOTE=1; shift ;;
    -h|--help) sed -n '1,26p' "$0"; exit 0 ;;
    *) FILE="$1"; shift ;;
  esac
done

VERIFY_DB="june_verify_$(date -u '+%Y%m%d%H%M%S')"
REPORT_DIR="$REPO_ROOT/deploy/logs/restore-drills"
mkdir -p "$REPORT_DIR"
REPORT="$REPORT_DIR/drill-$(date -u '+%Y%m%dT%H%M%SZ').md"
STARTED_EPOCH="$(date -u '+%s')"

cleanup() {
  local code=$?
  if [ "$KEEP" = "0" ]; then
    echo "DROP DATABASE IF EXISTS \"$VERIFY_DB\";" | pg_sql >/dev/null 2>&1 || true
  fi
  compose exec -T postgres sh -c 'rm -f /tmp/verify-drill.dump' >/dev/null 2>&1 || true
  [ -n "${TMP_DOWNLOAD:-}" ] && rm -f "$TMP_DOWNLOAD" || true
  if [ "$code" != "0" ]; then
    err "恢复演练失败(退出码 $code)。报告:$REPORT"
    {
      echo
      echo "## 结论"
      echo
      echo "**演练失败**(退出码 $code)。备份当前状态为「不可信」,必须立刻排查:"
      echo "重跑一次 backup-db.sh,若仍失败则检查数据库连接、权限与磁盘。"
    } >>"$REPORT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
step "1/5 选择备份文件"
# ---------------------------------------------------------------------------
if [ "$FROM_REMOTE" = "1" ]; then
  [ -n "$BACKUP_BUCKET" ] || die "--from-remote 需要配置 BACKUP_S3_BUCKET"
  s3_endpoint="$(env_value S3_ENDPOINT)"
  TMP_DOWNLOAD="$(mktemp "${TMPDIR:-/tmp}/june-remote-backup.XXXXXX.dump.gz")"
  if command -v aws >/dev/null 2>&1; then
    export AWS_ACCESS_KEY_ID="$(env_value S3_ACCESS_KEY_ID)"
    export AWS_SECRET_ACCESS_KEY="$(env_value S3_SECRET_ACCESS_KEY)"
    export AWS_DEFAULT_REGION="$(env_value S3_REGION)"
    latest_key="$(aws --endpoint-url "$s3_endpoint" s3 ls "s3://${BACKUP_BUCKET}/db/" --recursive \
      | grep '\.dump\.gz$' | sort | tail -n 1 | awk '{print $4}')"
    [ -n "$latest_key" ] || die "对象存储里没有找到备份"
    log "下载 s3://${BACKUP_BUCKET}/${latest_key}"
    aws --endpoint-url "$s3_endpoint" s3 cp "s3://${BACKUP_BUCKET}/${latest_key}" "$TMP_DOWNLOAD"
  elif command -v mc >/dev/null 2>&1; then
    mc alias set june-backup "$s3_endpoint" "$(env_value S3_ACCESS_KEY_ID)" "$(env_value S3_SECRET_ACCESS_KEY)" >/dev/null
    latest_key="$(mc ls --recursive "june-backup/${BACKUP_BUCKET}/db/" | grep '\.dump\.gz$' | sort | tail -n 1 | awk '{print $NF}')"
    [ -n "$latest_key" ] || die "对象存储里没有找到备份"
    log "下载 ${BACKUP_BUCKET}/db/${latest_key}"
    mc cp "june-backup/${BACKUP_BUCKET}/db/${latest_key}" "$TMP_DOWNLOAD"
  else
    die "--from-remote 需要 aws cli 或 mc"
  fi
  FILE="$TMP_DOWNLOAD"
elif [ -z "$FILE" ]; then
  FILE="$(find "$BACKUP_DIR" -maxdepth 1 -name 'june-*.dump.gz' -type f | sort | tail -n 1)"
  [ -n "$FILE" ] || die "$BACKUP_DIR 下没有备份文件,先跑 ./deploy/scripts/backup-db.sh"
fi
require_file "$FILE"

file_size="$(wc -c <"$FILE")"
file_mtime="$(date -u -r "$FILE" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || stat -c '%y' "$FILE" 2>/dev/null || echo unknown)"
log "备份文件:$FILE"
log "大小    :$(human_bytes "$file_size")"
log "生成时间:$file_mtime"

# 备份新鲜度:超过 48 小时说明每日备份没在跑
age_hours=$(( ( $(date -u '+%s') - $(date -u -r "$FILE" '+%s' 2>/dev/null || echo "$(date -u '+%s')") ) / 3600 ))
[ "$age_hours" -le 48 ] || warn "最新备份已经 ${age_hours} 小时了:每日备份可能没有执行(检查 crontab 与 deploy/logs/backup-db.log)"

# ---------------------------------------------------------------------------
step "2/5 校验并解析归档"
# ---------------------------------------------------------------------------
gzip -t "$FILE" || die "gzip 校验失败"
entry_count="$(gzip -dc "$FILE" | compose exec -T postgres sh -c 'cat > /tmp/verify-drill.dump && pg_restore --list /tmp/verify-drill.dump | grep -c "^[0-9]"')"
entry_count="$(printf '%s' "$entry_count" | tr -dc '0-9')"
[ "${entry_count:-0}" -gt 10 ] || die "归档条目只有 ${entry_count:-0} 个"
ok "归档条目:$entry_count"

# ---------------------------------------------------------------------------
step "3/5 恢复到临时库 $VERIFY_DB"
# ---------------------------------------------------------------------------
echo "CREATE DATABASE \"$VERIFY_DB\";" | pg_sql >/dev/null
restore_started="$(date -u '+%s')"
compose exec -T postgres sh -c \
  "PGPASSWORD=\"\$POSTGRES_PASSWORD\" pg_restore -U \"\$POSTGRES_USER\" -d \"$VERIFY_DB\" \
     --no-owner --no-privileges --exit-on-error -j 2 /tmp/verify-drill.dump" >/dev/null \
  || die "pg_restore 失败:这份备份**无法恢复**,不要依赖它"
restore_seconds=$(( $(date -u '+%s') - restore_started ))
ok "恢复完成,耗时 ${restore_seconds} 秒"

# ---------------------------------------------------------------------------
step "4/5 基本查询验证"
# ---------------------------------------------------------------------------
# 验证点:
#  a. 迁移表完整(应用启动会校验迁移状态);
#  b. 关键业务表存在且能查(不只是 schema 存在);
#  c. 角色种子数据在(没有角色,登录后的权限判定就是坏的);
#  d. 外键与唯一约束都在(恢复丢约束是很隐蔽的故障);
#  e. 抽样一条真实数据能读出来。
checks_failed=0

query() { printf '%s' "$1" | pg_sql "$VERIFY_DB"; }

migrations="$(query "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;")"
tables="$(query "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
indexes="$(query "SELECT count(*) FROM pg_indexes WHERE schemaname='public';")"
fks="$(query "SELECT count(*) FROM information_schema.table_constraints WHERE constraint_schema='public' AND constraint_type='FOREIGN KEY';")"
uniques="$(query "SELECT count(*) FROM information_schema.table_constraints WHERE constraint_schema='public' AND constraint_type='UNIQUE';")"
users="$(query "SELECT count(*) FROM users;")"
roles="$(query "SELECT count(*) FROM roles;")"
posts="$(query "SELECT count(*) FROM posts;")"
comments="$(query "SELECT count(*) FROM comments;")"
shops="$(query "SELECT count(*) FROM shops;")"
products="$(query "SELECT count(*) FROM products;")"
assets="$(query "SELECT count(*) FROM assets;")"
tasks="$(query "SELECT count(*) FROM generation_tasks;")"
admins="$(query "SELECT count(*) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE r.level >= 50;")"
newest_user="$(query "SELECT coalesce(max(created_at)::text,'(空表)') FROM users;")"

assert_ge() {
  local name="$1" value="$2" min="$3"
  if [ "${value:-0}" -ge "$min" ] 2>/dev/null; then
    ok "$name = $value(≥ $min)"
  else
    err "$name = ${value:-?},期望 ≥ $min"
    checks_failed=$((checks_failed + 1))
  fi
}

assert_ge "已完成迁移数" "$migrations" 1
assert_ge "public 表数量" "$tables" 20
assert_ge "索引数量" "$indexes" 30
assert_ge "外键约束数" "$fks" 15
assert_ge "唯一约束数" "$uniques" 5
assert_ge "角色种子" "$roles" 3
assert_ge "管理员账号数" "$admins" 1
log "users=$users posts=$posts comments=$comments shops=$shops products=$products assets=$assets tasks=$tasks"
log "最新用户创建时间:$newest_user"

# 抽样读一条完整关联数据(验证的是"数据可用",不是"表存在")
sample="$(query "SELECT coalesce((SELECT p.title || ' / by ' || u.email FROM posts p JOIN users u ON u.id=p.author_id ORDER BY p.created_at DESC LIMIT 1), '(没有帖子数据)');")"
log "抽样帖子:$sample"

# 只有"看起来是空库"才算失败:0 用户说明备份的是错的库
if [ "${users:-0}" -lt 1 ]; then
  err "users 表为 0 行:备份可能来自错误的数据库"
  checks_failed=$((checks_failed + 1))
fi

# ---------------------------------------------------------------------------
step "5/5 输出报告"
# ---------------------------------------------------------------------------
total_seconds=$(( $(date -u '+%s') - STARTED_EPOCH ))
{
  echo "# 恢复演练报告"
  echo
  echo "- 演练时间(UTC):$(date -u '+%Y-%m-%d %H:%M:%SZ')"
  echo "- 执行脚本:\`deploy/scripts/verify-backup.sh\`"
  echo "- 备份文件:\`$(basename "$FILE")\`"
  echo "- 备份来源:$([ "$FROM_REMOTE" = "1" ] && echo "对象存储 ${BACKUP_BUCKET}" || echo "本地 ${BACKUP_DIR}")"
  echo "- 备份大小:$(human_bytes "$file_size")"
  echo "- 备份生成时间:$file_mtime(距今 ${age_hours} 小时)"
  echo "- 临时库:\`$VERIFY_DB\`$([ "$KEEP" = "1" ] && echo "(已保留,请手动 DROP)" || echo "(已删除)")"
  echo
  echo "## 耗时(RTO 实测依据)"
  echo
  echo "| 阶段 | 秒 |"
  echo "|---|---|"
  echo "| pg_restore 恢复 | $restore_seconds |"
  echo "| 演练全流程 | $total_seconds |"
  echo
  echo "> 说明:这是恢复到**同机临时库**的耗时,不含发现故障、决策、"
  echo "> 下载远端备份与切换域名的时间。完整 RTO 见 docs/BACKUP_RECOVERY.md。"
  echo
  echo "## 校验结果"
  echo
  echo "| 检查项 | 值 |"
  echo "|---|---|"
  echo "| 归档条目 | $entry_count |"
  echo "| 已完成迁移 | $migrations |"
  echo "| public 表 | $tables |"
  echo "| 索引 | $indexes |"
  echo "| 外键约束 | $fks |"
  echo "| 唯一约束 | $uniques |"
  echo "| 角色 | $roles |"
  echo "| 管理员账号 | $admins |"
  echo "| 用户 | $users |"
  echo "| 帖子 / 评论 | $posts / $comments |"
  echo "| 店铺 / 商品 | $shops / $products |"
  echo "| 资产 / 生成任务 | $assets / $tasks |"
  echo "| 最新用户创建时间 | $newest_user |"
  echo "| 失败检查项 | $checks_failed |"
} >"$REPORT"

if [ "$checks_failed" -gt 0 ]; then
  {
    echo
    echo "## 结论"
    echo
    echo "**未通过**:有 $checks_failed 项检查失败,详见上面的表格与脚本输出。"
  } >>"$REPORT"
  die "恢复演练未通过($checks_failed 项失败)。报告:$REPORT"
fi

{
  echo
  echo "## 结论"
  echo
  echo "**通过**:最新备份可以成功恢复成一个结构与数据完整的数据库。"
  echo
  echo "请把本次结果登记到 docs/BACKUP_RECOVERY.md 的「恢复演练记录表」。"
} >>"$REPORT"

trap - EXIT
[ "$KEEP" = "0" ] && { echo "DROP DATABASE IF EXISTS \"$VERIFY_DB\";" | pg_sql >/dev/null; log "临时库已删除"; } || warn "临时库 $VERIFY_DB 已保留,检查完请手动删除"
compose exec -T postgres sh -c 'rm -f /tmp/verify-drill.dump' >/dev/null 2>&1 || true
[ -n "${TMP_DOWNLOAD:-}" ] && rm -f "$TMP_DOWNLOAD" || true

ok "恢复演练通过"
log "报告:$REPORT"
