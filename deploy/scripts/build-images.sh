#!/usr/bin/env bash
# ============================================================================
# 构建镜像(web / api / worker / migrate)
# ----------------------------------------------------------------------------
# 为什么强调"在开发机或 CI 构建":
#   Next.js 生产构建 + tsc 全量编译 + prisma generate 同时跑,峰值内存常见
#   2.5~4GB。目标生产机是 4 核 8G,而且 postgres/redis/api/worker 还占着
#   约 7G 上限 —— 在生产机直接构建极易 OOM(表现是构建进程被 Killed,
#   或者更糟:把正在服务的容器挤爆)。
#
#   所以标准流程是:开发机/CI 构建 → 推私有仓库(或导出 tar)→ 生产机拉取。
#   实在只有一台机器时,用本脚本的 --on-server 模式(见下方降级方案)。
#
# 用法:
#   ./deploy/scripts/build-images.sh                      # 构建 4 个 target,tag=git 短哈希
#   ./deploy/scripts/build-images.sh --tag v1.2.0         # 指定 tag
#   ./deploy/scripts/build-images.sh --push               # 构建后推送
#   ./deploy/scripts/build-images.sh --save               # 导出 tar 到 deploy/images/
#   ./deploy/scripts/build-images.sh --target api         # 只构建一个 target
#   ./deploy/scripts/build-images.sh --on-server          # 生产机降级构建(串行 + 低并发)
#
# 环境变量:
#   JUNE_IMAGE_PREFIX   镜像前缀,默认 june(推私仓时填 registry.example.com/june)
#   JUNE_IMAGE_TAG      镜像 tag,默认 git 短哈希(脏工作区加 -dirty)
# ============================================================================
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

PUSH=0
SAVE=0
ON_SERVER=0
TARGETS=(api worker web migrate)
TAG="${JUNE_IMAGE_TAG:-}"
PREFIX="${JUNE_IMAGE_PREFIX:-june}"

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:?--tag 需要参数}"; shift 2 ;;
    --push) PUSH=1; shift ;;
    --save) SAVE=1; shift ;;
    --on-server) ON_SERVER=1; shift ;;
    --target) TARGETS=("${2:?--target 需要参数}"); shift 2 ;;
    -h|--help) sed -n '1,40p' "$0"; exit 0 ;;
    *) die "未知参数:$1" ;;
  esac
done

require_cmd docker
docker buildx version >/dev/null 2>&1 || die "需要 BuildKit/buildx(Dockerfile 使用了 COPY --parents)。请升级 Docker 到 23+。"

# ---- 决定 tag ----
if [ -z "$TAG" ]; then
  if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
    if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
      TAG="${TAG}-dirty"
      warn "工作区有未提交改动,tag 追加 -dirty。正式发布请先提交。"
    fi
  else
    TAG="$(date -u '+%Y%m%d%H%M%S')"
    warn "非 git 仓库,用时间戳作为 tag:$TAG"
  fi
fi

step "构建配置"
log "镜像前缀:$PREFIX"
log "镜像 tag :$TAG"
log "构建目标:${TARGETS[*]}"

BUILD_ARGS=()
if [ "$ON_SERVER" = "1" ]; then
  warn "=============================================================="
  warn "生产机构建降级模式。请先确认:"
  warn "  1. 已有至少 4GB swap(见 docs/DEPLOYMENT.md「在服务器上构建」),"
  warn "     否则 Next 构建大概率被 OOM Killer 杀掉;"
  warn "  2. 最好在维护窗口内执行:构建会抢占 CPU,接口延迟会上升;"
  warn "  3. 构建串行执行,总耗时可能 15 分钟以上。"
  warn "=============================================================="
  # 限制 BuildKit 并发,降低内存峰值
  BUILD_ARGS+=(--build-arg "BUILDKIT_MAX_PARALLELISM=1")
  export BUILDKIT_PROGRESS=plain
fi

# ---- 逐个 target 构建(串行:避免 4 个 target 同时编译把内存打满)----
for t in "${TARGETS[@]}"; do
  image="${PREFIX}/${t}:${TAG}"
  step "构建 $image(target=$t)"
  docker build \
    --file "$REPO_ROOT/Dockerfile" \
    --target "$t" \
    --tag "$image" \
    --tag "${PREFIX}/${t}:latest" \
    "${BUILD_ARGS[@]}" \
    "$REPO_ROOT"
  ok "$image"
done

# ---- 推送 ----
if [ "$PUSH" = "1" ]; then
  case "$PREFIX" in
    */*) : ;;
    *) die "--push 需要带仓库地址的前缀,例如 JUNE_IMAGE_PREFIX=registry.example.com/june" ;;
  esac
  for t in "${TARGETS[@]}"; do
    step "推送 ${PREFIX}/${t}:${TAG}"
    docker push "${PREFIX}/${t}:${TAG}"
  done
  ok "推送完成"
fi

# ---- 导出 tar(没有镜像仓库时的传输方式)----
if [ "$SAVE" = "1" ]; then
  out_dir="$REPO_ROOT/deploy/images"
  mkdir -p "$out_dir"
  for t in "${TARGETS[@]}"; do
    out="$out_dir/june-${t}-${TAG}.tar.gz"
    step "导出 $out"
    docker save "${PREFIX}/${t}:${TAG}" | gzip -6 >"$out"
    ok "$(human_bytes "$(wc -c <"$out")")  $out"
  done
  log "传到生产机后用:gunzip -c june-api-${TAG}.tar.gz | docker load"
fi

step "完成"
log "接下来在生产机执行:JUNE_IMAGE_TAG=$TAG ./deploy/scripts/deploy.sh"
