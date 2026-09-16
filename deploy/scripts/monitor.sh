#!/usr/bin/env bash
# ============================================================================
# 指标采集:CPU / 内存 / 磁盘 / 数据库连接 / 接口延迟 / 队列长度 / 任务等待 /
#           供应商错误率 / 存储增长
# ----------------------------------------------------------------------------
# 输出两份:
#   1. 人可读的一行摘要 → 终端 + deploy/logs/monitor.log(方便事后翻)
#   2. Prometheus textfile 格式 → deploy/logs/metrics/june.prom
#      (node_exporter 的 --collector.textfile.directory 指到这个目录即可接入
#       Prometheus + Grafana;没有监控系统时,这个文件本身就是可读的时间点快照)
#
# 单机 4 核 8G 上刻意不装 Prometheus/Grafana(它们自己就要吃掉几百 MB 内存)。
# 这个脚本 + node_exporter(约 20MB)是性价比最高的方案:把数据推到**外部**
# 的 Prometheus 去存和画图。
#
# 用法:
#   ./deploy/scripts/monitor.sh                       # 采集一次
#   ./deploy/scripts/monitor.sh --watch 10            # 每 10 秒采集一次(压测时用)
#   ./deploy/scripts/monitor.sh --csv results/m.csv   # 追加 CSV,便于压测后画图
# ============================================================================
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

require_cmd docker awk
require_file "$ENV_FILE"

METRICS_DIR="${JUNE_METRICS_DIR:-$REPO_ROOT/deploy/logs/metrics}"
METRICS_FILE="$METRICS_DIR/june.prom"
mkdir -p "$METRICS_DIR"

WATCH=0
CSV=""
while [ $# -gt 0 ]; do
  case "$1" in
    --watch) WATCH="${2:?--watch 需要秒数}"; shift 2 ;;
    --csv) CSV="${2:?--csv 需要文件路径}"; shift 2 ;;
    -h|--help) sed -n '1,26p' "$0"; exit 0 ;;
    *) die "未知参数:$1" ;;
  esac
done

