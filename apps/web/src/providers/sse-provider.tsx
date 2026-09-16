'use client';

import {
  SSE_FALLBACK_POLL_MS,
  SSE_PATH,
  SSE_RECONNECT_BASE_MS,
  SSE_RECONNECT_MAX_MS,
  type SseEvent,
  type SseEventType,
} from '@june/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useAuth } from './auth-provider';

/**
 * SSE 连接管理。
 *
 * 需求要点与实现对应:
 *  - "每标签页复用一条 SSE 连接":Provider 挂在根布局,全局只建一条 EventSource,
 *    页面通过 subscribe 注册回调,不各自建连接。
 *  - "重连后获取最新版本":连接建立时服务端下发 configVersions,前端与本地版本比对,
 *    落后就补拉公开配置;因此即使断线期间漏掉事件也能对齐。
 *  - "配置同步目标 2 秒":事件只带版本号,收到后立即补拉,链路短。
 *  - "低频轮询降级":连续重连失败达到阈值后,改为 SSE_FALLBACK_POLL_MS 间隔轮询,
 *    并对外暴露 transport 状态,页面可提示"实时更新暂不可用"。
 *  - 未登录不建立连接(SSE 需要会话做权限隔离)。
 */

type Listener = (event: SseEvent) => void;

export type SseTransport = 'connecting' | 'sse' | 'polling' | 'offline';

interface SseContextValue {
  transport: SseTransport;
  /** 各 scope 的最新配置版本。页面可用它作为 query key 的一部分实现"版本变则重取" */
  configVersions: Record<string, number>;
  /** 被停用的模型 id。选中的模型在其中时应清除选择并提示 */
  disabledModelIds: string[];
  /** 订阅事件。返回取消订阅函数。type 为 '*' 时接收全部事件。 */
  subscribe: (type: SseEventType | '*', listener: Listener) => () => void;
  /** 手动清除已消费的停用提示 */
  acknowledgeDisabledModels: () => void;
  lastEventAt: number | null;
}

const SseContext = createContext<SseContextValue | null>(null);

/** 连续失败多少次后降级为轮询 */
const MAX_SSE_ATTEMPTS = 4;

