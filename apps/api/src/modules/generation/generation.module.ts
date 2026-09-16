import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { ContentModule } from '../content/content.module';
import { ModelsModule } from '../models/models.module';
import { CopyController } from './copy.controller';
import { CopyService } from './copy.service';
import { GenerationController } from './generation.controller';
import { GenerationService } from './generation.service';
import { ModelsPublicController } from './models-public.controller';

/**
 * 生成任务模块(生图 / 文案)。
 *
 * 依赖:
 *  - ModelsModule  提供模型裁决与公开配置;
 *  - ContentModule 提供输入/输出内容检查与系统提示词拼装;
 *  - AssetsModule  提供参考图归属校验与结果资产复用;
 *  - QueueModule   全局模块,提供入队与队列容量判断。
 */
@Module({
  imports: [ModelsModule, ContentModule, AssetsModule],
  controllers: [GenerationController, CopyController, ModelsPublicController],
  providers: [GenerationService, CopyService],
  exports: [GenerationService],
})
export class GenerationModule {}
