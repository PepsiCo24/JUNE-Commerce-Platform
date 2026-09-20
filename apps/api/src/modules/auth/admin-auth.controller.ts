import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SessionScope } from '@june/db';
import { adminLoginSchema, type AuthStateResponse, type SessionUser } from '@june/shared';
import type { Response } from 'express';
import type { z } from 'zod';

import type { AuthenticatedRequest, AuthUser } from '../../common/auth/auth-context';
import { ClientInfo, CurrentUser, Public, SkipCsrf } from '../../common/auth/auth.decorators';
import { zodBody } from '../../common/validation/zod-body.pipe';
import { loadEnv } from '../../config/env';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

type AdminLoginInput = z.infer<typeof adminLoginSchema>;

const authThrottle = {
  default: { limit: loadEnv().RATE_LIMIT_AUTH_PER_MINUTE, ttl: 60_000 },
};

/**
 * 管理员站独立登录入口。
 *
 * 与站点登录的区别:
 *  - 使用独立 Cookie(june_admin_session)与 SessionScope.ADMIN,路径限定 /api/admin;
 *  - 登录时在后端校验管理员角色,非管理员返回与密码错误相同的错误码,
 *    避免通过该入口探测哪些账号是管理员;
 *  - 普通站点会话无法访问 /api/admin/**,反之亦然。
 */
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @SkipCsrf()
  @Throttle(authThrottle)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(zodBody(adminLoginSchema)) dto: AdminLoginInput,
    @ClientInfo() meta: { ip: string | null; userAgent: string | null },
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionUser> {
    return this.auth.login({ ...dto, remember: false }, SessionScope.ADMIN, meta, res);
  }

  @Public()
  @Get('me')
  async me(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthStateResponse> {
    const user = req.authUser;
    const sessionToken = req.authSession?.token;
    if (!user || !sessionToken) return { user: null, csrfToken: null };

    // 每次 /me 刷新管理站 CSRF,自愈「站点 CSRF 覆盖」或部署后 Cookie 名变更
    const csrfToken = this.sessions.refreshCsrfCookie({
      scope: SessionScope.ADMIN,
      sessionToken,
      response: res,
    });
    return { user: await this.auth.buildSessionUser(user.id), csrfToken };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(req.authSession?.token, SessionScope.ADMIN, res);
  }

  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logoutEverywhere(user, SessionScope.ADMIN, res);
  }
}
