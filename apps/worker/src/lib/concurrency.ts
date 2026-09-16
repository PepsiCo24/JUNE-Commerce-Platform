/**
 * 全局并发闸门。
 *
 * 为什么不能只靠 BullMQ 的 `concurrency`:
 *   BullMQ 的 concurrency 是**单个 Worker 进程内**的并发上限。生产上可能起多个 Worker
 *   进程/容器,进程内限制相加就会突破"全站同时 5 个生图"的约定,直接体现为上游账单超支。
 *   因此真正的闸门放在 Redis:所有实例对同一个计数键做 INCR/DECR,天然覆盖全部实例。
 *
 * 键名全部来自 @june/shared 的 CONCURRENCY_KEYS(契约唯一来源,不在这里另起字符串)。
 *
 * 三重防漏设计:
 *   1. try/finally 里 releaseAll():正常路径与异常路径都会归还;
 *   2. 兜底 TTL(WORKER_GATE_TTL_SECONDS):进程被 kill -9 来不及归还时,计数最终过期消失;
 *      TTL 必须大于单任务最长执行时间(env.ts 里已强制校验),否则会在任务仍在跑时提前放行;
 *   3. 启动时 reconcileGates():用数据库里 status=RUNNING 的真实任务数重置计数,
 *      彻底消除崩溃重启带来的计数漂移(见 gate-reconcile.ts)。
 */
import { CONCURRENCY_KEYS } from '@june/shared';

import { loadEnv } from '../config/env';
import { createLogger } from './logger';
import { cacheConnection } from './redis';

const log = createLogger('gate');

