import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  SSE_CHANNELS,
  SSE_EVENT_TYPES,
  userSseChannel,
  type SseEvent,
  type SseEventType,
  type SseTaskUpdatedEvent,
} from '@june/shared';

import { RedisService } from '../../infra/redis/redis.service';
import { ModelConfigService } from '../models/model-config.service';

/** 单个用户允许的并发 SSE 连接数(单实例内)。防止前端 bug 反复建连把连接打爆。 */
export const MAX_CONNECTIONS_PER_USER = 5;

export type ChannelListener = (event: SseEvent) => void;

/** 广播频道上允许下发的事件类型。配置类事件只带版本号。 */
const BROADCAST_ALLOWED: ReadonlySet<SseEventType> = new Set<SseEventType>([
  'config.updated',
  'post.updated',
  'comment.updated',
]);

/** 用户定向频道上允许下发的事件类型 */
const USER_ALLOWED: ReadonlySet<SseEventType> = new Set<SseEventType>([
  'task.updated',
  'storage.updated',
  'session.invalidated',
  'config.updated',
]);

/**
 * SSE 事件中枢。
 *
 * 核心问题:ioredis 的 subscriber 连接是**进程级共享**的,
 * 如果每条 HTTP 连接各自 `subscribe()` 并各自挂 `message` 监听器,
 * 会出现两个致命问题:
 *   1. 某条连接断开时调用 `unsubscribe(channel)`,会把同频道其他连接一起断掉;
 *   2. 每条连接一个 message 监听器,50 个在线用户就是 50 个监听器重复解析同一条消息,
 *      并且 Node 会打出 MaxListenersExceeded 警告。
 *
 * 解决办法:进程内维护一张 fan-out 注册表 Map<channel, Set<listener>>,
 * **每个频道只向 Redis 订阅一次**,消息到达后在进程内分发给该频道的所有监听器;
 * 最后一个监听器移除时才真正 unsubscribe。
 */
