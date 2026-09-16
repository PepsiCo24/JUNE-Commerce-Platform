import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AuditModule } from './common/audit/audit.module';
import { CsrfGuard } from './common/auth/csrf.guard';
import { ReauthGuard } from './common/auth/reauth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { SessionGuard } from './common/auth/session.guard';
import { CryptoModule } from './common/crypto/crypto.module';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { loadEnv } from './config/env';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { AdminModule } from './modules/admin/admin.module';
import { AssetsModule } from './modules/assets/assets.module';
import { AuthModule } from './modules/auth/auth.module';
import { CommerceModule } from './modules/commerce/commerce.module';
import { CommunityModule } from './modules/community/community.module';
import { ContentModule } from './modules/content/content.module';
import { EventsModule } from './modules/events/events.module';
import { GenerationModule } from './modules/generation/generation.module';
import { HealthModule } from './modules/health/health.module';
import { ModelsModule } from './modules/models/models.module';
import { QueueModule } from './modules/queue/queue.module';
import { StorageModule } from './modules/storage/storage.module';

const env = loadEnv();

/**
 * 应用根模块。
 *
 * 全局守卫的执行顺序即数组顺序:
 *   限流 → 会话 → CSRF → 角色/权限 → 敏感操作重验
 * 顺序很关键:必须先有会话才能校验 CSRF(CSRF 令牌与会话绑定),
 * 也必须先解析出用户才能判断角色。
 */
@Module({
  imports: [
    // 基础设施(全局)
    PrismaModule,
    RedisModule,
    CryptoModule,
    AuditModule,
    QueueModule,
    ScheduleModule.forRoot(),

    // 限流:只注册 default。Nest Throttler 会对「已注册的每个命名限流器」在所有路由上计数;
    // 若把 auth/upload/ai 也挂进 forRoot,会把 upload=60 误加到社区列表等读接口上。
    // 更严的限额用 @Throttle({ default: { limit, ttl } }) 覆盖到具体写接口。
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: env.RATE_LIMIT_GLOBAL_PER_MINUTE }],
    }),

    // 业务模块
    StorageModule,
    AssetsModule,
    AuthModule,
    HealthModule,
    CommunityModule,
    CommerceModule,
    // ModelsModule 必须在 ContentModule / GenerationModule / EventsModule 之前,
    // 后三者都依赖它导出的 ModelConfigService / ModelResolverService
    ModelsModule,
    ContentModule,
    GenerationModule,
    EventsModule,
    AdminModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ReauthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