# ---------------------------------------------------------------------------
collect_once() {
  local now_epoch out tmp
  now_epoch="$(date -u '+%s')"
  tmp="$(mktemp "${METRICS_DIR}/.june.prom.XXXXXX")"

  {
    echo "# JUNE-Commerce-Platform 运行指标(deploy/scripts/monitor.sh 生成)"
    echo "# 采集时间(UTC):$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "# HELP june_scrape_timestamp_seconds 本次采集的时间戳"
    echo "# TYPE june_scrape_timestamp_seconds gauge"
    echo "june_scrape_timestamp_seconds $now_epoch"
  } >"$tmp"

  # ---- 1. 容器 CPU / 内存 ----
  # docker stats --no-stream 会花 1~2 秒(要采两次样算 CPU 差值),这是正常的
  {
    echo "# HELP june_container_cpu_percent 容器 CPU 使用率(百分比,可 >100 表示多核)"
    echo "# TYPE june_container_cpu_percent gauge"
    echo "# HELP june_container_memory_bytes 容器内存使用量"
    echo "# TYPE june_container_memory_bytes gauge"
    echo "# HELP june_container_memory_limit_bytes 容器内存上限"
    echo "# TYPE june_container_memory_limit_bytes gauge"
  } >>"$tmp"

  local stats_raw
  stats_raw="$(docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' 2>/dev/null || true)"
  printf '%s\n' "$stats_raw" | awk -F'|' '
    /^$/ { next }
    {
      name=$1; cpu=$2; mem=$3;
      # 只统计本项目的容器(compose 名字形如 june-api-1)
      if (name !~ /^june/) next;
      svc=name; sub(/^june[-_]?(dev[-_])?/, "", svc); sub(/-[0-9]+$/, "", svc);
      gsub(/%/, "", cpu);
      split(mem, parts, " / ");
      printf "june_container_cpu_percent{service=\"%s\"} %s\n", svc, cpu+0;
      printf "june_container_memory_bytes{service=\"%s\"} %s\n", svc, tobytes(parts[1]);
      printf "june_container_memory_limit_bytes{service=\"%s\"} %s\n", svc, tobytes(parts[2]);
    }
    function tobytes(s,   v, u) {
      v = s + 0;
      u = s; gsub(/[0-9.]/, "", u);
      if (u ~ /^KiB/) return int(v * 1024);
      if (u ~ /^MiB/) return int(v * 1024 * 1024);
      if (u ~ /^GiB/) return int(v * 1024 * 1024 * 1024);
      if (u ~ /^TiB/) return int(v * 1024 * 1024 * 1024 * 1024);
      if (u ~ /^kB/)  return int(v * 1000);
      if (u ~ /^MB/)  return int(v * 1000 * 1000);
      if (u ~ /^GB/)  return int(v * 1000 * 1000 * 1000);
      return int(v);
    }
  ' >>"$tmp"

  # ---- 2. 磁盘 ----
  local disk_pct disk_avail disk_total
  disk_pct="$(df -P "$REPO_ROOT" | awk 'NR==2{gsub("%","",$5); print $5}')"
  disk_avail="$(df -Pk "$REPO_ROOT" | awk 'NR==2{print $4*1024}')"
  disk_total="$(df -Pk "$REPO_ROOT" | awk 'NR==2{print $2*1024}')"
  {
    echo "# HELP june_disk_used_percent 数据盘使用率"
    echo "# TYPE june_disk_used_percent gauge"
    echo "june_disk_used_percent $disk_pct"
    echo "# HELP june_disk_available_bytes 数据盘可用空间"
    echo "# TYPE june_disk_available_bytes gauge"
    echo "june_disk_available_bytes $disk_avail"
    echo "june_disk_total_bytes $disk_total"
  } >>"$tmp"

  # 卷大小(pgdata / redisdata):存储增长趋势的核心指标
  local docker_root pg_vol_bytes
  docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  if [ -r "$docker_root/volumes/june_pgdata" ]; then
    pg_vol_bytes="$(du -sk "$docker_root/volumes/june_pgdata" 2>/dev/null | awk '{print $1*1024}')"
    if [ -n "${pg_vol_bytes:-}" ]; then
      echo "june_pgdata_volume_bytes ${pg_vol_bytes}" >>"$tmp"
    fi
  fi

  # ---- 3. PostgreSQL ----
  local pg_healthy
  pg_healthy="$(compose ps --format '{{.Health}}' postgres 2>/dev/null | head -n 1)"
  local pg_conns=0 pg_active=0 pg_db_bytes=0 pg_idle_tx=0 pg_cache_hit=0
  if [ "$pg_healthy" = "healthy" ]; then
    pg_conns="$(echo "SELECT count(*) FROM pg_stat_activity;" | pg_sql 2>/dev/null | tr -dc '0-9')"
    pg_active="$(echo "SELECT count(*) FROM pg_stat_activity WHERE state='active';" | pg_sql 2>/dev/null | tr -dc '0-9')"
    pg_idle_tx="$(echo "SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction';" | pg_sql 2>/dev/null | tr -dc '0-9')"
    pg_db_bytes="$(echo "SELECT pg_database_size(current_database());" | pg_sql 2>/dev/null | tr -dc '0-9')"
    # 缓存命中率:低于 0.98 通常意味着 shared_buffers 不够或有全表扫描
    pg_cache_hit="$(echo "SELECT round(sum(blks_hit)::numeric/greatest(sum(blks_hit)+sum(blks_read),1),4) FROM pg_stat_database;" | pg_sql 2>/dev/null | tr -dc '0-9.')"
    {
      echo "# HELP june_pg_connections 当前数据库连接数"
      echo "# TYPE june_pg_connections gauge"
      echo "june_pg_connections ${pg_conns:-0}"
      echo "june_pg_connections_active ${pg_active:-0}"
      echo "june_pg_idle_in_transaction ${pg_idle_tx:-0}"
      echo "# HELP june_pg_database_bytes 业务库大小"
      echo "# TYPE june_pg_database_bytes gauge"
      echo "june_pg_database_bytes ${pg_db_bytes:-0}"
      echo "# HELP june_pg_cache_hit_ratio 共享缓存命中率(0~1)"
      echo "# TYPE june_pg_cache_hit_ratio gauge"
      echo "june_pg_cache_hit_ratio ${pg_cache_hit:-0}"
    } >>"$tmp"

    # ---- 4. 业务指标(直接查库,口径写在 SQL 注释里)----
    # 存储用量总和:StorageUsage.bytes_used 是应用维护的权威用量
    local storage_bytes task_wait_p50 task_wait_p95 upstream_p95 fail_rate queued_tasks running_tasks
    storage_bytes="$(echo "SELECT coalesce(sum(bytes_used),0) FROM storage_usage;" | pg_sql 2>/dev/null | tr -dc '0-9')"
    # 最近 15 分钟完成的任务:排队等待与上游耗时**分开统计**
    # (平台能力 vs 上游速度必须分开报告,见 docs/LOAD_TEST.md)
    task_wait_p50="$(echo "SELECT coalesce(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY queue_wait_ms)),0) FROM generation_tasks WHERE finished_at > now() - interval '15 minutes' AND queue_wait_ms IS NOT NULL;" | pg_sql 2>/dev/null | tr -dc '0-9')"
    task_wait_p95="$(echo "SELECT coalesce(round(percentile_cont(0.95) WITHIN GROUP (ORDER BY queue_wait_ms)),0) FROM generation_tasks WHERE finished_at > now() - interval '15 minutes' AND queue_wait_ms IS NOT NULL;" | pg_sql 2>/dev/null | tr -dc '0-9')"
    upstream_p95="$(echo "SELECT coalesce(round(percentile_cont(0.95) WITHIN GROUP (ORDER BY upstream_duration_ms)),0) FROM generation_tasks WHERE finished_at > now() - interval '15 minutes' AND upstream_duration_ms IS NOT NULL;" | pg_sql 2>/dev/null | tr -dc '0-9')"
    # 供应商错误率:最近 15 分钟 FAILED+TIMEOUT+UNKNOWN 占比(口径:按任务数,不按图片数)
    fail_rate="$(echo "SELECT coalesce(round(count(*) FILTER (WHERE status IN ('FAILED','TIMEOUT','UNKNOWN'))::numeric / greatest(count(*),1), 4), 0) FROM generation_tasks WHERE created_at > now() - interval '15 minutes';" | pg_sql 2>/dev/null | tr -dc '0-9.')"
    queued_tasks="$(echo "SELECT count(*) FROM generation_tasks WHERE status='QUEUED';" | pg_sql 2>/dev/null | tr -dc '0-9')"
    running_tasks="$(echo "SELECT count(*) FROM generation_tasks WHERE status='RUNNING';" | pg_sql 2>/dev/null | tr -dc '0-9')"
    {
      echo "# HELP june_storage_used_bytes 所有用户存储用量之和(StorageUsage 口径)"
      echo "# TYPE june_storage_used_bytes gauge"
      echo "june_storage_used_bytes ${storage_bytes:-0}"
      echo "# HELP june_task_queue_wait_ms 任务排队等待耗时(最近 15 分钟完成的任务)"
      echo "# TYPE june_task_queue_wait_ms gauge"
      echo "june_task_queue_wait_ms{quantile=\"0.5\"} ${task_wait_p50:-0}"
      echo "june_task_queue_wait_ms{quantile=\"0.95\"} ${task_wait_p95:-0}"
      echo "# HELP june_task_upstream_duration_ms 上游模型耗时(与平台耗时分开统计)"
      echo "# TYPE june_task_upstream_duration_ms gauge"
      echo "june_task_upstream_duration_ms{quantile=\"0.95\"} ${upstream_p95:-0}"
      echo "# HELP june_provider_error_rate 最近 15 分钟任务失败率(FAILED/TIMEOUT/UNKNOWN)"
      echo "# TYPE june_provider_error_rate gauge"
      echo "june_provider_error_rate ${fail_rate:-0}"
      echo "# HELP june_tasks_by_status 任务状态计数"
      echo "# TYPE june_tasks_by_status gauge"
      echo "june_tasks_by_status{status=\"QUEUED\"} ${queued_tasks:-0}"
      echo "june_tasks_by_status{status=\"RUNNING\"} ${running_tasks:-0}"
    } >>"$tmp"
  fi

  # ---- 5. Redis 与队列 ----
  local redis_running redis_used=0 redis_max=0 redis_clients=0
  redis_running="$(compose ps --format '{{.State}}' redis 2>/dev/null | head -n 1)"
  local prefix; prefix="$(env_value QUEUE_PREFIX)"; prefix="${prefix:-june}"
  if [ "$redis_running" = "running" ]; then
    redis_used="$(redis_cli INFO memory 2>/dev/null | awk -F: '/^used_memory:/{print $2}' | tr -dc '0-9')"
    redis_max="$(redis_cli CONFIG GET maxmemory 2>/dev/null | tail -n 1 | tr -dc '0-9')"
    redis_clients="$(redis_cli INFO clients 2>/dev/null | awk -F: '/^connected_clients:/{print $2}' | tr -dc '0-9')"
    {
      echo "# HELP june_redis_used_memory_bytes Redis 已用内存"
      echo "# TYPE june_redis_used_memory_bytes gauge"
      echo "june_redis_used_memory_bytes ${redis_used:-0}"
      echo "june_redis_maxmemory_bytes ${redis_max:-0}"
      echo "june_redis_connected_clients ${redis_clients:-0}"
      echo "# HELP june_queue_depth BullMQ 队列深度"
      echo "# TYPE june_queue_depth gauge"
    } >>"$tmp"
    for q in image-generation text-generation image-derive product-import maintenance; do
      local w a d f
      w="$(redis_cli LLEN "${prefix}:${q}:wait" 2>/dev/null | tr -dc '0-9')"
      a="$(redis_cli LLEN "${prefix}:${q}:active" 2>/dev/null | tr -dc '0-9')"
      d="$(redis_cli ZCARD "${prefix}:${q}:delayed" 2>/dev/null | tr -dc '0-9')"
      f="$(redis_cli ZCARD "${prefix}:${q}:failed" 2>/dev/null | tr -dc '0-9')"
      {
        echo "june_queue_depth{queue=\"$q\",state=\"wait\"} ${w:-0}"
        echo "june_queue_depth{queue=\"$q\",state=\"active\"} ${a:-0}"
        echo "june_queue_depth{queue=\"$q\",state=\"delayed\"} ${d:-0}"
        echo "june_queue_depth{queue=\"$q\",state=\"failed\"} ${f:-0}"
      } >>"$tmp"
    done
  fi

  # ---- 6. 接口延迟(从 Nginx 访问日志算,不需要额外组件)----
  # 取最近 2000 行,按 rt=(request_time)算 P50/P95/P99 与错误率。
  # ⚠ 口径:包含 TLS 之后的全部处理时间,含静态资源与 SSE 长连接。
  #    SSE 的 rt 是整条连接的存活时间(动辄几百秒),会把 P99 拉飞,
  #    所以下面**排除 /api/events/**,并单独排除图片路径,
  #    这样得到的才是"JSON 业务接口延迟"(与 steady-rps.js 的口径一致)。
  local access_log p50=0 p95=0 p99=0 err_rate=0 sample=0 lat_file
  access_log="$(compose exec -T nginx sh -c 'tail -n 2000 /var/log/nginx/access.log 2>/dev/null' 2>/dev/null || true)"
  if [ -n "$access_log" ]; then
    lat_file="$(mktemp "${TMPDIR:-/tmp}/june-lat.XXXXXX")"
    # 先过滤(排除 SSE 与图片/字体),取出 rt= 数值,交给 sort -n 排序,
    # 再用 awk 按下标取分位数 —— 不依赖 gawk 的 asort,mawk/busybox awk 都能跑
    printf '%s\n' "$access_log" \
      | grep -v '/api/events/' \
      | grep -vE '\.(png|jpe?g|webp|avif|gif|svg|ico|woff2?)' \
      | sed -n 's/.*[[:space:]]rt=\([0-9.]\{1,\}\)[[:space:]].*/\1/p' \
      | sort -n >"$lat_file"
    sample="$(wc -l <"$lat_file" | tr -d ' ')"
    if [ "${sample:-0}" -gt 0 ]; then
      read -r p50 p95 p99 <<EOF
