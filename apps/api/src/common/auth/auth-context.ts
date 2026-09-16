import type { SessionScope } from '@june/db';
import type { Request } from 'express';

/** 请求上下文中的已认证用户。由 SessionGuard 写入,后续 handler 只读。 */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  status: 'ACTIVE' | 'DISABLED';
  roles: string[];
  permissions: string[];
  roleLevel: number;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface AuthSession {
  id: string;
  scope: SessionScope;
  /** Cookie 中的原始令牌,CSRF 校验需要用它做 HMAC 比对 */
  token: string;
  expiresAt: Date;
}

/** 扩展后的请求对象 */
export interface AuthenticatedRequest extends Request {
  requestId?: string;
  authUser?: AuthUser;
  authSession?: AuthSession;
  /** 通过重新验证的敏感操作标记 */
  reauthVerified?: boolean;
}

export const ROLE_PERMISSION_ADMIN_ACCESS = 'admin.access';