@Injectable()
export class SseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SseService.name);

  /** 频道 -> 该频道的所有监听器 */
  private readonly listeners = new Map<string, Set<ChannelListener>>();
  /** 用户 -> 当前连接数 */
  private readonly connectionCounts = new Map<string, number>();
  /** 单次注册的 Redis message 处理器 */
  private readonly onMessage = (channel: string, payload: string): void => this.dispatch(channel, payload);

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ModelConfigService) private readonly models: ModelConfigService,
  ) {}

  onModuleInit(): void {
    // 整个进程只挂一个 message 监听器,分发交给注册表
    this.redis.subscriber.on('message', this.onMessage);
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.subscriber.off('message', this.onMessage);
    const channels = [...this.listeners.keys()];
    this.listeners.clear();
    this.connectionCounts.clear();
    if (channels.length > 0) {
      try {
        await this.redis.subscriber.unsubscribe(...channels);
      } catch (err) {
        this.logger.warn(`关闭时取消订阅失败:${(err as Error).message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // fan-out 注册表
  // ---------------------------------------------------------------------------

  /**
   * 订阅一个频道。返回取消订阅的函数,**调用方必须在连接关闭时调用它**,
   * 否则监听器会一直留在 Map 里造成内存泄漏。
   */
  async subscribe(channel: string, listener: ChannelListener): Promise<() => Promise<void>> {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      // 该频道的第一个监听器:此时才真正向 Redis 订阅
      try {
        await this.redis.subscriber.subscribe(channel);
      } catch (err) {
        this.listeners.delete(channel);
        throw err;
      }
    }
    set.add(listener);

    let released = false;
    return async (): Promise<void> => {
      if (released) return;
      released = true;

      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size > 0) return;

      // 最后一个监听器走了才断开频道,不会误伤同频道的其他连接
      this.listeners.delete(channel);
      try {
        await this.redis.subscriber.unsubscribe(channel);
      } catch (err) {
        this.logger.warn(`取消订阅 ${channel} 失败:${(err as Error).message}`);
      }
    };
  }

  private dispatch(channel: string, payload: string): void {
    const set = this.listeners.get(channel);
    if (!set || set.size === 0) return;

    let event: SseEvent;
    try {
      const parsed: unknown = JSON.parse(payload);
      const normalized = this.normalize(channel, parsed);
      if (!normalized) return;
      event = normalized;
    } catch (err) {
      this.logger.warn(`丢弃无法解析的事件(${channel}):${(err as Error).message}`);
      return;
    }

    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        // 单条连接写失败不能影响同频道的其他连接
        this.logger.warn(`事件分发失败:${(err as Error).message}`);
      }
    }
  }

  /**
   * 出站白名单。
   *
   * 只允许已知类型通过,并且按频道区分可下发的类型:
   * 广播频道不得携带任务事件(那是用户私有数据),
   * 配置事件只保留版本号相关字段,**绝不会把密钥或系统提示词带出去**。
   */
  private normalize(channel: string, raw: unknown): SseEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as { type?: unknown };
    const type = candidate.type;
    if (typeof type !== 'string' || !SSE_EVENT_TYPES.includes(type as SseEventType)) return null;

    const isBroadcast = channel === SSE_CHANNELS.broadcast;
    const allowed = isBroadcast ? BROADCAST_ALLOWED : USER_ALLOWED;
    if (!allowed.has(type as SseEventType)) {
      this.logger.warn(`频道 ${channel} 上出现不允许的事件类型 ${type},已丢弃`);
      return null;
    }

    if (type === 'config.updated') {
      const source = raw as { scope?: unknown; version?: unknown; disabledModelIds?: unknown };
      if (typeof source.scope !== 'string' || typeof source.version !== 'number') return null;
      // 显式重建对象:即使上游多塞了字段也不会被透传出去
      return {
        type: 'config.updated',
        scope: source.scope as 'models' | 'content' | 'share' | 'concurrency',
        version: source.version,
        ...(Array.isArray(source.disabledModelIds)
          ? { disabledModelIds: source.disabledModelIds.filter((v): v is string => typeof v === 'string') }
          : {}),
      };
    }

    return raw as SseEvent;
  }

  // ---------------------------------------------------------------------------
  // 连接数限制
  // ---------------------------------------------------------------------------

  /** 占用一个连接名额。超出上限返回 false,由控制器返回 429。 */
  acquireConnection(userId: string): boolean {
    const current = this.connectionCounts.get(userId) ?? 0;
    if (current >= MAX_CONNECTIONS_PER_USER) return false;
    this.connectionCounts.set(userId, current + 1);
    return true;
  }

  releaseConnection(userId: string): void {
    const current = this.connectionCounts.get(userId) ?? 0;
    if (current <= 1) this.connectionCounts.delete(userId);
    else this.connectionCounts.set(userId, current - 1);
  }

  connectionCount(userId: string): number {
    return this.connectionCounts.get(userId) ?? 0;
  }

  /** 运维观测:当前实例的连接与订阅规模 */
  stats(): { channels: number; listeners: number; users: number; connections: number } {
    let listeners = 0;
    for (const set of this.listeners.values()) listeners += set.size;
    let connections = 0;
    for (const count of this.connectionCounts.values()) connections += count;
    return {
      channels: this.listeners.size,
      listeners,
      users: this.connectionCounts.size,
      connections,
    };
  }

  // ---------------------------------------------------------------------------
  // 发布
  // ---------------------------------------------------------------------------

  /**
   * 定向推送任务事件。
   *
   * 正常链路里 Worker 会直接往 Redis 发,API 侧只负责订阅转发;
   * 这个方法供 API 内部(例如提交后的即时反馈)使用。
   */
  async publishTaskUpdate(userId: string, event: SseTaskUpdatedEvent): Promise<void> {
    await this.publishToUser(userId, event);
  }

  async publishToUser(userId: string, event: SseEvent): Promise<void> {
    try {
      await this.redis.publisher.publish(userSseChannel(userId), JSON.stringify(event));
    } catch (err) {
      // 推送失败不影响主业务:前端有轮询兜底,重连时也会重新对齐
      this.logger.warn(`用户事件推送失败 user=${userId}: ${(err as Error).message}`);
    }
  }

  async publishBroadcast(event: SseEvent): Promise<void> {
    try {
      await this.redis.publisher.publish(SSE_CHANNELS.broadcast, JSON.stringify(event));
    } catch (err) {
      this.logger.warn(`广播事件推送失败:${(err as Error).message}`);
    }
  }

  /** 建连时下发的各 scope 配置版本,前端据此判断是否需要补拉 */
  async currentConfigVersions(): Promise<Record<string, number>> {
    return this.models.getAllRevisions();
  }
}
