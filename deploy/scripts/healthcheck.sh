#!/usr/bin/env bash
# ============================================================================
# 健康巡检:容器 / 就绪接口 / 队列深度 / 磁盘 / Redis 内存 / 数据库连接
# ----------------------------------------------------------------------------
# 设计给 cron 用(install-cron.sh 默认每 5 分钟一次):
#   - 一切正常:静默(只写日志),退出码 0 —— cron 不会发邮件打扰
#   - 有告警  :输出到 stderr,退出码 1,并触发 JUNE_ALERT_COMMAND
#   - 有致命项:退出码 2
#
# 用法:
#   ./deploy/scripts/healthcheck.sh            # 安静模式(cron)
#   ./deploy/scripts/healthcheck.sh --verbose  # 打印全部检查项(人工排查)
# ============================================================================
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

require_cmd docker awk
require_file "$ENV_FILE"

PROBLEMS=()
CRITICAL=0

note() { [ "$VERBOSE" = "1" ] && ok "$1" || _write_log "[ OK ] $1"; }
problem() { PROBLEMS+=("$1"); err "$1"; }
critical() { PROBLEMS+=("[致命] $1"); CRITICAL=1; err "[致命] $1"; }

# ---------------------------------------------------------------------------
# 1. 容器状态
# ---------------------------------------------------------------------------
for svc in postgres redis api worker web nginx; do
  state="$(compose ps --format '{{.State}}' "$svc" 2>/dev/null | head -n 1)"
  health="$(compose ps --format '{{.Health}}' "$svc" 2>/dev/null | head -n 1)"
  if [ -z "$state" ]; then
    critical "$svc 容器不存在(没起来?被删了?)"
  elif [ "$state" != "running" ]; then
    critical "$svc 容器状态 = $state"
  elif [ -n "$health" ] && [ "$health" != "healthy" ]; then
    # starting 短时间内是正常的,只报 unhealthy
    if [ "$health" = "unhealthy" ]; then
      critical "$svc 健康检查失败(unhealthy)"
    else
      problem "$svc 健康状态 = $health"
    fi
  else
    note "$svc running/${health:-无探针}"
  fi
done

# 重启次数:频繁重启说明有隐性崩溃(OOM 最常见)
for svc in api worker web; do
  cid="$(compose ps -q "$svc" 2>/dev/null | head -n 1)"
  [ -n "$cid" ] || continue
  restarts="$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || echo 0)"
  oom="$(docker inspect -f '{{.State.OOMKilled}}' "$cid" 2>/dev/null || echo false)"
  if [ "$oom" = "true" ]; then
    critical "$svc 曾被 OOM Killer 杀掉:检查 deploy.resources.limits 与 --max-old-space-size"
  fi
  if [ "${restarts:-0}" -gt 5 ]; then
    problem "$svc 重启次数 $restarts(偏高,查 docker compose logs $svc)"
  else
    note "$svc 重启次数 $restarts"
  fi
done

# ---------------------------------------------------------------------------
# 2. 就绪接口(从 api 容器内部打,绕开 DNS 与证书)
# ---------------------------------------------------------------------------
if compose ps -q api >/dev/null 2>&1 && [ -n "$(compose ps -q api)" ]; then
  if ready_body="$(compose exec -T api node -e "
      const p = process.env.API_PORT || 3001;
      fetch('http://127.0.0.1:'+p+'/api/health/ready')
        .then(async r => { const t = await r.text(); if (!r.ok) { console.error(t); process.exit(1); } console.log(t); })
        .catch(e => { console.error(e.message); process.exit(1); });
    " 2>&1)"; then
    note "/api/health/ready 正常:${ready_body}"
  else
    critical "/api/health/ready 失败:${ready_body}"
  fi
fi

# 入口链路(Nginx + TLS)
web_origin="$(env_value PUBLIC_WEB_ORIGIN)"
if command -v curl >/dev/null 2>&1 && [ -n "$web_origin" ]; then
  if curl -fsS -k --max-time 10 "${web_origin%/}/healthz" >/dev/null 2>&1; then
    note "入口 /healthz 正常"
  else
    problem "入口 ${web_origin%/}/healthz 不可达(DNS / 防火墙 / Nginx)"
  fi
fi

