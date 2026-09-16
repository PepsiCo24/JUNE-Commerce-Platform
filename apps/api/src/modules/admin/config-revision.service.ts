import { Injectable, Logger } from '@nestjs/common';
import { SSE_CHANNELS, type SseConfigUpdatedEvent } from '@june/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';

/**
 * 配置修订号自增 + SSE 广播。
 *
 * 与 `modules/models` 的 `ModelConfigService.bumpRevision` **语义完全一致**:
 * 共用同一张 `config_revisions` 表(按 scope 分行)与同一个 Redis 频道
 * `SSE_CHANNELS.broadcast`。之所以在 admin 下再放一份极薄的实现,是为了让
 * admin 模块与 models 模块**互不 import**(两者由不同任务并行开发),
 * 耦合点收敛到"同一张表 + 同一个频道"这个数据契约上。
 *
 * 广播内容只有 scope 与版本号,前端收到后自行补拉公开配置——
 * 因此任何密钥都不可能随事件外泄。
 */
export type RevisionScope = 'models' | 'content' | 'share' | 'concurrency' | 'system';

/**
 * SSE 事件的 scope 只有四个取值(见 `SseConfigUpdatedEvent`)。
 * `system` 是纯后台配置,前端没有对应的公开配置可补拉,因此只自增版本号不广播;
 * 涉及并发上限的系统配置由 `AdminConfigService` 额外 bump 一次 `concurrency`。
 */
const SSE_SCOPE: Record<RevisionScope, SseConfigUpdatedEvent['scope'] | null> = {
  models: 'models',
  content: 'content',
  share: 'share',
  concurrency: 'concurrency',
  system: null,
};

@Injectable()
export class ConfigRevisionService {
  private readonly logger = new Logger(ConfigRevisionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** 自增指定 scope 的版本号并广播,返回新版本号 */
  async bumpRevision(scope: RevisionScope, actorId: string | null): Promise<number> {
    const row = await this.prisma.db.configRevision.upsert({
      where: { scope },
      create: { scope, version: 1, updatedBy: actorId },
      update: { version: { increment: 1 }, updatedBy: actorId },
    });

    const sseScope = SSE_SCOPE[scope];
    if (sseScope) {
      await this.broadcast({ type: 'config.updated', scope: sseScope, version: row.version });
    }
    return row.version;
  }

  /** 读取当前版本号(不存在时视为 0,前端据此判断是否需要补拉) */
  async currentVersion(scope: RevisionScope): Promise<number> {
    const row = await this.prisma.db.configRevision.findUnique({ where: { scope } });
    return row?.version ?? 0;
  }

  private async broadcast(event: SseConfigUpdatedEvent): Promise<void> {
    try {
      await this.redis.publisher.publish(SSE_CHANNELS.broadcast, JSON.stringify(event));
    } catch (err) {
      // 广播失败不影响配置写入:前端重连时会用版本号重新对齐
      this.logger.warn(`配置版本广播失败 scope=${event.scope}:${(err as Error).message}`);
    }
  }
}
