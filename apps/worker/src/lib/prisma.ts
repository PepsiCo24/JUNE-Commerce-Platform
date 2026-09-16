/**
 * Worker 的 Prisma 客户端。
 *
 * 连接池与 API 完全独立(WORKER_DB_POOL_MAX),两者之和需小于 PostgreSQL max_connections
 * 并预留维护余量,见 docs/PERFORMANCE.md 的连接数预算表。
 */
import { createPrismaClient, type JunePrismaClient } from '@june/db';

import { loadEnv } from '../config/env';
import { createLogger } from './logger';

const log = createLogger('prisma');

let client: JunePrismaClient | null = null;

export function getPrisma(): JunePrismaClient {
  if (client) return client;
  const env = loadEnv();
  client = createPrismaClient({
    connectionString: env.DATABASE_URL,
    poolMax: env.WORKER_DB_POOL_MAX,
    idleTimeoutMs: env.WORKER_DB_POOL_IDLE_TIMEOUT_MS,
    statementTimeoutMs: env.WORKER_DB_STATEMENT_TIMEOUT_MS,
    slowQueryThresholdMs: env.SLOW_QUERY_THRESHOLD_MS,
    logQueries: env.LOG_SQL,
    logger: {
      warn: (m: unknown) => log.warn(String(m)),
      debug: (m: unknown) => log.debug(String(m)),
      error: (m: unknown) => log.error(String(m)),
    },
  });
  return client;
}

/** 优雅停机时调用,必须在所有 Worker 关闭之后执行 */
export async function disconnectPrisma(): Promise<void> {
  if (!client) return;
  try {
    await client.$disconnect();
  } catch (err) {
    log.warn(`断开数据库连接失败:${(err as Error).message}`);
  } finally {
    client = null;
  }
}

export async function pingDatabase(): Promise<boolean> {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
