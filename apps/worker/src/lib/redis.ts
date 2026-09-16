/**
 * Worker 的 Redis 连接。职责分离与 apps/api 的 RedisService 保持一致:
 *
 *  - queue:BullMQ 专用(db=REDIS_QUEUE_DB)。BullMQ 依赖阻塞命令(BRPOPLPUSH 等),
 *    **必须** maxRetriesPerRequest: null,否则长时间阻塞会被 ioredis 判定为超时并报错。
 *  - cache:并发闸门计数器与分布式锁(db=REDIS_CACHE_DB)。
 *  - publisher:SSE 事件发布(db=REDIS_CACHE_DB,与 API 的 subscriber 同库才能收到)。
 *
 * 三条连接分开,避免闸门计数被 BullMQ 的阻塞命令拖住。
 */
import Redis, { type RedisOptions } from 'ioredis';

import { loadEnv } from '../config/env';
import { createLogger } from './logger';

const log = createLogger('redis');

interface Connections {
  queue: Redis;
  cache: Redis;
  publisher: Redis;
}

let conns: Connections | null = null;

function baseOptions(): RedisOptions {
  const env = loadEnv();
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    // Docker Compose 只绑 127.0.0.1;避免 macOS 上 localhost→::1 连不上
    family: 4,
    ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    connectionName: 'june-worker',
  };
}

export function getRedis(): Connections {
  if (conns) return conns;
  const env = loadEnv();
  const base = baseOptions();

  const queue = new Redis({
    ...base,
    db: env.REDIS_QUEUE_DB,
    // BullMQ 硬性要求:阻塞命令不能被请求级重试上限打断
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  });
  const cache = new Redis({
    ...base,
    db: env.REDIS_CACHE_DB,
    maxRetriesPerRequest: 3,
    // 闸门读写宁可快速失败(按"取不到闸门"处理并延迟重排),也不要在恢复瞬间雪崩
    enableOfflineQueue: false,
  });
  const publisher = new Redis({
    ...base,
    db: env.REDIS_CACHE_DB,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false,
  });

  for (const [name, client] of Object.entries({ queue, cache, publisher })) {
    client.on('error', (err: Error) => log.error(`Redis[${name}] 错误:${err.message}`));
  }

  conns = { queue, cache, publisher };
  return conns;
}

/** BullMQ 的 Worker/Queue 共用这条连接,避免每个队列各开一条把连接数打满 */
export function queueConnection(): Redis {
  return getRedis().queue;
}

export function cacheConnection(): Redis {
  return getRedis().cache;
}

export function publisherConnection(): Redis {
  return getRedis().publisher;
}

export async function pingRedis(): Promise<boolean> {
  try {
    const client = getRedis().cache;
    if (client.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Redis ready timeout'));
        }, 5_000);
        const cleanup = () => {
          clearTimeout(timer);
          client.off('ready', onReady);
          client.off('error', onError);
        };
        client.once('ready', onReady);
        client.once('error', onError);
      });
    }
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

/** 优雅停机:必须在所有 BullMQ Worker close 之后调用 */
export async function disconnectRedis(): Promise<void> {
  if (!conns) return;
  const { queue, cache, publisher } = conns;
  conns = null;
  await Promise.allSettled([queue.quit(), cache.quit(), publisher.quit()]);
}

// ---------------------------------------------------------------------------
// 分布式锁:定时任务在多实例下只允许一个执行
// ---------------------------------------------------------------------------

export async function acquireLock(key: string, ttlMs: number): Promise<string | null> {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const ok = await cacheConnection().set(key, token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? token : null;
  } catch (err) {
    log.warn(`获取锁失败 ${key}: ${(err as Error).message}`);
    return null;
  }
}

const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

export async function releaseLock(key: string, token: string): Promise<void> {
  try {
    await cacheConnection().eval(RELEASE_LOCK_SCRIPT, 1, key, token);
  } catch (err) {
    log.warn(`释放锁失败 ${key}: ${(err as Error).message}`);
  }
}

/** 在锁保护下执行。拿不到锁直接跳过(说明别的实例正在跑),不排队等待。 */
export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const token = await acquireLock(key, ttlMs);
  if (!token) return null;
  try {
    return await fn();
  } finally {
    await releaseLock(key, token);
  }
}
