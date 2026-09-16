import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaClient, type JunePrismaClient } from '@june/db';

import { loadEnv } from '../../config/env';

/**
 * Prisma 访问服务。
 *
 * API 与 Worker 使用各自独立的连接池,总连接数预算见 docs/PERFORMANCE.md。
 * Prisma 7 的客户端经 $extends 包装,因此这里暴露 `db` 而不是继承 PrismaClient。
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  readonly db: JunePrismaClient;

  constructor() {
    const env = loadEnv();
    this.db = createPrismaClient({
      connectionString: env.DATABASE_URL,
      poolMax: env.API_DB_POOL_MAX,
      idleTimeoutMs: env.API_DB_POOL_IDLE_TIMEOUT_MS,
      statementTimeoutMs: env.API_DB_STATEMENT_TIMEOUT_MS,
      slowQueryThresholdMs: env.SLOW_QUERY_THRESHOLD_MS,
      logQueries: env.LOG_SQL,
      logger: {
        warn: (msg: string) => this.logger.warn(msg),
        debug: (msg: string) => this.logger.debug(msg),
        error: (msg: string) => this.logger.error(msg),
      },
    });
  }

  async onModuleInit(): Promise<void> {
    // 启动即建立连接,让配置错误在启动阶段就暴露,而不是首个请求才失败
    await this.db.$queryRaw`SELECT 1`;
    this.logger.log(`数据库连接就绪(池上限 ${loadEnv().API_DB_POOL_MAX})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
  }

  /** 健康检查用的轻量探测 */
  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const startedAt = Date.now();
    try {
      await this.db.$queryRaw`SELECT 1`;
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch {
      return { ok: false, latencyMs: Date.now() - startedAt };
    }
  }
}
