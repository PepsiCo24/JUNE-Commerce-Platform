import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  copyGenerateSchema,
  idSchema,
  imageGenerateSchema,
  titleGenerateSchema,
  imageRetrySchema,
  saveResultToPostSchema,
  saveResultToProductSchema,
  taskListQuerySchema,
  type CopyGenerateInput,
  type TitleGenerateInput,
  type CursorResult,
  type GenerationTaskView,
  type ImageGenerateInput,
  type TaskSubmitResponse,
} from '@june/shared';
import type { z } from 'zod';

import type { AuthUser } from '../../common/auth/auth-context';
import { CurrentUser } from '../../common/auth/auth.decorators';
import { zodBody, zodQuery } from '../../common/validation/zod-body.pipe';
import { loadEnv } from '../../config/env';
import {
  GenerationService,
  type BatchDownloadItem,
  type ImageRetryInput,
  type SaveResultsResponse,
  type SaveToPostInput,
  type SaveToProductInput,
  type TaskListQueryInput,
} from './generation.service';

const env = loadEnv();

/**
 * AI 提交接口的专用限流。
 *
 * 覆盖路由级 default:生图与文案会触发付费上游调用,不能只靠全站通用限额。
 * (勿再注册独立命名限流器 'ai':Nest 会对所有已注册命名器在每条路由上计数。)
 */
const aiThrottle = {
  default: { limit: env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE, ttl: 60_000 },
};

@Controller('generation')
export class GenerationController {
  constructor(private readonly generation: GenerationService) {}

  /** 提交生图任务。快速返回 taskId,不等待生成完成。 */
  @Post('image')
  @HttpCode(202)
  @Throttle(aiThrottle)
  async submitImage(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(imageGenerateSchema)) dto: ImageGenerateInput,
  ): Promise<TaskSubmitResponse> {
    return this.generation.submitImage(user, dto);
  }

  /** 只重试失败的序号。已成功的图片不会重复生成,也不会重复计费。 */
  @Post('image/:taskId/retry')
  @HttpCode(202)
  @Throttle(aiThrottle)
  async retryImage(
    @CurrentUser() user: AuthUser,
    @Param('taskId', zodBody(idSchema)) taskId: string,
    @Body(zodBody(imageRetrySchema)) dto: ImageRetryInput,
  ): Promise<TaskSubmitResponse> {
    return this.generation.retryImage(user, taskId, dto);
  }

  /** 提交文案任务。入队前先做输入检查,未通过不消耗上游调用。 */
  @Post('copy')
  @HttpCode(202)
  @Throttle(aiThrottle)
  async submitCopy(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(copyGenerateSchema)) dto: CopyGenerateInput,
  ): Promise<TaskSubmitResponse> {
    return this.generation.submitCopy(user, dto);
  }

  /** 提交标题生成任务 */
  @Post('title')
  @HttpCode(202)
  @Throttle(aiThrottle)
  async submitTitle(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(titleGenerateSchema)) dto: TitleGenerateInput,
  ): Promise<TaskSubmitResponse> {
    return this.generation.submitTitle(user, dto);
  }

  @Get('tasks')
  async listTasks(
    @CurrentUser() user: AuthUser,
    @Query(zodQuery(taskListQuerySchema)) query: z.infer<typeof taskListQuerySchema>,
  ): Promise<CursorResult<GenerationTaskView>> {
    return this.generation.listTasks(user, query as TaskListQueryInput);
  }

  @Get('tasks/:taskId')
  async getTask(
    @CurrentUser() user: AuthUser,
    @Param('taskId', zodBody(idSchema)) taskId: string,
  ): Promise<GenerationTaskView> {
    return this.generation.getTask(user, taskId);
  }

  /** 保存结果到商品:复用同一 Asset,不复制文件 */
  @Post('tasks/:taskId/save-to-product')
  @HttpCode(200)
  async saveToProduct(
    @CurrentUser() user: AuthUser,
    @Param('taskId', zodBody(idSchema)) taskId: string,
    @Body(zodBody(saveResultToProductSchema)) dto: SaveToProductInput,
  ): Promise<SaveResultsResponse> {
    return this.generation.saveResultsToProduct(user, taskId, dto);
  }

  @Post('tasks/:taskId/save-to-post')
  @HttpCode(200)
  async saveToPost(
    @CurrentUser() user: AuthUser,
    @Param('taskId', zodBody(idSchema)) taskId: string,
    @Body(zodBody(saveResultToPostSchema)) dto: SaveToPostInput,
  ): Promise<SaveResultsResponse> {
    return this.generation.saveResultsToPost(user, taskId, dto);
  }

  /** 批量下载:只返回签名地址,打包在客户端完成 */
  @Get('tasks/:taskId/download-batch')
  async downloadBatch(
    @CurrentUser() user: AuthUser,
    @Param('taskId', zodBody(idSchema)) taskId: string,
  ): Promise<BatchDownloadItem[]> {
    return this.generation.downloadBatch(user, taskId);
  }
}
