import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';

import { loadEnv } from '../../config/env';

/**
 * Redis 访问服务。
 *
 * 连接职责分离,避免相互干扰:
 *  - cache:业务缓存与计数器(db=REDIS_CACHE_DB,配 TTL,允许 LRU 淘汰)
 *  - queue:BullMQ 使用(db=REDIS_QUEUE_DB,必须 noeviction,不能被缓存挤掉任务)
 *  - subscriber:订阅模式下的连接无法执行普通命令,必须独占一条
 *  - publisher:发布用普通连接
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  readonly cache: Redis;
  readonly queue: Redis;
  readonly publisher: Redis;
  readonly subscriber: Redis;

  constructor() {
    const env = loadEnv();
    const base: RedisOptions = {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      family: 4,
      ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
      // 连接不可用时快速失败,由上层决定降级策略,而不是无限排队
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
      // 断线期间的命令不入队,避免恢复瞬间的雪崩
      enableOfflineQueue: false,
      connectionName: 'june-api',
    };

    this.cache = new Redis({ ...base, db: env.REDIS_CACHE_DB });
    this.queue = new Redis({ ...base, db: env.REDIS_QUEUE_DB, maxRetriesPerRequest: null });
    this.publisher = new Redis({ ...base, db: env.REDIS_CACHE_DB });
    this.subscriber = new Redis({ ...base, db: env.REDIS_CACHE_DB, enableOfflineQueue: true });

    for (const [name, client] of Object.entries({
      cache: this.cache,
      queue: this.queue,
      publisher: this.publisher,
      subscriber: this.subscriber,
    })) {
      client.on('error', (err: Error) => this.logger.error(`Redis[${name}] 错误:${err.message}`));
    }
  }

  async onModuleInit(): Promise<void> {
    await Promise.all([this.cache.ping(), this.queue.ping()]);
    this.logger.log('Redis 连接就绪');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this.cache.quit(),
      this.queue.quit(),
      this.publisher.quit(),
      this.subscriber.quit(),
    ]);
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const startedAt = Date.now();
    try {
      await this.cache.ping();
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch {
      return { ok: false, latencyMs: Date.now() - startedAt };
    }
  }

  // -------------------------------------------------------------------------
  // 缓存辅助。所有缓存都必须带 TTL,防止无界增长。
  // 注意:权限判定与模型停用状态**不允许**依赖可能过期的缓存放行,
  //      这类判断一律回源数据库,详见 ModelResolverService。
  // -------------------------------------------------------------------------

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.cache.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      // 缓存故障不应导致业务失败,降级为"未命中"
      this.logger.warn(`缓存读取失败 ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.cache.set(key, JSON.stringify(value), 'EX', Math.max(1, ttlSeconds));
    } catch (err) {
      this.logger.warn(`缓存写入失败 ${key}: ${(err as Error).message}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.cache.del(...keys);
    } catch (err) {
      this.logger.warn(`缓存删除失败: ${(err as Error).message}`);
    }
  }

  /** 按前缀批量失效。使用 SCAN 而非 KEYS,避免阻塞 Redis。 */
  async delByPrefix(prefix: string): Promise<number> {
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await this.cache.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) {
        deleted += await this.cache.del(...keys);
      }
    } while (cursor !== '0');
    return deleted;
  }

  /**
   * 固定窗口计数器,用于限流与并发闸门。
   * 返回自增后的计数值。
   */
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const pipeline = this.cache.multi();
    pipeline.incr(key);
    pipeline.expire(key, Math.max(1, ttlSeconds), 'NX');
    const results = await pipeline.exec();
    const value = results?.[0]?.[1];
    return typeof value === 'number' ? value : Number(value ?? 0);
  }

  /**
   * 简易分布式锁(SET NX PX)。用于"同一时刻只跑一次"的定时任务与清理作业。
   * 返回锁令牌,释放时需带令牌校验,避免误释放他人的锁。
   */
  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ok = await this.cache.set(key, token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? token : null;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    // Lua 保证"比对 + 删除"的原子性
    const script = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end`;
    try {
      await this.cache.eval(script, 1, key, token);
    } catch (err) {
      this.logger.warn(`释放锁失败 ${key}: ${(err as Error).message}`);
    }
  }
}
