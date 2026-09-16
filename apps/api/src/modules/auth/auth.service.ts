import { Injectable, Logger } from '@nestjs/common';
import { ROLE_ADMIN, ROLE_LEVEL, ROLE_SUPER_ADMIN, ROLE_USER, SessionScope } from '@june/db';
import {
  ERROR_CODES,
  type ChangePasswordInput,
  type LoginInput,
  type RegisterInput,
  type SessionUser,
  type UpdateProfileInput,
} from '@june/shared';
import type { Response } from 'express';

import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-context';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app-exception';
import { loadEnv } from '../../config/env';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AssetUrlService } from '../assets/asset-url.service';
import { SessionService } from './session.service';

interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly env = loadEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly assetUrls: AssetUrlService,
  ) {}

  // ---------------------------------------------------------------------------
  // 注册 / 登录 / 退出
  // ---------------------------------------------------------------------------

  async register(input: RegisterInput, meta: ClientMeta, response: Response): Promise<SessionUser> {
    const existing = await this.prisma.db.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) {
      // 不区分"邮箱已注册"与其他冲突,避免被用来枚举已注册邮箱
      throw AppException.conflict(ERROR_CODES.CONFLICT, '该邮箱无法注册,请更换邮箱或直接登录');
    }

    const passwordHash = await this.crypto.hashPassword(input.password);

    const user = await this.prisma.db.$transaction(async (tx) => {
      const userRole = await tx.role.findUniqueOrThrow({ where: { slug: ROLE_USER } });
      const created = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          displayName: input.displayName,
          roles: { create: { roleId: userRole.id } },
          storageUsage: {
            create: { quotaBytes: BigInt(this.env.DEFAULT_STORAGE_QUOTA_BYTES) },
          },
        },
        select: { id: true },
      });
      return created;
    });

    await this.sessions.issue({
      userId: user.id,
      scope: SessionScope.SITE,
      remember: false,
      ip: meta.ip,
      userAgent: meta.userAgent,
      response,
    });

    await this.prisma.db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastActiveAt: new Date() },
    });

    await this.audit.record({
      actor: null,
      action: 'auth.register',
      targetType: 'User',
      targetId: user.id,
      metadata: { email: input.email },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.buildSessionUser(user.id);
  }

  /**
   * 登录。
   * scope=ADMIN 时额外要求管理员等级,且失败原因统一为"凭据不正确",
   * 避免通过 /admin 登录接口探测哪些账号是管理员。
   */
  async login(
    input: LoginInput,
    scope: SessionScope,
    meta: ClientMeta,
    response: Response,
  ): Promise<SessionUser> {
    const user = await this.prisma.db.user.findUnique({
      where: { email: input.email },
      select: {
        id: true,
        passwordHash: true,
        status: true,
        deletedAt: true,
        roles: { select: { role: { select: { slug: true, level: true } } } },
      },
    });

    if (!user || user.deletedAt) {
      // 抹平时间差,避免通过响应耗时判断邮箱是否存在
      await this.crypto.dummyPasswordWork();
      throw AppException.unauthenticated(ERROR_CODES.INVALID_CREDENTIALS);
    }

    const passwordOk = await this.crypto.verifyPassword(user.passwordHash, input.password);
    if (!passwordOk) {
      await this.audit.record({
        actor: null,
        action: scope === SessionScope.ADMIN ? 'auth.admin_login' : 'auth.login',
        targetType: 'User',
        targetId: user.id,
        result: 'failure',
        metadata: { reason: 'invalid_password' },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw AppException.unauthenticated(ERROR_CODES.INVALID_CREDENTIALS);
    }

    if (user.status !== 'ACTIVE') {
      throw AppException.forbidden(ERROR_CODES.ACCOUNT_DISABLED);
    }

    const roleLevel = user.roles.reduce((max, r) => Math.max(max, r.role.level), 0);
    if (scope === SessionScope.ADMIN && roleLevel < ROLE_LEVEL[ROLE_ADMIN]) {
      // 与密码错误返回同样的错误码,不暴露"该账号存在但不是管理员"
      await this.audit.record({
        actor: null,
        action: 'auth.admin_login',
        targetType: 'User',
        targetId: user.id,
        result: 'failure',
        metadata: { reason: 'not_admin' },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw AppException.unauthenticated(ERROR_CODES.INVALID_CREDENTIALS);
    }

    await this.sessions.issue({
      userId: user.id,
      scope,
      remember: input.remember,
      ip: meta.ip,
      userAgent: meta.userAgent,
      response,
    });

    await this.prisma.db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastActiveAt: new Date() },
    });

    await this.audit.record({
      actor: null,
      action: scope === SessionScope.ADMIN ? 'auth.admin_login' : 'auth.login',
      targetType: 'User',
      targetId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.buildSessionUser(user.id);
  }

  async logout(token: string | undefined, scope: SessionScope, response: Response): Promise<void> {
    if (token) {
      await this.sessions.revoke(token, 'logout');
    }
    this.sessions.clearCookies(response, scope);
  }

  /** 退出全部设备 */
  async logoutEverywhere(user: AuthUser, scope: SessionScope, response: Response): Promise<void> {
    await this.sessions.revokeAllForUser(user.id, 'revoked');
    this.sessions.clearCookies(response, scope);
  }

  // ---------------------------------------------------------------------------
  // 资料 / 密码
  // ---------------------------------------------------------------------------

  async updateProfile(user: AuthUser, input: UpdateProfileInput, meta: ClientMeta): Promise<SessionUser> {
    const before = await this.prisma.db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { displayName: true, bio: true, avatarKey: true },
    });

    let avatarKey = before.avatarKey;
    if (input.avatarAssetId !== undefined) {
      if (input.avatarAssetId === null) {
        avatarKey = null;
      } else {
        // 头像必须是本人已确认上传的资产
        const asset = await this.prisma.db.asset.findFirst({
          where: {
            id: input.avatarAssetId,
            ownerId: user.id,
            kind: 'AVATAR',
            status: 'ACTIVE',
          },
          select: { objectKey: true },
        });
        if (!asset) throw AppException.badRequest(ERROR_CODES.NOT_FOUND, '头像文件不存在或尚未上传完成');
        avatarKey = asset.objectKey;
      }
    }

    await this.prisma.db.user.update({
      where: { id: user.id },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.bio !== undefined ? { bio: input.bio } : {}),
        avatarKey,
      },
    });

    await this.audit.record({
      actor: user,
      action: 'user.profile_update',
      targetType: 'User',
      targetId: user.id,
      diff: this.audit.buildDiff(before as Record<string, unknown>, {
        displayName: input.displayName,
        bio: input.bio,
        avatarKey,
      }),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.buildSessionUser(user.id);
  }

  /**
   * 修改密码。成功后**所有会话立即失效**(包括当前设备),
   * 前端需要引导重新登录 —— 这是需求要求的统一失效规则。
   */
  async changePassword(
    user: AuthUser,
    input: ChangePasswordInput,
    meta: ClientMeta,
    response: Response,
    scope: SessionScope,
  ): Promise<void> {
    const record = await this.prisma.db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });

    const ok = await this.crypto.verifyPassword(record.passwordHash, input.currentPassword);
    if (!ok) {
      await this.audit.record({
        actor: user,
        action: 'user.password_change',
        targetType: 'User',
        targetId: user.id,
        result: 'failure',
        metadata: { reason: 'invalid_current_password' },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw AppException.badRequest(ERROR_CODES.INVALID_CREDENTIALS, '当前密码不正确');
    }

    const passwordHash = await this.crypto.hashPassword(input.newPassword);
    await this.prisma.db.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordChangedAt: new Date() },
    });

    await this.sessions.revokeAllForUser(user.id, 'password_changed');
    this.sessions.clearCookies(response, scope);

    await this.audit.record({
      actor: user,
      action: 'user.password_change',
      targetType: 'User',
      targetId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  /** 敏感操作重新验证:用当前密码换取一次性短时令牌 */
  async createReauthToken(user: AuthUser, password: string, meta: ClientMeta): Promise<{
    token: string;
    expiresAt: string;
  }> {
    const record = await this.prisma.db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });

    const ok = await this.crypto.verifyPassword(record.passwordHash, password);
    if (!ok) {
      await this.audit.record({
        actor: user,
        action: 'auth.reauth',
        targetType: 'User',
        targetId: user.id,
        result: 'failure',
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw AppException.forbidden(ERROR_CODES.INVALID_CREDENTIALS, '密码不正确');
    }

    const token = this.crypto.randomToken(32);
    const expiresAt = new Date(Date.now() + this.env.REAUTH_TTL_SECONDS * 1000);

    await this.prisma.db.reauthToken.create({
      data: {
        userId: user.id,
        tokenHash: this.crypto.sha256(token),
        purpose: 'credential.reveal',
        expiresAt,
      },
    });

    await this.audit.record({
      actor: user,
      action: 'auth.reauth',
      targetType: 'User',
      targetId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { token, expiresAt: expiresAt.toISOString() };
  }

  // ---------------------------------------------------------------------------

  async buildSessionUser(userId: string): Promise<SessionUser> {
    const user = await this.prisma.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarKey: true,
        bio: true,
        status: true,
        createdAt: true,
        lastLoginAt: true,
        roles: { select: { role: { select: { slug: true, level: true, permissions: true } } } },
      },
    });

    const roles = user.roles.map((r) => r.role.slug);
    const roleLevel = user.roles.reduce((max, r) => Math.max(max, r.role.level), 0);

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarKey ? await this.assetUrls.signObjectKey(user.avatarKey) : null,
      bio: user.bio,
      status: user.status,
      roles,
      permissions: [...new Set(user.roles.flatMap((r) => r.role.permissions))],
      isAdmin: roleLevel >= ROLE_LEVEL[ROLE_ADMIN],
      isSuperAdmin: roleLevel >= ROLE_LEVEL[ROLE_SUPER_ADMIN],
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    };
  }
}
