import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CSRF_COOKIE, CSRF_HEADER, ERROR_CODES } from '@june/shared';

import { CryptoService } from '../crypto/crypto.service';
import { AppException } from '../errors/app-exception';
import type { AuthenticatedRequest } from './auth-context';
import { SKIP_CSRF_KEY } from './auth.decorators';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF 守卫(全局)。
 *
 * 采用双提交 Cookie + HMAC 绑定会话:
 *  1. 请求头 `x-june-csrf` 必须存在;
 *  2. 必须与 `june_csrf` Cookie 一致(常量时间比较);
 *  3. 令牌的 HMAC 必须能用服务端密钥和当前会话令牌验证通过。
 *
 * 第 3 步是关键:即使攻击者能设置 Cookie(子域写入等场景),
 * 也无法伪造出与受害者会话绑定的合法 HMAC。
 *
 * 只对非幂等方法生效;登录/注册用 @SkipCsrf(此时还没有会话可绑定)。
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly crypto: CryptoService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    // 没有会话的请求由 SessionGuard 处理,这里无需再判
    const sessionToken = request.authSession?.token;
    if (!sessionToken) return true;

    const headerValue = request.header(CSRF_HEADER);
    const cookieValue = (request.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];

    if (!headerValue || !cookieValue) {
      throw new AppException(ERROR_CODES.CSRF_FAILED, 403);
    }
    if (!this.crypto.constantTimeEquals(headerValue, cookieValue)) {
      throw new AppException(ERROR_CODES.CSRF_FAILED, 403);
    }
    if (!this.crypto.verifyCsrfToken(headerValue, sessionToken)) {
      throw new AppException(ERROR_CODES.CSRF_FAILED, 403);
    }

    return true;
  }
}
