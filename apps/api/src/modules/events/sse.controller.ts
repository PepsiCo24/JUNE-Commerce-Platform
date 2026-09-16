import { randomUUID } from 'node:crypto';

import { Controller, Get, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  SSE_CHANNELS,
  SSE_HEARTBEAT_MS,
  SSE_RECONNECT_BASE_MS,
  userSseChannel,
  type SseConnectedEvent,
  type SseEvent,
  type SseHeartbeatEvent,
} from '@june/shared';
import type { Request, Response } from 'express';

import type { AuthUser } from '../../common/auth/auth-context';
import { CurrentUser } from '../../common/auth/auth.decorators';
import { MAX_CONNECTIONS_PER_USER, SseService } from './sse.service';

/**
 * SSE 推送端点。每个标签页只维护一条连接。
 *
 * 安全边界:
 *  - 只订阅全站广播频道与**当前用户自己的**频道,拿不到别人的任务事件;
 *  - 配置事件只带版本号,不携带任何密钥或内部系统提示词;
 *  - 未登录直接被全局 SessionGuard 拦下。
 *
 * 资源边界:
 *  - 连接关闭时必须清理心跳定时器与两个订阅,否则 50 人在线就会稳定泄漏;
 *  - 单用户并发连接数设上限,前端重连逻辑写错也不会把连接打爆。
 */
@Controller('events')
export class SseController {
  constructor(private readonly sse: SseService) {}

  /**
   * 配置版本快照。
   *
   * 用途:当 SSE 不可用(例如反向代理缓冲了长连接、企业网络拦截了 text/event-stream)时,
   * 前端降级为低频轮询这个端点来对齐配置版本。延迟从 2 秒退化到轮询间隔,
   * 界面会明确提示处于降级状态 —— 不假装实时。
   *
   * 只返回版本号,与 SSE 的 config.updated 事件同源,同样不含任何密钥。
   */
  @Get('versions')
  async versions(): Promise<{ configVersions: Record<string, number>; serverTime: string }> {
    return {
      configVersions: await this.sse.currentConfigVersions(),
      serverTime: new Date().toISOString(),
    };
  }

  @Get('stream')
  // 长连接不参与常规限流:一条连接只有一次请求,却会被心跳误判为活跃流量
  @SkipThrottle()
  async stream(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.sse.acquireConnection(user.id)) {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: `同时最多保持 ${MAX_CONNECTIONS_PER_USER} 条实时连接,请关闭多余标签页后重试`,
          retryAfterSeconds: 5,
        },
      });
      return;
    }

    const connectionId = randomUUID();
    let closed = false;

    // 手动写响应头:SSE 不能走 Nest 的 JSON 序列化
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform 同时阻止中间层压缩/改写,否则事件会被缓冲住
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 配合 Nginx 关闭该连接的响应缓冲
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const write = (chunk: string): void => {
      if (closed || res.writableEnded) return;
      try {
        res.write(chunk);
      } catch {
        // 对端已断开,交给 close 处理器统一清理
      }
    };

    const send = (event: SseEvent): void => {
      write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // 客户端断线重连的基准间隔(客户端自行做指数退避)
    write(`retry: ${SSE_RECONNECT_BASE_MS}\n\n`);

    // 立即下发当前各 scope 的配置版本,前端据此判断是否需要补拉
    const connected: SseConnectedEvent = {
      type: 'connected',
      connectionId,
      serverTime: new Date().toISOString(),
      configVersions: await this.sse.currentConfigVersions(),
    };
    send(connected);

    const heartbeat = setInterval(() => {
      // 注释行用于穿透代理保活,事件用于前端确认连接仍然健康
      write(': ping\n\n');
      const event: SseHeartbeatEvent = { type: 'heartbeat', serverTime: new Date().toISOString() };
      send(event);
    }, SSE_HEARTBEAT_MS);
    // 心跳定时器不应阻止进程退出
    heartbeat.unref?.();

    // 只订阅自己的用户频道:权限隔离在订阅这一层就完成,不依赖下游过滤
    const unsubscribers: Array<() => Promise<void>> = [];
    try {
      unsubscribers.push(await this.sse.subscribe(SSE_CHANNELS.broadcast, send));
      unsubscribers.push(await this.sse.subscribe(userSseChannel(user.id), send));
    } catch {
      // 订阅建立失败:立即回收已占用的资源,不留下悬空的连接名额
      await cleanup();
      this.sse.releaseConnection(user.id);
      res.end();
      return;
    }

    async function cleanup(): Promise<void> {
      closed = true;
      clearInterval(heartbeat);
      // 逐个释放订阅;fan-out 注册表只在最后一个监听器离开时才真正 unsubscribe
      await Promise.allSettled(unsubscribers.splice(0).map((off) => off()));
    }

    // close / error 可能被触发多次,名额只能释放一次
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      void cleanup().finally(() => this.sse.releaseConnection(user.id));
    };

    req.on('close', finish);
    req.on('error', finish);
    res.on('close', finish);
  }
}
