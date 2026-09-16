# syntax=docker/dockerfile:1-labs
# ============================================================================
# JUNE-Commerce-Platform 统一多阶段镜像
# ----------------------------------------------------------------------------
# 一个 Dockerfile 产出 4 个目标:
#   --target web      Next.js standalone 服务(端口 3000)
#   --target api      NestJS 服务(端口 3001)
#   --target worker   BullMQ 消费者(指标端口 3002)
#   --target migrate  运维工具镜像(prisma CLI + tsx),只用于一次性 job:
#                     数据库迁移、管理员初始化、压测数据播种/清理
#
# 为什么需要第 4 个 migrate 目标:
#   三个运行时镜像都经过 `pnpm deploy --prod` 精简,里面没有 prisma CLI、
#   没有 migrations 目录、也没有仓库根的 pnpm 脚本,跑不了 `pnpm db:migrate:deploy`。
#   把迁移放进一个独立的工具镜像,既能保持运行时镜像精简,也避免"API 启动时自动迁移"。
#
# 构建要求:BuildKit(Docker 23+ / docker compose v2 自带)。
#   使用了 `COPY --parents`(dockerfile:1-labs),因此可以用通配符只复制清单文件,
#   在 apps/ 下新增应用时不需要回来改 Dockerfile,同时保住依赖安装的层缓存。
#
# 构建位置:优先在开发机或 CI 构建后推镜像。4 核 8G 的生产机同时跑
#   Next.js 构建 + tsc + prisma generate 很容易 OOM,见 docs/DEPLOYMENT.md
#   「镜像构建」一节的降级方案(加 swap、限制并发、逐个 target 构建)。
# ============================================================================

ARG NODE_VERSION=22.21
# ----------------------------------------------------------------------------
# 基础镜像选择:bookworm-slim(glibc)而不是 alpine(musl)。理由:
#  1. sharp 0.35 官方虽提供 linuxmusl 预编译包,但 libvips 在 musl 默认分配器下
#     长期运行会明显内存碎片化(sharp 官方文档明确建议 glibc,或在 musl 上改用
#     jemalloc)。worker 容器内存限制 1.5G 且长驻做缩略图派生,碎片化直接等于 OOM。
#  2. @node-rs/argon2 是 napi 原生模块,Argon2id 每次校验申请 19MB 内存,
#     同样对分配器敏感,glibc 下行为更可预期。
#  3. Prisma 7 是无 Rust 客户端(driver adapter 走 pg),不存在 openssl/musl
#     引擎兼容问题 —— 这一项两种基础镜像都不受影响。
#  代价:镜像比 alpine 大约 60~80MB。单机部署下这点体积换稳定性是值得的。
#  若确有体积要求,把 NODE_VARIANT 改成 alpine 即可(lockfile 已包含 musl 变体),
#  但必须重新跑一轮 30 分钟混合压测观察 worker RSS 曲线。
# ----------------------------------------------------------------------------
ARG NODE_VARIANT=bookworm-slim
# 与仓库根 package.json 的 packageManager 保持一致,不要单独升级
ARG PNPM_VERSION=12.4.2

# ============================================================================
# base:公共基础层(corepack 锁定 pnpm)
# ============================================================================
FROM node:${NODE_VERSION}-${NODE_VARIANT} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
# corepack 按 packageManager 字段锁版本;这里显式 prepare 把 pnpm 固化进镜像层,
# 避免每次构建都去网络取 pnpm(也避免生产机无外网时构建失败)
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ============================================================================
# deps:只装依赖。改源码不会让这一层失效。
# ============================================================================
FROM base AS deps
# --parents 保留通配符匹配到的原始路径;apps/ 下暂时只有 api 也不会报错
COPY --parents \
    package.json \
    pnpm-lock.yaml \
    pnpm-workspace.yaml \
    .npmrc \
    apps/*/package.json \
    packages/*/package.json \
    ./
# --frozen-lockfile:lockfile 与 package.json 不一致时直接失败,不做静默升级。
# lockfile 里已包含 linux-x64-gnu / musl 全部平台的可选依赖,跨平台安装没问题。
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

# ============================================================================
# build:编译 packages 与 apps
# ============================================================================
FROM deps AS build
# 这里才复制源码(.dockerignore 已排除 node_modules/.next/dist 等)
COPY . .
# Prisma 7 客户端生成到 packages/db/generated(不入库,必须在镜像内生成)
RUN pnpm db:generate
# 根 build 脚本:db:generate -> packages 全量 build -> apps 全量 build
# Next.js 需要 output: 'standalone'(见 docs/DEPLOYMENT.md 前置条件)
ENV NEXT_TELEMETRY_DISABLED=1
RUN NODE_OPTIONS="--max-old-space-size=3072" pnpm build

# ============================================================================
# prune-api / prune-worker:用 pnpm deploy 产出只含生产依赖的运行时目录
# ----------------------------------------------------------------------------
# --legacy:仓库没有开启 inject-workspace-packages,pnpm 10+ 需要显式用 legacy 模式
# --prod  :剔除 devDependencies(tsc / vitest / tsx / prisma CLI 都不进运行时镜像)
#
# 注意:pnpm deploy 复制工作区包时走 npm-packlist 规则,存在漏掉被 .gitignore
# 忽略的构建产物(dist/、packages/db/generated/)的风险。下面显式补齐并断言,
# 宁可构建期失败,也不要交付一个"跑起来才发现没有 dist"的镜像。
# ============================================================================
FROM build AS prune-api
RUN pnpm --filter=@june/api deploy --prod --legacy /out/api
RUN set -eux; \
    mkdir -p /out/api/dist; \
    cp -R /app/apps/api/dist/. /out/api/dist/; \
    for p in shared db providers brand; do \
      target="/out/api/node_modules/@june/$p"; \
      if [ -d "$target" ] && [ -d "/app/packages/$p/dist" ]; then \
        rm -rf "$target/dist"; cp -R "/app/packages/$p/dist" "$target/dist"; \
      fi; \
      if [ -d "$target" ] && [ -d "/app/packages/$p/generated" ]; then \
        rm -rf "$target/generated"; cp -R "/app/packages/$p/generated" "$target/generated"; \
      fi; \
    done; \
    test -f /out/api/dist/main.js; \
    test -f /out/api/node_modules/@june/db/dist/src/index.js; \
    test -d /out/api/node_modules/@june/db/generated/prisma

