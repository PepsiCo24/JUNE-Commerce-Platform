/**
 * 环境配置。启动时一次性校验并冻结,配置错误直接让进程失败而不是运行到一半才报错。
 *
 * 原则:
 *  - 密钥类配置没有默认值。生产环境缺失即启动失败,避免"悄悄用了示例密钥"。
 *  - 所有数值型配置显式给出取值范围。
 *  - 配置对象绝不整体打日志,只在启动时输出脱敏摘要。
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
// 允许在 apps/api 目录内单独放一份覆盖配置(仅本地调试)
for (const candidate of ['.env.local', '.env']) {
  const full = resolve(process.cwd(), candidate);
  if (existsSync(full)) loadDotenv({ path: full, override: false });
}

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** base64 编码的 32 字节密钥 */
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

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    PUBLIC_WEB_ORIGIN: z.url(),
    PUBLIC_API_ORIGIN: z.url(),
    CORS_ALLOWED_ORIGINS: csv,
    COOKIE_DOMAIN: z.string().optional().default(''),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

    API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

    DATABASE_URL: z.string().min(1),
    API_DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    API_DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
    API_DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),

    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
    REDIS_PASSWORD: z.string().optional().default(''),
    REDIS_QUEUE_DB: z.coerce.number().int().min(0).max(15).default(0),
    REDIS_CACHE_DB: z.coerce.number().int().min(0).max(15).default(1),
    QUEUE_PREFIX: z.string().min(1).default('june'),

    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET 至少 32 个字符'),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(168),
    SESSION_IDLE_TIMEOUT_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(72),
    CSRF_SECRET: z.string().min(32, 'CSRF_SECRET 至少 32 个字符'),
    CREDENTIAL_ENCRYPTION_KEY: base64Key32,
    CREDENTIAL_ENCRYPTION_KEY_OLD: csv,
    PROVIDER_SECRET_ENCRYPTION_KEY: base64Key32,
    REAUTH_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    PASSWORD_HASH_MEMORY_KIB: z.coerce.number().int().min(8192).max(1_048_576).default(19_456),
    PASSWORD_HASH_ITERATIONS: z.coerce.number().int().min(1).max(10).default(2),
    PASSWORD_HASH_PARALLELISM: z.coerce.number().int().min(1).max(16).default(1),

    S3_ENDPOINT: z.string().min(1),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: booleanish.default(true),
    S3_PUBLIC_BASE_URL: z.string().optional().default(''),
    S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),
    S3_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
    UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).default(20 * 1024 * 1024),
    DEFAULT_STORAGE_QUOTA_BYTES: z.coerce.number().int().min(1024 * 1024).default(5 * 1024 ** 3),
    ASSET_RECYCLE_DAYS: z.coerce.number().int().min(0).max(365).default(14),
    ASSET_ORPHAN_GRACE_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24),

    CONCURRENCY_IMAGE_GLOBAL: z.coerce.number().int().min(1).max(200).default(5),
    CONCURRENCY_TEXT_GLOBAL: z.coerce.number().int().min(1).max(500).default(10),
    CONCURRENCY_IMAGE_PER_USER_RUNNING: z.coerce.number().int().min(1).max(20).default(1),
    CONCURRENCY_IMAGE_PER_USER_PENDING: z.coerce.number().int().min(1).max(50).default(3),
    CONCURRENCY_IMAGE_PROCESS: z.coerce.number().int().min(1).max(16).default(2),
    QUEUE_MAX_DEPTH_IMAGE: z.coerce.number().int().min(10).default(500),
    QUEUE_MAX_DEPTH_TEXT: z.coerce.number().int().min(10).default(1000),
    TASK_IMAGE_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(300_000),
    TASK_TEXT_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(120_000),

    PROVIDER_URL_ALLOW_PRIVATE_NETWORK: booleanish.default(false),
    MOCK_PROVIDER_ENABLED: booleanish.default(false),
    MOCK_PROVIDER_BASE_URL: z.string().optional().default(''),

    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'verbose']).default('info'),
    SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().min(10).default(300),
    LOG_SQL: booleanish.default(false),
    HEALTH_DETAIL_TOKEN: z.string().optional().default(''),

    RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().min(10).default(600),
    RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).default(10),
    RATE_LIMIT_UPLOAD_PER_MINUTE: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_AI_SUBMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return;

    // 生产环境的额外硬性要求
    if (!value.PUBLIC_WEB_ORIGIN.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_WEB_ORIGIN'],
        message: '生产环境必须使用 HTTPS',
      });
    }
    const weak = ['change-me', 'example', 'secret', 'password'];
    for (const key of ['SESSION_SECRET', 'CSRF_SECRET'] as const) {
      if (weak.some((w) => value[key].toLowerCase().includes(w))) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: '生产环境不得使用模板中的示例密钥,请重新生成',
        });
      }
    }
    if (value.CORS_ALLOWED_ORIGINS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: '生产环境必须显式配置允许的来源',
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | null = null;

export function loadEnv(): AppEnv {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(
      `环境变量校验失败,请对照 .env.example 检查:\n${lines.join('\n')}\n` +
        '提示:密钥可用 `openssl rand -base64 32` 生成。',
    );
  }

  cached = Object.freeze(parsed.data);
  return cached;
}

/** 启动日志用的脱敏摘要,绝不输出任何密钥 */
export function describeEnv(env: AppEnv): Record<string, string | number | boolean> {
  return {
    NODE_ENV: env.NODE_ENV,
    API_PORT: env.API_PORT,
    PUBLIC_WEB_ORIGIN: env.PUBLIC_WEB_ORIGIN,
    corsOrigins: env.CORS_ALLOWED_ORIGINS.join(',') || '(none)',
    dbPoolMax: env.API_DB_POOL_MAX,
    redis: `${env.REDIS_HOST}:${env.REDIS_PORT} queueDb=${env.REDIS_QUEUE_DB} cacheDb=${env.REDIS_CACHE_DB}`,
    s3Bucket: env.S3_BUCKET,
    s3PathStyle: env.S3_FORCE_PATH_STYLE,
    concurrencyImageGlobal: env.CONCURRENCY_IMAGE_GLOBAL,
    concurrencyTextGlobal: env.CONCURRENCY_TEXT_GLOBAL,
    mockProviderEnabled: env.MOCK_PROVIDER_ENABLED,
  };
}

export const ENV_TOKEN = Symbol('JUNE_ENV');
