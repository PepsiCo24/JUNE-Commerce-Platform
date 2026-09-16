import { Module } from '@nestjs/common';

import { ModelsModule } from '../models/models.module';
import { SseController } from './sse.controller';
import { SseService } from './sse.service';

/**
 * SSE 模块。
 *
 * 依赖 ModelsModule 只为了在建连时读取各 scope 的配置版本号。
 * 导出 SseService,供其他模块做进程内定向推送
 * (Worker 侧直接发 Redis,不需要经过这里)。
 */
@Module({
  imports: [ModelsModule],
  controllers: [SseController],
  providers: [SseService],
  exports: [SseService],
})
export class EventsModule {}
