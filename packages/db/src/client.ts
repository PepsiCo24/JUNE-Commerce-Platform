/**
 * Prisma 客户端工厂。
 *
 * 设计要点:
 *  - Prisma 7 使用无 Rust 客户端 + driver adapter,连接池由 pg 直接管理,
 *    因此 API 与 Worker 可以各自配置独立的池大小(见 docs/PERFORMANCE.md 连接数预算)。
 *  - 通过客户端扩展统一记录慢查询,避免线上出现全表扫描却无人发现。
 *  - 不在此处读取 .env:环境加载由各应用的配置模块负责,保证配置来源单一。
 */
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';

export interface PrismaClientOptions {
  /** PostgreSQL 连接串 */
  connectionString: string;
  /** 连接池上限。API 与 Worker 分别配置,总和需小于 PostgreSQL max_connections 并预留维护余量 */
  poolMax?: number;
  /** 空闲连接回收时间(毫秒) */
  idleTimeoutMs?: number;
  /** 建立连接超时(毫秒) */
  connectionTimeoutMs?: number;
  /** 单条语句超时(毫秒),防止慢查询长期占用连接 */
  statementTimeoutMs?: number;
  /** 慢查询日志阈值(毫秒) */
  slowQueryThresholdMs?: number;
  /** 是否输出每条 SQL(仅开发环境) */
  logQueries?: boolean;
  /** 日志出口,便于接入应用自身的 logger */
  logger?: Pick<Console, 'warn' | 'debug' | 'error'>;
}

export function createPrismaClient(options: PrismaClientOptions) {
  const {
    connectionString,
    poolMax = 10,
    idleTimeoutMs = 30_000,
    connectionTimeoutMs = 10_000,
    statementTimeoutMs = 15_000,
    slowQueryThresholdMs = 300,
    logQueries = false,
    logger = console,
  } = options;

  const adapter = new PrismaPg({
    connectionString,
    max: poolMax,
    idleTimeoutMillis: idleTimeoutMs,
    connectionTimeoutMillis: connectionTimeoutMs,
    statement_timeout: statementTimeoutMs,
    // 避免忘记提交的事务长期持有行锁
    idle_in_transaction_session_timeout: Math.max(statementTimeoutMs * 2, 30_000),
    application_name: 'june-platform',
  });

  const base = new PrismaClient({
    adapter,
    log: logQueries ? ['warn', 'error', 'info'] : ['warn', 'error'],
  });

  return base.$extends({
    name: 'june-slow-query-logger',
    query: {
      async $allOperations({ model, operation, args, query }) {
        const startedAt = process.hrtime.bigint();
        try {
          return await query(args);
        } finally {
          const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
          if (durationMs >= slowQueryThresholdMs) {
            logger.warn(
              `[prisma:slow] ${model ?? 'raw'}.${operation} ${durationMs.toFixed(1)}ms ` +
                `threshold=${slowQueryThresholdMs}ms`,
            );
          } else if (logQueries) {
            logger.debug(`[prisma] ${model ?? 'raw'}.${operation} ${durationMs.toFixed(1)}ms`);
          }
        }
      },
    },
  });
}

/** 应用中注入使用的客户端类型(已带扩展) */
export type JunePrismaClient = ReturnType<typeof createPrismaClient>;

/**
 * 事务客户端类型。扩展后的客户端在 $transaction 回调里拿到的是未扩展的基础类型,
 * 业务代码需要同时接受两者时使用该联合类型。
 */
export type JuneTransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
