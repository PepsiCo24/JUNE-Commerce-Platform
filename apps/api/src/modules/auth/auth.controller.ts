import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SessionScope } from '@june/db';
import {
  changePasswordSchema,
  loginSchema,
  reauthSchema,
  registerSchema,
  updateProfileSchema,
  type AuthStateResponse,
  type ChangePasswordInput,
  type LoginInput,
  type ReauthInput,
  type RegisterInput,
  type SessionUser,
  type UpdateProfileInput,
} from '@june/shared';
import type { Response } from 'express';

import type { AuthenticatedRequest, AuthUser } from '../../common/auth/auth-context';
import {
  ClientInfo,
  CurrentUser,
  Public,
  SkipCsrf,
} from '../../common/auth/auth.decorators';
import { zodBody } from '../../common/validation/zod-body.pipe';
import { loadEnv } from '../../config/env';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

const authThrottle = {
  default: { limit: loadEnv().RATE_LIMIT_AUTH_PER_MINUTE, ttl: 60_000 },
};

/**
 * 站点认证接口。社区与工作台共用同一套用户、资料与会话。
 * /admin 的登录入口在 AdminAuthController,使用独立 Cookie 与作用域。
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  /** 当前登录状态。前端启动时调用一次,同时拿到 CSRF 令牌。 */
  @Public()
  @Get('me')
  async me(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthStateResponse> {
    const user = req.authUser;
    const sessionToken = req.authSession?.token;
    if (!user || !sessionToken) return { user: null, csrfToken: null };

    const csrfToken = this.sessions.refreshCsrfCookie({
      scope: SessionScope.SITE,
      sessionToken,
      response: res,
    });
    return { user: await this.auth.buildSessionUser(user.id), csrfToken };
  }

  @Public()
  @SkipCsrf()
  @Throttle(authThrottle)
  @Post('register')
  async register(
    @Body(zodBody(registerSchema)) dto: RegisterInput,
    @ClientInfo() meta: { ip: string | null; userAgent: string | null },
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionUser> {
    return this.auth.register(dto, meta, res);
  }

  @Public()
  @SkipCsrf()
  @Throttle(authThrottle)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(zodBody(loginSchema)) dto: LoginInput,
    @ClientInfo() meta: { ip: string | null; userAgent: string | null },
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionUser> {
    return this.auth.login(dto, SessionScope.SITE, meta, res);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(req.authSession?.token, SessionScope.SITE, res);
  }

  /** 退出全部设备:前移 sessionEpoch,所有旧会话立即失效 */
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logoutEverywhere(user, SessionScope.SITE, res);
  }

  @Patch('profile')
  async updateProfile(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(updateProfileSchema)) dto: UpdateProfileInput,
    @ClientInfo() meta: { ip: string | null; userAgent: string | null },
  ): Promise<SessionUser> {
    return this.auth.updateProfile(user, dto, meta);
  }

  /**
   * 修改密码。成功后当前会话也会失效,前端需要引导重新登录。
   * 返回 sessionInvalidated 标记让前端明确知道要跳转。
   */
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(changePasswordSchema)) dto: ChangePasswordInput,
    @ClientInfo() meta: { ip: string | null; userAgent: string | null },
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ sessionInvalidated: true }> {
    await this.auth.changePassword(user, dto, meta, res, SessionScope.SITE);
    return { sessionInvalidated: true };
  }

  /**
   * 敏感操作重新验证。返回一次性短时令牌,
   * 调用查看店铺密码接口时放在 `x-june-reauth` 头中。
   */
  @Post('reauth')
  @HttpCode(200)
  async reauth(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(reauthSchema)) dto: ReauthInput,
    @ClientInfo() meta: { ip: string | null; userAgent: string | null },
  ): Promise<{ token: string; expiresAt: string }> {
    return this.auth.createReauthToken(user, dto.password, meta);
  }
}
