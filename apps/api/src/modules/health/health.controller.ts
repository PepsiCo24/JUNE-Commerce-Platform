import { Controller, Get, Headers } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { Public, SkipCsrf } from '../../common/auth/auth.decorators';
import { AppException } from '../../common/errors/app-exception';
import { loadEnv } from '../../config/env';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { QueueProducerService } from '../queue/queue-producer.service';
import { S3Service } from '../storage/s3.service';

/**
 * 健康检查。
 *  - `/health`:存活探针,只确认进程能响应,供容器与 Nginx 使用,永不依赖外部服务。
 *  - `/health/ready`:就绪探针,检查数据库与 Redis,用于发布时判断是否可接流量。
 *  - `/health/detail`:含队列与对象存储的详细状态,需要内部令牌,避免对外暴露拓扑信息。
 *
 * 探针一律 SkipThrottle:否则压测与编排探活会互相抢默认限流额度。
 */
@SkipThrottle()
@Controller('health')
export class HealthController {
  private readonly env = loadEnv();
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queue: QueueProducerService,
    private readonly s3: S3Service,
  ) {}

  @Public()
  @SkipCsrf()
  @Get()
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) };
  }

  @Public()
  @SkipCsrf()
  @Get('ready')
  async ready(): Promise<{
    status: 'ok' | 'degraded';
    checks: Record<string, { ok: boolean; latencyMs: number }>;
  }> {
    const [db, redis] = await Promise.all([this.prisma.ping(), this.redis.ping()]);
    const allOk = db.ok && redis.ok;
    if (!allOk) {
      // 就绪探针失败必须返回非 2xx,否则编排层不会摘流量
      throw AppException.unavailable('依赖服务不可用');
    }
    return { status: 'ok', checks: { database: db, redis } };
  }

  @Public()
  @SkipCsrf()
  @Get('detail')
  async detail(@Headers('x-internal-token') token?: string): Promise<Record<string, unknown>> {
    // 未配置令牌时只允许内网访问(由 Nginx 限制),这里做二次防护:必须显式配置才可用
    if (!this.env.HEALTH_DETAIL_TOKEN || token !== this.env.HEALTH_DETAIL_TOKEN) {
      throw AppException.notFound();
    }

    const [db, redis, storage, queues] = await Promise.all([
      this.prisma.ping(),
      this.redis.ping(),
      this.s3.ping(),
      this.queue.healthSnapshot(),
    ]);

    const memory = process.memoryUsage();

    return {
      status: db.ok && redis.ok ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      nodeVersion: process.version,
      checks: { database: db, redis, storage },
      queues,
      memory: {
        rssMB: Math.round(memory.rss / 1024 / 1024),
        heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
      },
      config: {
        dbPoolMax: this.env.API_DB_POOL_MAX,
        concurrencyImageGlobal: this.env.CONCURRENCY_IMAGE_GLOBAL,
        concurrencyTextGlobal: this.env.CONCURRENCY_TEXT_GLOBAL,
      },
    };
  }
}
