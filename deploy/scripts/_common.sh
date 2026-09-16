#!/usr/bin/env bash
# ============================================================================
# 公共函数库。被 deploy/scripts/ 下其他脚本 source,不单独执行。
# ----------------------------------------------------------------------------
# 约定:
#  - 所有脚本都 set -euo pipefail:命令失败、变量未定义、管道中间失败都立即终止。
#  - 读 .env 不用 `source`:.env 里存在 `BACKUP_CRON=0 3 * * *` 这类
#    带空格的值,source 会把它当命令执行。统一用 env_value 逐项取值。
#  - 日志同时输出到终端与 deploy/logs/<脚本名>.log,便于 cron 任务事后排查。
# ============================================================================
set -euo pipefail

# ---- 路径 ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${JUNE_ENV_FILE:-$REPO_ROOT/.env}"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
LOG_DIR="${JUNE_LOG_DIR:-$REPO_ROOT/deploy/logs}"
STATE_DIR="${JUNE_STATE_DIR:-$REPO_ROOT/deploy/.state}"
mkdir -p "$LOG_DIR" "$STATE_DIR"

CALLER_NAME="$(basename "${BASH_SOURCE[1]:-june}" .sh)"
LOG_FILE="${JUNE_LOG_FILE:-$LOG_DIR/${CALLER_NAME}.log}"

# ---- 颜色(非 tty 时自动关闭,保证 cron 日志干净)----
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_DIM=''; C_OFF=''
fi

_ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

_write_log() { printf '%s %s\n' "$(_ts)" "$1" >>"$LOG_FILE"; }

log()   { printf '%s[%s]%s %s\n' "$C_DIM" "$(_ts)" "$C_OFF" "$1"; _write_log "[INFO] $1"; }
step()  { printf '%s==>%s %s\n' "$C_BLUE" "$C_OFF" "$1"; _write_log "[STEP] $1"; }
ok()    { printf '%s  ✓%s %s\n' "$C_GREEN" "$C_OFF" "$1"; _write_log "[ OK ] $1"; }
warn()  { printf '%s  !%s %s\n' "$C_YELLOW" "$C_OFF" "$1" >&2; _write_log "[WARN] $1"; }
err()   { printf '%s  ✗%s %s\n' "$C_RED" "$C_OFF" "$1" >&2; _write_log "[FAIL] $1"; }

die() {
  err "$1"
  # 告警钩子:导出 JUNE_ALERT_COMMAND 即可接入企业微信/钉钉/邮件。
  # 例:export JUNE_ALERT_COMMAND='curl -s -X POST -d @- https://hook.example/june'
  if [ -n "${JUNE_ALERT_COMMAND:-}" ]; then
    printf 'JUNE 运维脚本失败: %s | 脚本: %s | 时间: %s\n' "$1" "$CALLER_NAME" "$(_ts)" \
      | ${JUNE_ALERT_COMMAND} >/dev/null 2>&1 || warn "告警命令执行失败(不影响主流程退出码)"
  fi
  exit "${2:-1}"
}

# ---- 前置检查 ----
require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "缺少命令:$c(请先安装)"
  done
}

require_file() { [ -f "$1" ] || die "缺少文件:$1"; }

# ---- .env 读取 ----
# 用法:value="$(env_value POSTGRES_USER)"
# 取最后一次出现的定义(与 dotenv 的 override=false 行为一致地取"第一个"不同,
# 这里取最后一个,便于在 .env 末尾临时覆盖);不做 shell 展开,原样返回。
env_value() {
  local key="$1" line value
  [ -f "$ENV_FILE" ] || return 0
  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n 1 || true)"
  [ -z "$line" ] && return 0
  value="${line#*=}"
  # 去首尾空白
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  # 去包裹引号
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

# 必填校验:值为空、或仍然是 .env.example 的占位符,都算未配置
require_env_value() {
  local key="$1" v
  v="$(env_value "$key")"
  [ -n "$v" ] || die "$ENV_FILE 缺少必填项:$key(对照 .env.example 填写)"
  case "$v" in
    *change-me*|*CHANGE_ME*|*your-*|*example.com*)
      die "$key 仍是模板占位值($v),生产环境必须替换" ;;
  esac
  printf '%s' "$v"
}

# ---- docker compose 包装 ----
# 固定 -f 与 --project-directory,保证从任何目录调用行为一致。
# JUNE_IMAGE_TAG / JUNE_IMAGE_PREFIX 由调用方导出,compose 负责插值。
compose() {
  docker compose --project-directory "$REPO_ROOT" -f "$COMPOSE_FILE" "$@"
}

# ---- 镜像 tag 状态(回滚需要知道"上一个成功的 tag")----
CURRENT_TAG_FILE="$STATE_DIR/current-image-tag"
PREVIOUS_TAG_FILE="$STATE_DIR/previous-image-tag"

read_current_tag() { [ -f "$CURRENT_TAG_FILE" ] && cat "$CURRENT_TAG_FILE" || printf 'latest'; }
read_previous_tag() { [ -f "$PREVIOUS_TAG_FILE" ] && cat "$PREVIOUS_TAG_FILE" || printf ''; }

record_tag() {
  local new_tag="$1" cur
  cur="$(read_current_tag)"
  if [ "$cur" != "$new_tag" ]; then
    printf '%s' "$cur" >"$PREVIOUS_TAG_FILE"
  fi
  printf '%s' "$new_tag" >"$CURRENT_TAG_FILE"
}

# ---- 交互确认 ----
# 必须原样输入指定词才继续;非交互环境(cron)一律拒绝,避免误执行破坏性操作。
confirm_word() {
  local word="$1" prompt="$2" answer
  if [ ! -t 0 ]; then
    die "该操作需要交互确认,但当前不是交互式终端。确实要在脚本里执行请设置 JUNE_ASSUME_YES=$word"
  fi
  printf '%s\n请输入 %s 以继续(其他任何输入都会取消):' "$prompt" "$word"
  read -r answer
  [ "$answer" = "$word" ] || die "已取消"
}

maybe_confirm_word() {
  local word="$1" prompt="$2"
  if [ "${JUNE_ASSUME_YES:-}" = "$word" ]; then
    warn "检测到 JUNE_ASSUME_YES=$word,跳过交互确认"
    return 0
  fi
  confirm_word "$word" "$prompt"
}

# ---- 小工具 ----
# 在 postgres 容器里执行 SQL。SQL 走标准输入,彻底避开多层引号转义。
# 密码只在容器内部环境变量里,不出现在宿主机命令行(ps 里看不到)。
#   用法:echo "SELECT 1;" | pg_sql            # 默认库 $POSTGRES_DB
#         echo "SELECT 1;" | pg_sql june_verify  # 指定库
pg_sql() {
  local db="${1:-}"
  compose exec -T postgres sh -c \
    "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"${db:-\$POSTGRES_DB}\" -At -f -"
}

# 在 redis 容器里执行 redis-cli
#   用法:redis_cli LLEN june:image-generation:wait
redis_cli() {
  compose exec -T redis sh -c 'exec redis-cli --no-auth-warning -a "$REDIS_PASSWORD" "$@"' _ "$@"
}

human_bytes() {
  awk -v b="$1" 'BEGIN{
    split("B KiB MiB GiB TiB",u," ");
    i=1; while (b>=1024 && i<5){ b/=1024; i++ }
    printf "%.1f%s", b, u[i]
  }'
}
