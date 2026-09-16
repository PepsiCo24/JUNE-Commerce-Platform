import { Module } from '@nestjs/common';

import { ModelsModule } from '../models/models.module';
import { ContentRuleAdminController } from './content-rule-admin.controller';
import { ContentRuleAdminService } from './content-rule-admin.service';
import { ContentRuleService } from './content-rule.service';

/**
 * 内容规则模块。
 *
 * 依赖 ModelsModule 只为了复用 ConfigRevision 的版本自增与广播能力
 * (内容规则与模型配置共用同一套"版本号 + SSE 通知 + 补拉"的热更新链路)。
 * 对外导出 ContentRuleService,供生成与文案模块做输入/输出检查。
 */
@Module({
  imports: [ModelsModule],
  controllers: [ContentRuleAdminController],
  providers: [ContentRuleService, ContentRuleAdminService],
  exports: [ContentRuleService],
})
export class ContentModule {}