# ---------------------------------------------------------------------------
# 3. 队列深度(BullMQ 键格式:<QUEUE_PREFIX>:<队列名>:<状态>)
# ---------------------------------------------------------------------------
prefix="$(env_value QUEUE_PREFIX)"; prefix="${prefix:-june}"
max_image="$(env_value QUEUE_MAX_DEPTH_IMAGE)"; max_image="${max_image:-500}"
max_text="$(env_value QUEUE_MAX_DEPTH_TEXT)"; max_text="${max_text:-1000}"

queue_depth() { # $1=队列名 → wait 列表长度
  redis_cli LLEN "${prefix}:$1:wait" 2>/dev/null | tr -dc '0-9' || echo 0
}
queue_zset() { # $1=队列名 $2=状态(delayed/failed)
  redis_cli ZCARD "${prefix}:$1:$2" 2>/dev/null | tr -dc '0-9' || echo 0
}

if [ "$(compose ps --format '{{.State}}' redis | head -n 1)" = "running" ]; then
  img_wait="$(queue_depth image-generation)"; img_wait="${img_wait:-0}"
  txt_wait="$(queue_depth text-generation)"; txt_wait="${txt_wait:-0}"
  drv_wait="$(queue_depth image-derive)"; drv_wait="${drv_wait:-0}"
  img_failed="$(queue_zset image-generation failed)"; img_failed="${img_failed:-0}"

  note "队列 image-generation wait=$img_wait failed=$img_failed / text=$txt_wait / derive=$drv_wait"

  # 超过配置上限的 80% 就提醒:满载时 API 会显式拒绝新任务(队列容量检查),
  # 用户会看到"当前任务较多",这属于业务可见的降级,要提前知道。
  if [ "$img_wait" -gt $(( max_image * 8 / 10 )) ]; then
    problem "生图队列积压 $img_wait(上限 $max_image):worker 是否卡住?上游是否在超时?"
  fi
  if [ "$txt_wait" -gt $(( max_text * 8 / 10 )) ]; then
    problem "文案队列积压 $txt_wait(上限 $max_text)"
  fi
  if [ "$img_failed" -gt 100 ]; then
    problem "生图失败任务 $img_failed 条:看 /admin/tasks 的失败原因分布"
  fi

  # Redis 内存:noeviction 策略下打满 maxmemory 会**直接拒绝写入**,
  # 表现为入队失败 —— 必须在 70% 就报警。
  used="$(redis_cli INFO memory 2>/dev/null | awk -F: '/^used_memory:/{print $2}' | tr -dc '0-9')"
  maxmem="$(redis_cli CONFIG GET maxmemory 2>/dev/null | tail -n 1 | tr -dc '0-9')"
  if [ -n "$used" ] && [ -n "$maxmem" ] && [ "$maxmem" -gt 0 ]; then
    pct=$(( used * 100 / maxmem ))
    note "Redis 内存 $(human_bytes "$used") / $(human_bytes "$maxmem")(${pct}%)"
    if [ "$pct" -ge 70 ]; then
      problem "Redis 内存已用 ${pct}%:maxmemory-policy=noeviction,打满会拒绝写入导致任务无法入队"
    fi
  fi

  # AOF 状态:持久化坏了要立刻知道(否则重启丢队列)
  aof_enabled="$(redis_cli CONFIG GET appendonly 2>/dev/null | tail -n 1 | tr -d '\r')"
  [ "$aof_enabled" = "yes" ] || critical "Redis AOF 未开启:重启会丢失队列中的任务"
  aof_err="$(redis_cli INFO persistence 2>/dev/null | awk -F: '/^aof_last_write_status:/{print $2}' | tr -d '\r')"
  [ -z "$aof_err" ] || [ "$aof_err" = "ok" ] || critical "Redis AOF 最近一次写入状态 = $aof_err"
fi

