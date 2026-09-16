/**
 * Worker 环境配置。写法与 apps/api/src/config/env.ts 保持一致:
 * 启动时一次性校验并冻结,配置错误直接让进程退出,而不是跑到一半才炸。
 *
 * 与 API 的差异:
 *  - 只声明 Worker 真正使用的变量(不含会话/CSRF/CORS 等 HTTP 层配置);
 *  - 连接池、语句超时使用 WORKER_* 前缀,与 API 的池分开计入 PostgreSQL 连接预算;
 *  - PROVIDER_SECRET_ENCRYPTION_KEY 是硬性必填:解不出供应商 API Key 就无法调用上游,
 *    宁可启动失败也不要让任务在运行期批量失败。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// monorepo 的真实环境变量放在仓库根目录 .env
for (const candidate of ['../../.env.local', '../../.env']) {
  const full = resolve(process.cwd(), candidate);
  if (existsSync(full)) loadDotenv({ path: full, override: false });
}
// 允许在 apps/worker 目录内单独放一份覆盖配置(仅本地调试)
for (const candidate of ['.env.local', '.env']) {
  const full = resolve(process.cwd(), candidate);
  if (existsSync(full)) loadDotenv({ path: full, override: false });
}

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

/** base64 编码的 32 字节密钥(AES-256-GCM) */
const base64Key32 = z.string().refine(
  (v) => {
    try {
      return Buffer.from(v, 'base64').length === 32;
    } catch {
      return false;
    }
  },
  { message: '必须是 base64 编码的 32 字节密钥,可用 `openssl rand -base64 32` 生成' },
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // ---------- 数据库 ----------
  DATABASE_URL: z.string().min(1),
  WORKER_DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  WORKER_DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
  /** Worker 的语句超时明显长于 API:导入与清理会跑批量语句 */
  WORKER_DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),

  // ---------- Redis ----------
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  REDIS_QUEUE_DB: z.coerce.number().int().min(0).max(15).default(0),
  REDIS_CACHE_DB: z.coerce.number().int().min(0).max(15).default(1),
  QUEUE_PREFIX: z.string().min(1).default('june'),

  // ---------- 对象存储 ----------
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanish.default(true),
  S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),

  // ---------- 存储配额与清理 ----------
  DEFAULT_STORAGE_QUOTA_BYTES: z.coerce.number().int().min(1024 * 1024).default(5 * 1024 ** 3),
  /** 单张转存图片的体积上限,超过视为上游异常,不写入存储 */
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).default(20 * 1024 * 1024),
  ASSET_RECYCLE_DAYS: z.coerce.number().int().min(0).max(365).default(14),
  ASSET_ORPHAN_GRACE_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24),

  // ---------- 并发 ----------
  CONCURRENCY_IMAGE_GLOBAL: z.coerce.number().int().min(1).max(200).default(5),
  CONCURRENCY_TEXT_GLOBAL: z.coerce.number().int().min(1).max(500).default(10),
  CONCURRENCY_IMAGE_PER_USER_RUNNING: z.coerce.number().int().min(1).max(20).default(1),
  CONCURRENCY_IMAGE_PER_USER_PENDING: z.coerce.number().int().min(1).max(50).default(3),
  /** sharp 派生图并发。4 核 8G 单机建议 1~2:sharp 每个实例都会吃掉数十到数百 MB 常驻内存 */
  CONCURRENCY_IMAGE_PROCESS: z.coerce.number().int().min(1).max(16).default(2),
  CONCURRENCY_IMPORT: z.coerce.number().int().min(1).max(8).default(1),
  CONCURRENCY_MAINTENANCE: z.coerce.number().int().min(1).max(8).default(1),

  // ---------- 任务超时与轮询 ----------
  TASK_IMAGE_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(300_000),
  TASK_TEXT_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(120_000),
  PROVIDER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(3_000),
  PROVIDER_POLL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(1_000).default(100),

  // ---------- 密钥 ----------
  PROVIDER_SECRET_ENCRYPTION_KEY: base64Key32,

  // ---------- 运行与可观测性 ----------
  WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  /**
   * 指标端口只监听内网。默认回环地址,容器内需要被同网段抓取时改为 0.0.0.0
   * 并在反向代理/安全组层面限制来源,绝不直接暴露到公网。
   */
  WORKER_METRICS_HOST: z.string().min(1).default('127.0.0.1'),
  /** 优雅停机等待在跑任务的时间上限 */
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  /**
   * 并发闸门计数键的兜底 TTL(秒)。进程被 kill -9 时来不及 release,
   * 靠这个 TTL 保证计数最终会消失,不会永久占位。
   * 必须大于单个任务的最长执行时间,否则会在任务仍在跑时提前放行。
   */
  WORKER_GATE_TTL_SECONDS: z.coerce.number().int().min(60).max(7_200).default(600),
  /** 定时任务分布式锁 TTL(毫秒) */
  WORKER_SCHEDULER_LOCK_MS: z.coerce.number().int().min(1_000).default(30_000),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'verbose']).default('info'),
  SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().min(10).default(300),
  LOG_SQL: booleanish.default(false),
});

export type WorkerEnv = z.infer<typeof envSchema>;

let cached: WorkerEnv | null = null;

export function loadEnv(): WorkerEnv {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(
      `Worker 环境变量校验失败,请对照 .env.example 检查:\n${lines.join('\n')}\n` +
        '提示:密钥可用 `openssl rand -base64 32` 生成。',
    );
  }

  const value = parsed.data;
  if (value.WORKER_GATE_TTL_SECONDS * 1000 < value.TASK_IMAGE_TIMEOUT_MS) {
    throw new Error(
      'WORKER_GATE_TTL_SECONDS 必须不小于 TASK_IMAGE_TIMEOUT_MS,' +
        '否则闸门计数会在任务仍在运行时过期,导致并发超卖。',
    );
  }

  cached = Object.freeze(value);
  return cached;
}

/** 启动日志用的脱敏摘要,绝不输出任何密钥 */
export function describeEnv(env: WorkerEnv): Record<string, string | number | boolean> {
  return {
    NODE_ENV: env.NODE_ENV,
    metrics: `${env.WORKER_METRICS_HOST}:${env.WORKER_METRICS_PORT}`,
    dbPoolMax: env.WORKER_DB_POOL_MAX,
    dbStatementTimeoutMs: env.WORKER_DB_STATEMENT_TIMEOUT_MS,
    redis: `${env.REDIS_HOST}:${env.REDIS_PORT} queueDb=${env.REDIS_QUEUE_DB} cacheDb=${env.REDIS_CACHE_DB}`,
    queuePrefix: env.QUEUE_PREFIX,
    s3Bucket: env.S3_BUCKET,
    concurrencyImageGlobal: env.CONCURRENCY_IMAGE_GLOBAL,
    concurrencyTextGlobal: env.CONCURRENCY_TEXT_GLOBAL,
    concurrencyImageProcess: env.CONCURRENCY_IMAGE_PROCESS,
    gateTtlSeconds: env.WORKER_GATE_TTL_SECONDS,
    shutdownTimeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
  };
}
