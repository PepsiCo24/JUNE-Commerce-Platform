#!/usr/bin/env bash
# ============================================================================
# 从备份恢复数据库(**破坏性操作,必须交互确认**)
# ----------------------------------------------------------------------------
# 推荐流程(不要跳步):
#   ① 先恢复到临时库验证 → ② 确认数据符合预期 → ③ 再切换正式库
#
#   本脚本的 --to-temp 模式做 ①:
#       ./deploy/scripts/restore-db.sh backups/xxx.dump.gz --to-temp
#     它会建一个 june_restore_<时间戳> 临时库并恢复进去,不动线上数据,
#     然后打印基本统计供人工核对。
#
#   确认无误后做 ③(两种切换方式):
#     A. 改名切换(推荐,回头路最短):
#          -- 需要断开所有连接:先 docker compose stop api worker web
#          ALTER DATABASE june RENAME TO june_old_<时间戳>;
#          ALTER DATABASE june_restore_<时间戳> RENAME TO june;
#        出问题可以再改回来,原库还在。
#     B. 原库直接覆盖(本脚本默认模式 --in-place):
#          drop schema public → 从备份恢复。原库数据**立即消失**,
#          只有备份文件是唯一退路。
#
#   ⚠ 恢复会把数据回到备份时刻,备份之后产生的业务数据全部丢失(RPO)。
#     执行前务必评估影响并通知用户,见 docs/BACKUP_RECOVERY.md。
#   ⚠ 对象存储里的图片**不会**被这个脚本回退:数据库回到过去后,
#     可能出现"记录不存在但对象还在"(孤儿文件,清理任务会处理)或
#     "记录存在但对象已被删除"(需要按 BACKUP_RECOVERY.md 的版本恢复流程处理)。
#
# 用法:
#   ./deploy/scripts/restore-db.sh <备份文件.dump.gz> [--to-temp|--in-place]
#   ./deploy/scripts/restore-db.sh --latest --to-temp
# ============================================================================
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

require_cmd docker gzip
require_file "$ENV_FILE"

BACKUP_DIR="$(env_value BACKUP_LOCAL_DIR)"; BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
PG_DB="$(env_value POSTGRES_DB)"
MODE="in-place"
FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --latest)
      FILE="$(find "$BACKUP_DIR" -maxdepth 1 -name 'june-*.dump.gz' -type f | sort | tail -n 1)"
      [ -n "$FILE" ] || die "$BACKUP_DIR 下没有备份文件"
      shift ;;
    --to-temp) MODE="to-temp"; shift ;;
    --in-place) MODE="in-place"; shift ;;
    -h|--help) sed -n '1,36p' "$0"; exit 0 ;;
    *) FILE="$1"; shift ;;
  esac
done

[ -n "$FILE" ] || die "请指定备份文件,或用 --latest。可用备份:
$(find "$BACKUP_DIR" -maxdepth 1 -name 'june-*.dump.gz' -type f -exec ls -lh {} \; 2>/dev/null | awk '{print "  "$9"  "$5}' || echo '  (无)')"
require_file "$FILE"