$(awk '{a[NR]=$1} END{
          i50=int(NR*0.50); if(i50<1)i50=1;
          i95=int(NR*0.95); if(i95<1)i95=1;
          i99=int(NR*0.99); if(i99<1)i99=1;
          printf "%.3f %.3f %.3f\n", a[i50], a[i95], a[i99];
        }' "$lat_file")
EOF
    fi
    # 5xx 比例(同样排除 SSE):status 用正则取,避免 URI 里的空格影响字段序号
    err_rate="$(printf '%s\n' "$access_log" | grep -v '/api/events/' | awk '
      {
        if (match($0, /" [0-9][0-9][0-9] /)) {
          code = substr($0, RSTART + 2, 3) + 0;
          total++;
          if (code >= 500) bad++;
        }
      }
      END { printf "%.4f\n", (total > 0 ? bad / total : 0) }')"
    rm -f "$lat_file"
    {
      echo "# HELP june_http_request_seconds Nginx 访问日志算出的接口延迟(已排除 SSE 与图片)"
      echo "# TYPE june_http_request_seconds gauge"
      echo "june_http_request_seconds{quantile=\"0.5\"} ${p50:-0}"
      echo "june_http_request_seconds{quantile=\"0.95\"} ${p95:-0}"
      echo "june_http_request_seconds{quantile=\"0.99\"} ${p99:-0}"
      echo "june_http_5xx_ratio ${err_rate:-0}"
      echo "june_http_sample_count ${sample:-0}"
    } >>"$tmp"
  fi

  # 原子替换:避免 node_exporter 读到写了一半的文件
  mv -f "$tmp" "$METRICS_FILE"
  chmod 644 "$METRICS_FILE"

  # ---- 一行摘要 ----
  local summary
  summary="$(printf 'disk=%s%% pg_conn=%s pg_cache=%s redis=%s/%s queue_img_wait=%s task_wait_p95=%sms upstream_p95=%sms fail_rate=%s http_p95=%ss' \
    "${disk_pct:-?}" "${pg_conns:-?}" "${pg_cache_hit:-?}" \
    "$(human_bytes "${redis_used:-0}")" "$(human_bytes "${redis_max:-0}")" \
    "$(redis_cli LLEN "${prefix}:image-generation:wait" 2>/dev/null | tr -dc '0-9' || echo '?')" \
    "${task_wait_p95:-?}" "${upstream_p95:-?}" "${fail_rate:-?}" "${p95:-?}")"
  log "$summary"

  if [ -n "$CSV" ]; then
    mkdir -p "$(dirname "$CSV")"
    if [ ! -f "$CSV" ]; then
      echo "ts,disk_pct,pg_conns,pg_active,pg_cache_hit,redis_used,queue_img_wait,task_wait_p95,upstream_p95,fail_rate,http_p95,http_p99" >"$CSV"
    fi
    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "${disk_pct:-}" "${pg_conns:-}" "${pg_active:-}" "${pg_cache_hit:-}" \
      "${redis_used:-}" "$(redis_cli LLEN "${prefix}:image-generation:wait" 2>/dev/null | tr -dc '0-9' || echo '')" \
      "${task_wait_p95:-}" "${upstream_p95:-}" "${fail_rate:-}" "${p95:-}" "${p99:-}" >>"$CSV"
  fi
}

if [ "$WATCH" != "0" ]; then
  log "每 ${WATCH} 秒采集一次,Ctrl-C 结束。指标文件:$METRICS_FILE"
  while true; do
    collect_once || warn "本轮采集出错,继续"
    sleep "$WATCH"
  done
else
  collect_once
  log "指标已写入:$METRICS_FILE"
  log "接入 Prometheus:node_exporter --collector.textfile.directory=$METRICS_DIR"
fi