/** 闸门只需要这几个 Redis 命令。抽成接口便于单元测试用内存实现替换。 */
export interface GateClient {
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  set(key: string, value: string | number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  scan(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
}

export type GateKind = 'image' | 'text';

/** 供应商频率窗口固定为 1 分钟,键上带分钟桶编号,过期时间给 120s 覆盖跨桶读取 */
const RATE_WINDOW_TTL_SECONDS = 120;

export function currentMinuteBucket(now = Date.now()): number {
  return Math.floor(now / 60_000);
}

/** 距离当前分钟桶结束还有多少毫秒(限流时的建议等待时长) */
export function msUntilNextMinute(now = Date.now()): number {
  return 60_000 - (now % 60_000);
}

export type RateAcquireResult = { ok: true } | { ok: false; waitMs: number };

export class ConcurrencyGates {
  constructor(
    private readonly client: GateClient,
    /** 计数键的兜底 TTL(秒) */
    private readonly ttlSeconds: number,
  ) {}

  // -------------------------------------------------------------------------
  // 全局(覆盖所有 Worker 实例)
  // -------------------------------------------------------------------------

  private globalKey(kind: GateKind): string {
    return kind === 'image' ? CONCURRENCY_KEYS.imageGlobalRunning : CONCURRENCY_KEYS.textGlobalRunning;
  }

  /**
   * 取全局闸门:INCR 计数键,超限则 DECR 回滚并返回 false。
   * 成功时给键续一个兜底 TTL,防止进程崩溃后计数永久泄漏把队列卡死。
   */
  async tryAcquireGlobal(kind: GateKind, limit: number): Promise<boolean> {
    return this.tryAcquireCounter(this.globalKey(kind), limit);
  }

  async release(kind: GateKind): Promise<void> {
    await this.decrWithFloor(this.globalKey(kind));
  }

  // -------------------------------------------------------------------------
  // 每用户
  // -------------------------------------------------------------------------

  async tryAcquireUser(userId: string, limit: number): Promise<boolean> {
    return this.tryAcquireCounter(CONCURRENCY_KEYS.imageUserRunning(userId), limit);
  }

  async releaseUser(userId: string): Promise<void> {
    await this.decrWithFloor(CONCURRENCY_KEYS.imageUserRunning(userId));
  }

  // -------------------------------------------------------------------------
  // 供应商并发
  // -------------------------------------------------------------------------

  /** max <= 0 表示该供应商不额外限并发(只受全局限制),见 ModelProvider.maxConcurrency 注释 */
  async tryAcquireProviderConcurrency(providerSlug: string, max: number): Promise<boolean> {
    if (max <= 0) return true;
    return this.tryAcquireCounter(CONCURRENCY_KEYS.providerRunning(providerSlug), max);
  }

  async releaseProviderConcurrency(providerSlug: string, max: number): Promise<void> {
    if (max <= 0) return;
    await this.decrWithFloor(CONCURRENCY_KEYS.providerRunning(providerSlug));
  }

  // -------------------------------------------------------------------------
  // 供应商频率(按分钟桶)
  // -------------------------------------------------------------------------

  /**
   * 取一次供应商频率配额。
   *
   * **重要**:批量任务被 countUpstreamCalls 拆成多次上游调用时,
   * 每一次调用都要单独调用本方法计入,不能整个任务只算一次——否则一个 8 张的任务
   * 在 maxOutputsPerCall=1 的模型上会偷偷发出 8 次请求而只占 1 次配额。
   *
   * perMinute <= 0 表示不限。超限时把刚才 INCR 的名额 DECR 回去
   * (被拒绝的尝试不应占用配额,否则重试会把窗口彻底吃满导致饿死),
   * 并返回建议等待毫秒数。
   */
  async tryAcquireProviderRate(providerSlug: string, perMinute: number): Promise<RateAcquireResult> {
    if (perMinute <= 0) return { ok: true };

    const now = Date.now();
    const key = CONCURRENCY_KEYS.providerRateWindow(providerSlug, currentMinuteBucket(now));
    const count = await this.client.incr(key);
    await this.client.expire(key, RATE_WINDOW_TTL_SECONDS);

    if (count > perMinute) {
      await this.client.decr(key);
      return { ok: false, waitMs: msUntilNextMinute(now) };
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 计数原语
  // -------------------------------------------------------------------------

  private async tryAcquireCounter(key: string, limit: number): Promise<boolean> {
    const count = await this.client.incr(key);
    if (count > limit) {
      await this.client.decr(key);
      // 超限时也刷一次 TTL,避免"计数卡在上限且永不过期"
      await this.client.expire(key, this.ttlSeconds);
      return false;
    }
    await this.client.expire(key, this.ttlSeconds);
    return true;
  }

  /** DECR 带下限 0 保护:计数不允许变成负数,否则会放行超过上限的任务 */
  private async decrWithFloor(key: string): Promise<number> {
    const value = await this.client.decr(key);
    if (value < 0) {
      await this.client.set(key, 0);
      await this.client.expire(key, this.ttlSeconds);
      return 0;
    }
    await this.client.expire(key, this.ttlSeconds);
    return value;
  }

  async read(key: string): Promise<number> {
    const raw = await this.client.get(key);
    const value = Number(raw ?? 0);
    return Number.isFinite(value) ? value : 0;
  }

  /** 崩溃恢复用:把计数直接设为权威值 */
  async reset(key: string, value: number): Promise<void> {
    if (value <= 0) {
      await this.client.del(key);
      return;
    }
    await this.client.set(key, value);
    await this.client.expire(key, this.ttlSeconds);
  }

  /** SCAN 出符合前缀的闸门键(不用 KEYS,避免阻塞 Redis) */
  async scanKeys(pattern: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      found.push(...keys);
    } while (cursor !== '0');
    return found;
  }

  async drop(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.client.del(...keys);
  }
}

// ---------------------------------------------------------------------------
// 进程内单例
// ---------------------------------------------------------------------------

let singleton: ConcurrencyGates | null = null;

export function gates(): ConcurrencyGates {
  if (!singleton) {
    const env = loadEnv();
    singleton = new ConcurrencyGates(cacheConnection() as unknown as GateClient, env.WORKER_GATE_TTL_SECONDS);
  }
  return singleton;
}

// ---------------------------------------------------------------------------
// 会话式持有:保证 finally 里一次性归还全部闸门
// ---------------------------------------------------------------------------

type ReleaseFn = () => Promise<void>;

/**
 * 一次任务处理期间持有的闸门集合。
 *
 * 使用方式固定为:
 * ```ts
 * const held = new GateSession();
 * try { ...; } finally { await held.releaseAll(); }
 * ```
 * 任何提前 return / 抛错 / 重排都会走到 finally,因此并发计数不会泄漏。
 */
export class GateSession {
  private readonly releases: ReleaseFn[] = [];
  private released = false;

  constructor(private readonly gate: ConcurrencyGates = gates()) {}

  async acquireGlobal(kind: GateKind, limit: number): Promise<boolean> {
    const ok = await this.gate.tryAcquireGlobal(kind, limit);
    if (ok) this.releases.push(() => this.gate.release(kind));
    return ok;
  }

  async acquireUser(userId: string, limit: number): Promise<boolean> {
    const ok = await this.gate.tryAcquireUser(userId, limit);
    if (ok) this.releases.push(() => this.gate.releaseUser(userId));
    return ok;
  }

  async acquireProviderConcurrency(providerSlug: string, max: number): Promise<boolean> {
    const ok = await this.gate.tryAcquireProviderConcurrency(providerSlug, max);
    if (ok && max > 0) {
      this.releases.push(() => this.gate.releaseProviderConcurrency(providerSlug, max));
    }
    return ok;
  }

  /** 频率配额是"按分钟桶消耗"的,用完即止,不需要归还 */
  acquireProviderRate(providerSlug: string, perMinute: number): Promise<RateAcquireResult> {
    return this.gate.tryAcquireProviderRate(providerSlug, perMinute);
  }

  async releaseAll(): Promise<void> {
    if (this.released) return;
    this.released = true;
    // 逆序归还,并且逐个 catch:任何一个失败都不能影响其余闸门归还
    for (const release of this.releases.reverse()) {
      try {
        await release();
      } catch (err) {
        log.error('归还并发闸门失败(将由兜底 TTL 与启动对账修正)', err);
      }
    }
    this.releases.length = 0;
  }

  get heldCount(): number {
    return this.releases.length;
  }
}