# ---------------------------------------------------------------------------
# 4. 数据库连接与容量
# ---------------------------------------------------------------------------
if [ "$(compose ps --format '{{.Health}}' postgres | head -n 1)" = "healthy" ]; then
  conns="$(echo "SELECT count(*) FROM pg_stat_activity;" | pg_sql 2>/dev/null | tr -dc '0-9')"
  maxconns="$(echo "SHOW max_connections;" | pg_sql 2>/dev/null | tr -dc '0-9')"
  if [ -n "$conns" ] && [ -n "$maxconns" ]; then
    note "数据库连接 $conns / $maxconns"
    if [ "$conns" -gt $(( maxconns * 8 / 10 )) ]; then
      problem "数据库连接数 $conns 超过 max_connections 的 80%:检查连接池配置与泄漏"
    fi
  fi
  idle_tx="$(echo "SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction' AND now()-state_change > interval '1 minute';" | pg_sql 2>/dev/null | tr -dc '0-9')"
  if [ "${idle_tx:-0}" -gt 0 ]; then
    problem "有 ${idle_tx} 个事务空闲超过 1 分钟(持锁风险)"
  fi
  db_bytes="$(echo "SELECT pg_database_size(current_database());" | pg_sql 2>/dev/null | tr -dc '0-9')"
  if [ -n "$db_bytes" ]; then note "数据库大小 $(human_bytes "$db_bytes")"; fi
fi

# ---------------------------------------------------------------------------
# 5. 磁盘
# ---------------------------------------------------------------------------
# 100GB 单盘:pgdata、Redis AOF、Docker 镜像、备份、日志全在上面。
# 盘满对 PostgreSQL 是致命的(无法写 WAL,可能直接停止服务)。
disk_pct="$(df -P "$REPO_ROOT" | awk 'NR==2{gsub("%","",$5); print $5}')"
disk_avail="$(df -Pk "$REPO_ROOT" | awk 'NR==2{print $4*1024}')"
note "磁盘使用 ${disk_pct}%,可用 $(human_bytes "$disk_avail")"
if [ "$disk_pct" -ge 90 ]; then
  critical "磁盘使用率 ${disk_pct}%:立刻清理(docker image prune / 旧备份 / 日志),数据库写满会停服"
elif [ "$disk_pct" -ge 80 ]; then
  problem "磁盘使用率 ${disk_pct}%:该清理了(旧镜像、旧备份)"
fi

# Docker 数据目录如果是独立挂载点,单独看一次
docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
if [ -d "$docker_root" ]; then
  d_pct="$(df -P "$docker_root" | awk 'NR==2{gsub("%","",$5); print $5}')"
  if [ "$d_pct" != "$disk_pct" ]; then
    note "Docker 目录使用 ${d_pct}%"
    if [ "$d_pct" -ge 90 ]; then
      critical "Docker 目录($docker_root)使用率 ${d_pct}%"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 6. 备份新鲜度
# ---------------------------------------------------------------------------
backup_dir="$(env_value BACKUP_LOCAL_DIR)"; backup_dir="${backup_dir:-$REPO_ROOT/backups}"
if [ -d "$backup_dir" ]; then
  latest="$(find "$backup_dir" -maxdepth 1 -name 'june-*.dump.gz' -type f | sort | tail -n 1)"
  if [ -z "$latest" ]; then
    problem "没有任何本地备份:先跑 ./deploy/scripts/backup-db.sh 并安装 cron"
  else
    age_h=$(( ( $(date -u '+%s') - $(date -u -r "$latest" '+%s') ) / 3600 ))
    note "最新备份 $(basename "$latest")(${age_h} 小时前)"
    if [ "$age_h" -gt 30 ]; then
      problem "最新备份已 ${age_h} 小时:每日备份没有按时执行"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
if [ "${#PROBLEMS[@]}" -eq 0 ]; then
  if [ "$VERBOSE" = "1" ]; then step "全部检查通过"; fi
  _write_log "[ OK ] 巡检通过"
  exit 0
fi

step "发现 ${#PROBLEMS[@]} 个问题"
for p in "${PROBLEMS[@]}"; do printf '  - %s\n' "$p" >&2; done

if [ -n "${JUNE_ALERT_COMMAND:-}" ]; then
  { printf 'JUNE 健康巡检告警(%s):\n' "$(_ts)"; for p in "${PROBLEMS[@]}"; do printf '  - %s\n' "$p"; done; } \
    | ${JUNE_ALERT_COMMAND} >/dev/null 2>&1 || warn "告警命令执行失败"
fi

if [ "$CRITICAL" = "1" ]; then exit 2; fi
exit 1