FROM build AS prune-worker
RUN pnpm --filter=@june/worker deploy --prod --legacy /out/worker
RUN set -eux; \
    mkdir -p /out/worker/dist; \
    cp -R /app/apps/worker/dist/. /out/worker/dist/; \
    for p in shared db providers brand; do \
      target="/out/worker/node_modules/@june/$p"; \
      if [ -d "$target" ] && [ -d "/app/packages/$p/dist" ]; then \
        rm -rf "$target/dist"; cp -R "/app/packages/$p/dist" "$target/dist"; \
      fi; \
      if [ -d "$target" ] && [ -d "/app/packages/$p/generated" ]; then \
        rm -rf "$target/generated"; cp -R "/app/packages/$p/generated" "$target/generated"; \
      fi; \
    done; \
    test -f /out/worker/dist/main.js; \
    test -d /out/worker/node_modules/@june/db/generated/prisma

# ============================================================================
# runner-base:三个运行时镜像的公共底座
#   - 非 root:一律用官方镜像自带的 node 用户(uid/gid 1000)
#   - 不装 curl/wget:HEALTHCHECK 用 node 内置 fetch,少一层攻击面也少几 MB
# ============================================================================
FROM node:${NODE_VERSION}-${NODE_VARIANT} AS runner-base
ENV NODE_ENV=production \
    TZ=UTC \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# /app 交给 node 用户,便于日后挂载临时目录
RUN chown node:node /app
USER node

# ============================================================================
# api
# ============================================================================
FROM runner-base AS api
# 容器内存上限 1.5G(见 docker-compose.yml)。堆上限设 1024MB:
# 留出约 500MB 给 native 内存(pg 连接池、argon2 19MB/次、sharp 元数据)与栈。
ENV NODE_OPTIONS="--max-old-space-size=1024" \
    API_PORT=3001
COPY --from=prune-api --chown=node:node /out/api ./
EXPOSE 3001
# 存活探针用 /health(全局前缀 exclude,且不依赖 DB/Redis,进程活着就返回 200)。
# 就绪探针 /api/health/ready 会打 DB/Redis,由 compose 的 healthcheck 与
# deploy.sh 发布校验使用,不放在容器 HEALTHCHECK 里,避免数据库抖动导致容器被重启。
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "const p=process.env.API_PORT||3001;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ============================================================================
# worker
# ============================================================================
FROM runner-base AS worker
# worker 跑 sharp:libvips 的像素缓存在 native 内存,不占 V8 堆。
# 容器上限 1.5G,堆压到 768MB,把余量留给 libvips,否则 native 分配会先撞上限。
ENV NODE_OPTIONS="--max-old-space-size=768" \
    WORKER_METRICS_PORT=3002 \
    UV_THREADPOOL_SIZE=4
COPY --from=prune-worker --chown=node:node /out/worker ./
EXPOSE 3002
# 契约:apps/worker 必须在 WORKER_METRICS_PORT 上暴露 GET /health(仅进程存活)
HEALTHCHECK --interval=20s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "const p=process.env.WORKER_METRICS_PORT||3002;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ============================================================================
# web(Next.js standalone)
# ----------------------------------------------------------------------------
# monorepo 下 standalone 产物带上了工作区路径,入口是
#   apps/web/.next/standalone/apps/web/server.js
# 因此把 standalone 目录整体摊到 /app,入口就是 /app/apps/web/server.js。
# static 与 public 不在 standalone 里,必须单独复制。
# ============================================================================
FROM runner-base AS web
# 容器上限 700M;Next 16 服务端渲染主要吃堆,设 512MB 留出 native 余量
ENV NODE_OPTIONS="--max-old-space-size=512" \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
EXPOSE 3000
# 只确认 HTTP 服务能响应:5xx 才算不健康(302/401 都属正常业务响应)
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# ============================================================================
# migrate:一次性运维工具镜像(不对外暴露端口、不常驻)
# ----------------------------------------------------------------------------
# 保留完整工作区(含 devDependencies:prisma CLI、tsx)。用法:
#   docker compose --profile migrate run --rm migrate pnpm db:migrate:deploy
#   docker compose --profile migrate run --rm migrate pnpm admin:init
#   docker compose --profile migrate run --rm migrate \
#     pnpm --filter @june/api exec node ... (压测数据播种见 docs/LOAD_TEST.md)
# 这里保持 root:容器生命周期只有几十秒、无监听端口,而 pnpm/prisma 需要对
# /app 有写权限(.prisma 缓存、临时文件);为此 chown 整个 node_modules
# 会多出近 1GB 的镜像层,不值得。
# ============================================================================
FROM build AS migrate
ENV NODE_ENV=production
# 默认动作是查看迁移状态 —— 误启动这个镜像不会改数据库
CMD ["pnpm", "--filter", "@june/db", "migrate:status"]
