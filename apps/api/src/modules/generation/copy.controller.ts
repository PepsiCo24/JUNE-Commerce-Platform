import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { copySaveSchema, type CopySaveInput, type CopySaveResponse } from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { CurrentUser } from '../../common/auth/auth.decorators';
import { zodBody } from '../../common/validation/zod-body.pipe';
import { CopyService } from './copy.service';

/**
 * 文案保存接口。
 *
 * 保存前会执行输出检查:用户手动改回违禁表达同样会被拦下。
 * 未通过时返回 saved=false 与完整违规列表(HTTP 200),
 * 这样前端可以逐条高亮提示,而不是只拿到一个笼统的错误码。
 */
@Controller('copy')
export class CopyController {
  constructor(private readonly copy: CopyService) {}

  @Post('save')
  @HttpCode(200)
  async save(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(copySaveSchema)) dto: CopySaveInput,
  ): Promise<CopySaveResponse> {
    return this.copy.saveEditedCopy(user, dto);
  }

  /** 编辑过程中的预检,不写库 */
  @Post('check')
  @HttpCode(200)
  async check(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(copySaveSchema)) dto: CopySaveInput,
  ): Promise<{ check: CopySaveResponse['check']; disclaimer: string }> {
    return this.copy.previewCheck(user, dto);
  }
}
