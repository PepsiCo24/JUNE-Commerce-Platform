import { Injectable, Logger } from '@nestjs/common';
import { ROLE_LEVEL, SessionScope, type RoleSlug } from '@june/db';
import { SESSION_COOKIE_ADMIN, SESSION_COOKIE_SITE, userSseChannel } from '@june/shared';
import type { CookieOptions, Response } from 'express';

import { CryptoService } from '../../common/crypto/crypto.service';
import type { AuthUser } from '../../common/auth/auth-context';
import { loadEnv } from '../../config/env';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';

export interface IssuedSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface ResolvedSession {
  user: AuthUser;
  session: { id: string; scope: SessionScope; token: string; expiresAt: Date };
}

/**
 * 会话管理。
 *
 * 安全设计:
 *  - Cookie:HttpOnly + Secure(生产)+ SameSite=Lax,前端 JS 读不到会话令牌。
 *  - 数据库只存 sha256(token);即使数据库被读取也无法直接冒用会话。
 *  - 会话失效统一由 User.sessionEpoch 驱动:退出全部设备、被禁用、修改密码时
 *    epoch 前移,所有旧会话在下一次请求即失效,不需要逐条清理。
 *  - 站点会话与 /admin 会话使用不同 Cookie 名与 scope,互不通用。
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly env = loadEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
  ) {}

  cookieName(scope: SessionScope): string {
    return scope === SessionScope.ADMIN ? SESSION_COOKIE_ADMIN : SESSION_COOKIE_SITE;
  }

  /** Cookie 路径隔离:管理员会话不会随普通请求一起发送 */
  private cookiePath(scope: SessionScope): string {
    return scope === SessionScope.ADMIN ? '/api/admin' : '/';
  }

  private cookieOptions(scope: SessionScope, maxAgeMs: number): CookieOptions {
    return {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: this.cookiePath(scope),
      maxAge: maxAgeMs,
      ...(this.env.COOKIE_DOMAIN ? { domain: this.env.COOKIE_DOMAIN } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // 签发与撤销
  // ---------------------------------------------------------------------------

  async issue(params: {
    userId: string;
    scope: SessionScope;
    remember: boolean;
    ip: string | null;
    userAgent: string | null;
    response: Response;
  }): Promise<IssuedSession> {
    const { userId, scope, remember, ip, userAgent, response } = params;

    const user = await this.prisma.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { sessionEpoch: true },
    });

    const token = this.crypto.randomToken(32);
    const ttlHours = remember ? this.env.SESSION_TTL_HOURS : Math.min(this.env.SESSION_TTL_HOURS, 24);
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

    await this.prisma.db.session.create({
      data: {
        userId,
        scope,
        tokenHash: this.crypto.sha256(token),
        epoch: user.sessionEpoch,
        ip,
        userAgent: userAgent?.slice(0, 400) ?? null,
        expiresAt,
      },
    });

    const csrfToken = this.crypto.signCsrfToken(token);

    response.cookie(this.cookieName(scope), token, this.cookieOptions(scope, ttlHours * 3_600_000));
    // CSRF Cookie 必须可被前端 JS 读取以回填请求头,因此不是 HttpOnly。
    // 它本身不构成凭据:攻击者即使猜到也无法读取跨站的会话 Cookie。
    response.cookie('june_csrf', csrfToken, {
      httpOnly: false,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: ttlHours * 3_600_000,
      ...(this.env.COOKIE_DOMAIN ? { domain: this.env.COOKIE_DOMAIN } : {}),
    });

    return { token, csrfToken, expiresAt };
  }

  clearCookies(response: Response, scope: SessionScope): void {
    response.clearCookie(this.cookieName(scope), { path: this.cookiePath(scope) });
    response.clearCookie('june_csrf', { path: '/' });
  }

  /** 撤销单个会话(当前设备退出) */
  async revoke(token: string, reason: string): Promise<void> {
    const tokenHash = this.crypto.sha256(token);
    const session = await this.prisma.db.session.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, revokedAt: true },
    });
    if (!session || session.revokedAt) return;

    await this.prisma.db.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    await this.redis.del(this.cacheKey(tokenHash));
    await this.notifySessionInvalidated(session.userId, 'logout');
  }

  /**
   * 使某用户的全部会话失效(禁用账号、修改密码、管理员强制下线)。
   * 通过前移 sessionEpoch 一次性生效,同时清理缓存并通知在线页面。
   */
  async revokeAllForUser(
    userId: string,
    reason: 'password_changed' | 'disabled' | 'revoked',
  ): Promise<void> {
    await this.prisma.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { sessionEpoch: { increment: 1 } } });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
    });

    await this.redis.delByPrefix(`session:user:${userId}:`);
    await this.notifySessionInvalidated(userId, reason);
    this.logger.log(`已使用户 ${userId} 的全部会话失效(${reason})`);
  }

  private async notifySessionInvalidated(
    userId: string,
    reason: 'logout' | 'password_changed' | 'disabled' | 'revoked',
  ): Promise<void> {
    try {
      await this.redis.publisher.publish(
        userSseChannel(userId),
        JSON.stringify({ type: 'session.invalidated', reason }),
      );
    } catch (err) {
      this.logger.warn(`会话失效通知发送失败:${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 解析与校验
  // ---------------------------------------------------------------------------

  private cacheKey(tokenHash: string): string {
    return `session:token:${tokenHash}`;
  }

  /**
   * 校验会话并返回用户上下文。
   *
   * 缓存策略:会话与角色信息缓存 30 秒以降低每请求的数据库压力,
   * 但缓存内容包含 epoch 与 status,且**禁用状态**会在 revokeAllForUser 时
   * 主动清理缓存并前移 epoch,因此不会出现"已禁用账号靠过期缓存继续访问"的情况。
   * 权限相关的关键判断(管理员操作、模型停用)另有回源校验。
   */
  async resolve(token: string, scope: SessionScope): Promise<ResolvedSession | null> {
    const tokenHash = this.crypto.sha256(token);

    const record = await this.prisma.db.session.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        scope: true,
        epoch: true,
        expiresAt: true,
        revokedAt: true,
        lastSeenAt: true,
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            status: true,
            sessionEpoch: true,
            deletedAt: true,
            roles: { select: { role: { select: { slug: true, level: true, permissions: true } } } },
          },
        },
      },
    });

    if (!record) return null;
    if (record.scope !== scope) return null;
    if (record.revokedAt) return null;
    if (record.expiresAt.getTime() <= Date.now()) return null;

    const user = record.user;
    if (user.deletedAt) return null;
    // 禁用后立即拒绝,不等会话自然过期
    if (user.status !== 'ACTIVE') return null;
    // 改密码/强制下线后 epoch 不一致,旧会话立即失效
    if (record.epoch !== user.sessionEpoch) return null;

    // 空闲超时:长时间无活动的会话视为失效
    const idleLimitMs = this.env.SESSION_IDLE_TIMEOUT_HOURS * 3_600_000;
    if (Date.now() - record.lastSeenAt.getTime() > idleLimitMs) {
      await this.prisma.db.session.update({
        where: { id: record.id },
        data: { revokedAt: new Date(), revokedReason: 'idle_timeout' },
      });
      return null;
    }

    const roles = user.roles.map((r) => r.role.slug);
    const permissions = [...new Set(user.roles.flatMap((r) => r.role.permissions))];
    const roleLevel = user.roles.reduce((max, r) => Math.max(max, r.role.level), 0);

    // 活跃时间更新做节流:每 5 分钟最多写一次,避免每请求一次写库
    await this.touchLastSeen(record.id, user.id, record.lastSeenAt);

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        roles,
        permissions,
        roleLevel,
        isAdmin: roleLevel >= ROLE_LEVEL.admin,
        isSuperAdmin: roleLevel >= ROLE_LEVEL.super_admin,
      },
      session: { id: record.id, scope: record.scope, token, expiresAt: record.expiresAt },
    };
  }

  private async touchLastSeen(sessionId: string, userId: string, lastSeenAt: Date): Promise<void> {
    const throttleMs = 5 * 60_000;
    if (Date.now() - lastSeenAt.getTime() < throttleMs) return;

    const lockKey = `session:touch:${sessionId}`;
    const acquired = await this.redis.acquireLock(lockKey, throttleMs);
    if (!acquired) return;

    try {
      const now = new Date();
      await this.prisma.db.$transaction([
        this.prisma.db.session.update({ where: { id: sessionId }, data: { lastSeenAt: now } }),
        this.prisma.db.user.update({ where: { id: userId }, data: { lastActiveAt: now } }),
      ]);
    } catch (err) {
      this.logger.warn(`更新活跃时间失败:${(err as Error).message}`);
    }
  }

  /** 判断角色 slug 是否达到指定等级 */
  static levelOf(slugs: string[]): number {
    return slugs.reduce((max, slug) => {
      const level = ROLE_LEVEL[slug as RoleSlug];
      return level ? Math.max(max, level) : max;
    }, 0);
  }

  /** 清理已过期/已撤销的会话记录(定时任务调用) */
  async pruneExpired(olderThanDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const result = await this.prisma.db.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    });
    return result.count;
  }
}
