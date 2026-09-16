import { Global, Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { AdminAuthController } from './admin-auth.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

/**
 * 认证模块。SessionService 被全局守卫使用,因此这里标记为 @Global,
 * 避免每个业务模块都要重复 import。
 */
@Global()
@Module({
  imports: [AssetsModule],
  controllers: [AuthController, AdminAuthController],
  providers: [AuthService, SessionService],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
