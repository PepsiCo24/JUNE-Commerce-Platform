import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES, REAUTH_HEADER } from '@june/shared';

import { CryptoService } from '../crypto/crypto.service';
import { AppException } from '../errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { AuthenticatedRequest } from './auth-context';
import { REQUIRE_REAUTH_KEY } from './auth.decorators';

/**
 * 敏感操作重新验证守卫。
 *
 * 用于"查看/复制店铺密码"这类操作:必须先用当前登录密码换取一次性短时令牌,
 * 再带 `x-june-reauth` 头调用。令牌一次性使用、有 TTL、绑定用户与用途。
 *
 * 这样即使会话 Cookie 被窃取,攻击者仍无法直接取回店铺密码明文。
 */
@Injectable()
export class ReauthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_REAUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.authUser;
    if (!user) throw AppException.unauthenticated();

    const raw = request.header(REAUTH_HEADER);
    if (!raw) {
      throw AppException.forbidden(ERROR_CODES.REAUTH_REQUIRED);
    }

    const tokenHash = this.crypto.sha256(raw);
    const now = new Date();

    // 一次性消费:用 updateMany 的条件更新保证并发下也只能被用掉一次
    const consumed = await this.prisma.db.reauthToken.updateMany({
      where: {
        tokenHash,
        userId: user.id,
        purpose: 'credential.reveal',
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });

    if (consumed.count !== 1) {
      throw AppException.forbidden(ERROR_CODES.REAUTH_INVALID);
    }

    request.reauthVerified = true;
    return true;
  }
}
