import { Controller, Get } from '@nestjs/common';
import type { PublicModelConfigResponse } from '@june/shared';

import { ModelConfigService } from '../models/model-config.service';

/**
 * 面向普通用户的模型配置。
 *
 * 只返回渲染表单必需的信息:**没有 API Key、没有 baseUrl、没有内部系统提示词**。
 * 未配置凭据或已停用的模型不会出现在列表里。
 *
 * 前端收到 SSE 的 config.updated(只带版本号)后回来补拉这个接口,
 * 这就是配置热更新的"补拉"一环;返回体里的 version 用于前端对齐。
 *
 * 需要登录:模型清单属于平台能力信息,不对游客开放。
 */
@Controller('models')
export class ModelsPublicController {
  constructor(private readonly models: ModelConfigService) {}

  @Get('config')
  async config(): Promise<PublicModelConfigResponse> {
    return this.models.getPublicConfig();
  }
}
