import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SessionScope } from '@june/db';
import { ERROR_CODES } from '@june/shared';

import { AppException } from '../errors/app-exception';
import { SessionService } from '../../modules/auth/session.service';
import type { AuthenticatedRequest } from './auth-context';
import { IS_PUBLIC_KEY } from './auth.decorators';

/**
 * 会话守卫(全局)。
 *
 * scope 由路径决定而非由调用方声明:`/api/admin/**` 一律使用管理员会话 Cookie,
 * 其余使用站点会话 Cookie。这样不会因为忘记加装饰器而让管理员接口接受普通会话。
 *
 * 公开接口(@Public)仍会尝试解析会话——帖子大厅需要知道"当前用户是否已点赞",
 * 但解析失败不阻断请求。
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  static scopeOf(path: string): SessionScope {
    return path.startsWith('/api/admin') ? SessionScope.ADMIN : SessionScope.SITE;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const scope = SessionGuard.scopeOf(request.path);
    const cookieName = this.sessions.cookieName(scope);
    const token = (request.cookies as Record<string, string> | undefined)?.[cookieName];

    if (!token) {
      if (isPublic) return true;
      throw AppException.unauthenticated(
        scope === SessionScope.ADMIN ? ERROR_CODES.ADMIN_REQUIRED : ERROR_CODES.UNAUTHENTICATED,
      );
    }

    const resolved = await this.sessions.resolve(token, scope);
    if (!resolved) {
      if (isPublic) return true;
      // 令牌存在但无效:提示"登录已失效",与"未登录"区分,便于前端引导重新登录
      throw AppException.unauthenticated(ERROR_CODES.SESSION_EXPIRED);
    }

    request.authUser = resolved.user;
    request.authSession = resolved.session;
    return true;
  }
}
