import { Module } from '@nestjs/common';

import { ModelAdminController } from './model-admin.controller';
import { ModelAdminService } from './model-admin.service';
import { ModelConfigService } from './model-config.service';
import { ModelResolverService } from './model-resolver.service';

/**
 * 模型配置模块。
 *
 * 导出 ModelConfigService(公开配置 + 配置版本广播)与
 * ModelResolverService(提交任务时的模型裁决),供生成、内容与 SSE 模块使用。
 */
@Module({
  controllers: [ModelAdminController],
  providers: [ModelConfigService, ModelResolverService, ModelAdminService],
  exports: [ModelConfigService, ModelResolverService],
})
export class ModelsModule {}