# ---------------------------------------------------------------------------
step "1/5 校验备份文件"
# ---------------------------------------------------------------------------
gzip -t "$FILE" || die "gzip 校验失败,这个文件不可用:$FILE"
if [ -f "${FILE}.sha256" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256") >/dev/null \
      && ok "sha256 校验通过" || die "sha256 校验失败:文件在传输或存放过程中损坏"
  fi
else
  warn "没有找到 ${FILE}.sha256,跳过校验和比对"
fi

# 解压到容器可读的位置(通过 stdin 传给容器,不在宿主机留明文副本)
entry_count="$(gzip -dc "$FILE" | compose exec -T postgres sh -c 'cat > /tmp/restore.dump && pg_restore --list /tmp/restore.dump | grep -c "^[0-9]"')"
entry_count="$(printf '%s' "$entry_count" | tr -dc '0-9')"
[ "${entry_count:-0}" -gt 10 ] || die "备份目录只读出 ${entry_count:-0} 个条目,不可信"
ok "备份可解析,$entry_count 个归档条目(已放到容器 /tmp/restore.dump)"

# ---------------------------------------------------------------------------
step "2/5 确认操作"
# ---------------------------------------------------------------------------
if [ "$MODE" = "to-temp" ]; then
  TARGET_DB="june_restore_$(date -u '+%Y%m%d%H%M%S')"
  cat <<EOF
  模式     : 恢复到临时库(安全,不动线上数据)
  备份文件 : $FILE
  临时库   : $TARGET_DB
EOF
  maybe_confirm_word "RESTORE" "确认恢复到临时库?"
else
  TARGET_DB="$PG_DB"
  cat <<EOF
  模式     : ⚠⚠ 覆盖正式库(破坏性!)
  备份文件 : $FILE
  目标库   : $TARGET_DB
  后果     : $TARGET_DB 的现有数据会被清空并替换为备份时刻的数据。
             备份时刻之后产生的用户数据**全部丢失**。
  建议     : 先用 --to-temp 验证,再按文件头部的「改名切换」方式切库。
EOF
  warn "如果你还没有做过一次 --to-temp 验证,现在请取消。"
  maybe_confirm_word "OVERWRITE-${TARGET_DB}" "确认覆盖正式库?"
fi

# ---------------------------------------------------------------------------
step "3/5 停止应用写入"
# ---------------------------------------------------------------------------
if [ "$MODE" = "in-place" ]; then
  log "停止 api / worker / web(恢复期间不能有连接持有旧库)"
  compose stop api worker web
  ok "应用已停止"
else
  log "临时库模式:线上服务保持运行"
fi

# ---------------------------------------------------------------------------
step "4/5 执行恢复"
# ---------------------------------------------------------------------------
if [ "$MODE" = "to-temp" ]; then
  echo "CREATE DATABASE \"$TARGET_DB\";" | pg_sql >/dev/null
  ok "已创建临时库 $TARGET_DB"
else
  # 清空 public schema 而不是 drop database:避免掉连接与所有权问题,
  # 且 -Fc 备份里包含 CREATE SCHEMA public。
  echo "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;" | pg_sql >/dev/null
  ok "已清空 $TARGET_DB 的 public schema"
fi

# --exit-on-error:恢复中任何一条语句失败都停下,不要"恢复了一半"。
# -j 2:并行 2 个 worker(4 核机器,留 CPU 给其他容器)。
compose exec -T postgres sh -c \
  "PGPASSWORD=\"\$POSTGRES_PASSWORD\" pg_restore -U \"\$POSTGRES_USER\" -d \"$TARGET_DB\" \
     --no-owner --no-privileges --exit-on-error -j 2 /tmp/restore.dump" \
  || die "pg_restore 失败。$([ "$MODE" = "in-place" ] && echo '正式库现在处于不完整状态,必须继续排查或换一份备份重试!')"
ok "恢复完成"

# ---------------------------------------------------------------------------
step "5/5 恢复后核对"
# ---------------------------------------------------------------------------
report="$(cat <<'SQL' | pg_sql "$TARGET_DB"
SELECT 'users        = ' || count(*) FROM users
UNION ALL SELECT 'posts        = ' || count(*) FROM posts
UNION ALL SELECT 'comments     = ' || count(*) FROM comments
UNION ALL SELECT 'shops        = ' || count(*) FROM shops
UNION ALL SELECT 'products     = ' || count(*) FROM products
UNION ALL SELECT 'assets       = ' || count(*) FROM assets
UNION ALL SELECT 'tasks        = ' || count(*) FROM generation_tasks
UNION ALL SELECT 'migrations   = ' || count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;
SQL
)"
printf '%s\n' "$report" | sed 's/^/    /'

# 清理容器内的临时 dump(里面是全站数据)
compose exec -T postgres sh -c 'rm -f /tmp/restore.dump' || true

if [ "$MODE" = "in-place" ]; then
  step "重启应用"
  compose up -d api worker web
  log "等待 api 就绪..."
  for i in $(seq 1 40); do
    [ "$(compose ps --format '{{.Health}}' api | head -n 1)" = "healthy" ] && { ok "api 就绪"; break; }
    [ "$i" = "40" ] && err "api 未在 120 秒内就绪,查看 docker compose logs api"
    sleep 3
  done
fi

step "完成"
cat <<EOF
  目标库 : $TARGET_DB
  模式   : $MODE

后续:
EOF
if [ "$MODE" = "to-temp" ]; then
  cat <<EOF
  1. 人工核对上面的行数是否符合预期(与故障前的量级对比);
  2. 需要切换到正式库时,在维护窗口内执行(先停应用):
       docker compose stop api worker web
       echo 'ALTER DATABASE "$PG_DB" RENAME TO "${PG_DB}_old";' | \\
         docker compose exec -T postgres sh -c 'PGPASSWORD="\$POSTGRES_PASSWORD" psql -U "\$POSTGRES_USER" -d postgres -f -'
       echo 'ALTER DATABASE "$TARGET_DB" RENAME TO "$PG_DB";' | \\
         docker compose exec -T postgres sh -c 'PGPASSWORD="\$POSTGRES_PASSWORD" psql -U "\$POSTGRES_USER" -d postgres -f -'
       docker compose up -d api worker web
  3. 确认稳定运行一段时间后,再删除 ${PG_DB}_old;
  4. 用完的临时库记得删除,别让它占着磁盘。
EOF
else
  cat <<EOF
  1. 登录站点抽查关键数据(用户能登录、帖子/商品/图片能打开);
  2. 图片对象可能与数据库不一致,按 docs/BACKUP_RECOVERY.md
     「对象存储误删恢复」核对;
  3. 在 docs/BACKUP_RECOVERY.md 的恢复记录表登记本次操作(时间、备份文件、
     数据丢失窗口、耗时),这是 RTO/RPO 的实测依据。
EOF
fi
