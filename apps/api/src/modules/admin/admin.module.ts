import { Module } from '@nestjs/common';

import { EventsModule } from '../events/events.module';
import { AdminAuditController } from './admin-audit.controller';
import { AdminAuditService } from './admin-audit.service';
import { AdminConfigController } from './admin-config.controller';
import { AdminConfigService } from './admin-config.service';
import { AdminContentController } from './admin-content.controller';
import { AdminContentService } from './admin-content.service';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminShareConfigController } from './admin-share-config.controller';
import { AdminStorageController } from './admin-storage.controller';
import { AdminStorageService } from './admin-storage.service';
import { AdminTaskController } from './admin-task.controller';
import { AdminTaskService } from './admin-task.service';
import { AdminUserController } from './admin-user.controller';
import { AdminUserService } from './admin-user.service';
import { ConfigRevisionService } from './config-revision.service';

/**
 * 管理站模块(不含模型管理与内容规则管理,那两块在 modules/models 与 modules/content)。
 *
 * 依赖说明:
 *  - PrismaService / RedisService / CryptoService / AuditService / QueueProducerService /
 *    SessionService 都来自 @Global 模块,无需在此 imports。
 *  - `ConfigRevisionService` 只操作 `config_revisions` 表并向 `SSE_CHANNELS.broadcast` 广播,
 *    与 models 模块的 bumpRevision 共用同一张表与频道,两个模块互不 import。
 *  - `AdminConfigService` 对外导出:社区/分享模块通过 `getPublicShareConfig()`
 *    拿到不含任何密钥的公开分享配置。
 */
@Module({
  imports: [EventsModule],
  controllers: [
    AdminDashboardController,
    AdminUserController,
    AdminContentController,
    AdminTaskController,
    AdminStorageController,
    AdminAuditController,
    AdminConfigController,
    AdminShareConfigController,
  ],
  providers: [
    AdminDashboardService,
    AdminUserService,
    AdminContentService,
    AdminTaskService,
    AdminStorageService,
    AdminAuditService,
    AdminConfigService,
    ConfigRevisionService,
  ],
  exports: [AdminConfigService, ConfigRevisionService],
})
export class AdminModule {}
