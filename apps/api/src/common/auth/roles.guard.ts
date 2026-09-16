import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLE_LEVEL, SessionScope } from '@june/db';
import { ERROR_CODES } from '@june/shared';

import { AppException } from '../errors/app-exception';
import type { AuthenticatedRequest } from './auth-context';
import { IS_PUBLIC_KEY, MIN_ROLE_LEVEL_KEY, REQUIRED_PERMISSIONS_KEY } from './auth.decorators';
import { SessionGuard } from './session.guard';

/**
 * 角色与权限守卫(全局)。
 *
 * 两层保障:
 *  1. 所有 `/api/admin/**` 路径**无条件**要求管理员等级 —— 即使某个控制器忘记加装饰器,
 *     也不会暴露给普通用户。
 *  2. 装饰器声明的最低等级与权限点在此强制校验。
 *
 * `@Public()` 例外:管理站登录/公开探测等入口必须可未登录访问,否则无法完成首次登录。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.authUser;

    const isAdminPath = SessionGuard.scopeOf(request.path) === SessionScope.ADMIN;
    const declaredLevel =
      this.reflector.getAllAndOverride<number>(MIN_ROLE_LEVEL_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 0;
    const requiredPermissions =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    // 管理员路径的兜底底线
    const requiredLevel = isAdminPath ? Math.max(declaredLevel, ROLE_LEVEL.admin) : declaredLevel;

    if (requiredLevel === 0 && requiredPermissions.length === 0) return true;

    if (!user) {
      throw AppException.unauthenticated(
        isAdminPath ? ERROR_CODES.ADMIN_REQUIRED : ERROR_CODES.UNAUTHENTICATED,
      );
    }

    if (user.roleLevel < requiredLevel) {
      throw AppException.forbidden(
        requiredLevel >= ROLE_LEVEL.admin ? ERROR_CODES.ADMIN_REQUIRED : ERROR_CODES.FORBIDDEN,
      );
    }

    const missing = requiredPermissions.filter((p) => !user.permissions.includes(p));
    if (missing.length > 0) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, `缺少权限:${missing.join('、')}`);
    }

    return true;
  }
}
