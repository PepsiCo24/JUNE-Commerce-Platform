import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';

import { AppException } from '../errors/app-exception';
import type { AuthenticatedRequest, AuthUser } from './auth-context';

/** 标记为公开接口,跳过会话校验(仍然经过限流) */
export const IS_PUBLIC_KEY = 'june:isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** 跳过 CSRF 校验。仅用于登录/注册这类尚无会话的写接口。 */
export const SKIP_CSRF_KEY = 'june:skipCsrf';
export const SkipCsrf = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_CSRF_KEY, true);

/**
 * 要求的最低角色等级。后端强制校验,前端隐藏入口不构成安全边界。
 * 10=普通用户 50=管理员 100=超级管理员
 */
export const MIN_ROLE_LEVEL_KEY = 'june:minRoleLevel';
export const MinRoleLevel = (level: number): MethodDecorator & ClassDecorator =>
  SetMetadata(MIN_ROLE_LEVEL_KEY, level);

/** 要求的细粒度权限点(全部满足) */
export const REQUIRED_PERMISSIONS_KEY = 'june:permissions';
export const RequirePermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/** 该接口需要近期重新验证身份(查看/复制店铺密码) */
export const REQUIRE_REAUTH_KEY = 'june:requireReauth';
export const RequireReauth = (): MethodDecorator & ClassDecorator => SetMetadata(REQUIRE_REAUTH_KEY, true);

/** 注入当前用户。未认证时抛异常而不是返回 undefined,避免下游漏判。 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.authUser) {
    throw AppException.unauthenticated();
  }
  return request.authUser;
});

/** 注入当前用户(允许为空,用于同时服务游客与登录用户的接口) */
export const OptionalUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | null => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.authUser ?? null;
  },
);

/** 注入客户端 IP 与 UA,用于审计 */
export const ClientInfo = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): { ip: string | null; userAgent: string | null } => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return {
      ip: request.ip ?? null,
      userAgent: (request.header('user-agent') ?? '').slice(0, 400) || null,
    };
  },
);
