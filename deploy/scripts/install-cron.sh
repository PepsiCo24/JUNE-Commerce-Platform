#!/usr/bin/env bash
# ============================================================================
# 安装定时任务:每日备份 / 每周恢复演练 / 每 5 分钟健康巡检 / 每分钟指标采集
# ----------------------------------------------------------------------------
# 做法:把 JUNE 的条目集中写在一个标记块里(# >>> JUNE ... # <<< JUNE),
# 重复执行只会替换这个块,不会动用户自己的其他 crontab 条目。
#
# 用法:
#   ./deploy/scripts/install-cron.sh              # 安装/更新
#   ./deploy/scripts/install-cron.sh --show       # 只打印将要写入的内容
#   ./deploy/scripts/install-cron.sh --remove     # 移除 JUNE 的条目
#
# 备份时间取 .env 的 BACKUP_CRON(默认 `0 3 * * *`,即每天 03:00)。
# ⚠ crontab 用的是**服务器本地时区**,而应用内部一律 UTC。
#   请确认 `date` 显示的时区,别把备份排到业务高峰。
# ============================================================================
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

require_cmd crontab
require_file "$ENV_FILE"

MARK_BEGIN="# >>> JUNE-Commerce-Platform 定时任务(由 install-cron.sh 生成,勿手改)"
MARK_END="# <<< JUNE-Commerce-Platform"

BACKUP_CRON="$(env_value BACKUP_CRON)"; BACKUP_CRON="${BACKUP_CRON:-0 3 * * *}"
BACKUP_ENABLED="$(env_value BACKUP_ENABLED)"

# 恢复演练:每周日 04:30(排在每日备份之后,用当天最新的备份做演练)
DRILL_CRON="${JUNE_DRILL_CRON:-30 4 * * 0}"

build_block() {
  cat <<EOF
$MARK_BEGIN
# 仓库:$REPO_ROOT
# 所有任务都把输出重定向到 deploy/logs/*.log(脚本内部也会写日志),
# 只有非零退出码才会触发 cron 的邮件/告警,避免每天被正常日志刷屏。
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# 告警钩子(可选):填一条能读 stdin 的命令,例如推送到企业微信机器人
# JUNE_ALERT_COMMAND=curl -s -X POST -H 'Content-Type: text/plain' --data-binary @- https://example/hook

# 每日数据库备份(pg_dump -Fc → 试读校验 → gzip → 上传独立存储 → 清理过期)
$BACKUP_CRON cd $REPO_ROOT && ./deploy/scripts/backup-db.sh >> $LOG_DIR/cron-backup.log 2>&1

# 每周恢复演练(恢复到临时库 + 基本查询验证 + 输出报告)
# 这是"备份必须至少验证过一次恢复"的常态化落地,报告在 deploy/logs/restore-drills/
$DRILL_CRON cd $REPO_ROOT && ./deploy/scripts/verify-backup.sh >> $LOG_DIR/cron-drill.log 2>&1

# 每 5 分钟健康巡检(容器 / 就绪接口 / 队列深度 / 磁盘 / Redis 内存 / 备份新鲜度)
*/5 * * * * cd $REPO_ROOT && ./deploy/scripts/healthcheck.sh >> $LOG_DIR/cron-healthcheck.log 2>&1

# 每分钟采集指标到 Prometheus textfile(供 node_exporter 抓取)
* * * * * cd $REPO_ROOT && ./deploy/scripts/monitor.sh >> $LOG_DIR/cron-monitor.log 2>&1

# 每周清理 dangling 镜像与 7 天前的构建缓存(100GB 单盘,镜像最容易吃满)
# 注意:只清无 tag 的镜像,带 tag 的历史版本要留着回滚
15 5 * * 1 docker image prune -f >> $LOG_DIR/cron-prune.log 2>&1 && docker builder prune -f --filter until=168h >> $LOG_DIR/cron-prune.log 2>&1

# 日志自身也要轮转(cron-*.log 不受 Docker 的 json-file 轮转管辖)
20 5 * * 1 find $LOG_DIR -maxdepth 1 -name '*.log' -size +50M -exec truncate -s 0 {} \\; >> $LOG_DIR/cron-prune.log 2>&1
$MARK_END
EOF
}

case "${1:-}" in
  --show)
    build_block
    exit 0
    ;;
  --remove)
    current="$(crontab -l 2>/dev/null || true)"
    printf '%s\n' "$current" | sed "/$(printf '%s' "$MARK_BEGIN" | sed 's/[][\/.*^$]/\\&/g')/,/$(printf '%s' "$MARK_END" | sed 's/[][\/.*^$]/\\&/g')/d" | crontab -
    ok "已移除 JUNE 的 crontab 条目"
    crontab -l 2>/dev/null | sed 's/^/    /' || true
    exit 0
    ;;
esac

if [ "$BACKUP_ENABLED" != "true" ]; then
  warn "BACKUP_ENABLED 当前不是 true。定时备份仍会安装并执行,"
  warn "但请把 .env 改成 BACKUP_ENABLED=true 以保持配置与实际一致。"
fi

backup_bucket="$(env_value BACKUP_S3_BUCKET)"
if [ -z "$backup_bucket" ]; then
  warn "BACKUP_S3_BUCKET 未配置:备份只会留在本机。"
  warn "⚠ 本机磁盘损坏时数据与备份会一起丢失 —— 请尽快配置独立的备份桶。"
fi

step "将要写入的 crontab 条目"
build_block | sed 's/^/    /'

step "安装"
# 先移除旧块,再追加新块
current="$(crontab -l 2>/dev/null || true)"
cleaned="$(printf '%s\n' "$current" | sed "/$(printf '%s' "$MARK_BEGIN" | sed 's/[][\/.*^$]/\\&/g')/,/$(printf '%s' "$MARK_END" | sed 's/[][\/.*^$]/\\&/g')/d")"
{
  printf '%s\n' "$cleaned" | sed '/^[[:space:]]*$/d'
  echo
  build_block
} | crontab -

ok "crontab 已更新"
log "查看:crontab -l"
log "时区:$(date '+%Z %z')(cron 按本地时区执行,应用内部用 UTC)"

cat <<EOF

验证建议(不要等到真出事才发现 cron 没跑):
  1. 立刻手动跑一遍,确认脚本在 cron 的最小环境下也能工作:
       ./deploy/scripts/backup-db.sh
       ./deploy/scripts/verify-backup.sh
       ./deploy/scripts/healthcheck.sh --verbose
  2. 明天检查 $LOG_DIR/cron-backup.log 是否有新记录;
  3. 把 deploy/logs/restore-drills/ 下的报告结论抄到
     docs/BACKUP_RECOVERY.md 的「恢复演练记录表」。

注意:cron 的 PATH 很窄。如果备份上传用的是 aws / mc,确认它们在上面的
PATH 里(或改成绝对路径),否则会出现"手动能跑、定时任务失败"。
EOF