export function SseProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { isAuthenticated } = useAuth();
  const [transport, setTransport] = useState<SseTransport>('connecting');
  const [configVersions, setConfigVersions] = useState<Record<string, number>>({});
  const [disabledModelIds, setDisabledModelIds] = useState<string[]>([]);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  /** type -> 回调集合。用 ref 保存,订阅变化不触发重连。 */
  const listenersRef = useRef(new Map<SseEventType | '*', Set<Listener>>());
  const sourceRef = useRef<EventSource | null>(null);
  const attemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const subscribe = useCallback<SseContextValue['subscribe']>((type, listener) => {
    const map = listenersRef.current;
    let set = map.get(type);
    if (!set) {
      set = new Set();
      map.set(type, set);
    }
    set.add(listener);

    return () => {
      set?.delete(listener);
      if (set && set.size === 0) map.delete(type);
    };
  }, []);

  /** 分发给订阅者。单个回调抛错不影响其他订阅者。 */
  const dispatch = useCallback((event: SseEvent) => {
    setLastEventAt(Date.now());

    const map = listenersRef.current;
    for (const listener of map.get(event.type) ?? []) {
      try {
        listener(event);
      } catch (error) {
        console.error('[sse] 事件回调异常', error);
      }
    }
    for (const listener of map.get('*') ?? []) {
      try {
        listener(event);
      } catch (error) {
        console.error('[sse] 事件回调异常', error);
      }
    }
  }, []);

  /** 处理需要 Provider 自己维护的状态 */
  const handleInternal = useCallback((event: SseEvent) => {
    switch (event.type) {
      case 'connected':
        // 重连后立即对齐版本:落后的 scope 由订阅方(如模型配置 hook)据此补拉
        setConfigVersions(event.configVersions);
        break;
      case 'config.updated':
        setConfigVersions((prev) => ({ ...prev, [event.scope]: event.version }));
        if (event.disabledModelIds?.length) {
          setDisabledModelIds((prev) => Array.from(new Set([...prev, ...(event.disabledModelIds ?? [])])));
        }
        break;
      default:
        break;
    }
  }, []);

  const cleanupTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  /**
   * 降级轮询。
   * SSE 不可用时靠低频轮询保证"配置最终一致",代价是延迟从 2 秒退化到 15 秒,
   * 界面会明确提示当前处于降级状态,不假装实时。
   */
  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    setTransport('polling');

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch('/api/events/versions', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) return;
        const data = (await response.json()) as { configVersions?: Record<string, number> };
        if (data.configVersions) setConfigVersions(data.configVersions);
      } catch {
        // 轮询失败保持静默,下一轮再试
      }
    };

    void poll();
    pollTimerRef.current = setInterval(() => void poll(), SSE_FALLBACK_POLL_MS);
  }, []);

  const connect = useCallback(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      startPolling();
      return;
    }

    setTransport('connecting');

    // EventSource 自带 Cookie(同源),权限隔离由后端按会话完成
    const source = new EventSource(SSE_PATH, { withCredentials: true });
    sourceRef.current = source;

    source.onopen = () => {
      attemptsRef.current = 0;
      setTransport('sse');
      // 恢复 SSE 后停掉降级轮询
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    source.onmessage = (message: MessageEvent<string>) => {
      // 服务端用具名事件推送;这里兜底处理未命名消息
      try {
        const parsed = JSON.parse(message.data) as SseEvent;
        handleInternal(parsed);
        dispatch(parsed);
      } catch {
        // 心跳注释行不会走到这里,解析失败直接忽略
      }
    };

    // 具名事件监听:与后端 `event: <type>` 对应
    const namedTypes: SseEventType[] = [
      'connected',
      'heartbeat',
      'config.updated',
      'task.updated',
      'post.updated',
      'comment.updated',
      'storage.updated',
      'session.invalidated',
    ];

    for (const type of namedTypes) {
      source.addEventListener(type, (raw) => {
        const message = raw as MessageEvent<string>;
        try {
          const parsed = JSON.parse(message.data) as SseEvent;
          handleInternal(parsed);
          dispatch(parsed);
        } catch (error) {
          console.error('[sse] 事件解析失败', type, error);
        }
      });
    }

    source.onerror = () => {
      source.close();
      sourceRef.current = null;
      attemptsRef.current += 1;

      if (attemptsRef.current >= MAX_SSE_ATTEMPTS) {
        // 反复失败:可能是代理不支持 SSE,转为轮询,但仍每隔一段时间尝试恢复
        startPolling();
        reconnectTimerRef.current = setTimeout(() => {
          attemptsRef.current = 0;
          connect();
        }, SSE_RECONNECT_MAX_MS * 2);
        return;
      }

      // 指数退避 + 抖动,避免 50 人同时重连打出尖峰
      const base = Math.min(SSE_RECONNECT_BASE_MS * 2 ** (attemptsRef.current - 1), SSE_RECONNECT_MAX_MS);
      const delay = base + Math.random() * 400;
      setTransport('offline');
      reconnectTimerRef.current = setTimeout(connect, delay);
    };
  }, [dispatch, handleInternal, startPolling]);

  useEffect(() => {
    if (!isAuthenticated) {
      // 未登录:关闭连接并重置状态
      sourceRef.current?.close();
      sourceRef.current = null;
      cleanupTimers();
      setTransport('offline');
      return;
    }

    connect();

    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
      cleanupTimers();
    };
  }, [isAuthenticated, connect, cleanupTimers]);

  // 标签页重新可见时立即校验连接,浏览器可能在后台休眠了它
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (!isAuthenticated) return;
      if (sourceRef.current?.readyState === EventSource.OPEN) return;
      attemptsRef.current = 0;
      connect();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [isAuthenticated, connect]);

  const acknowledgeDisabledModels = useCallback(() => setDisabledModelIds([]), []);

  const value = useMemo<SseContextValue>(
    () => ({ transport, configVersions, disabledModelIds, subscribe, acknowledgeDisabledModels, lastEventAt }),
    [transport, configVersions, disabledModelIds, subscribe, acknowledgeDisabledModels, lastEventAt],
  );

  return <SseContext.Provider value={value}>{children}</SseContext.Provider>;
}

export function useSse(): SseContextValue {
  const context = useContext(SseContext);
  if (!context) throw new Error('useSse 必须在 SseProvider 内使用');
  return context;
}

/** 订阅指定类型的事件。回调用 ref 保存,依赖变化不会反复重订。 */
export function useSseEvent<T extends SseEventType>(type: T | '*', listener: Listener): void {
  const { subscribe } = useSse();
  const ref = useRef(listener);
  ref.current = listener;

  useEffect(() => subscribe(type, (event) => ref.current(event)), [subscribe, type]);
}
