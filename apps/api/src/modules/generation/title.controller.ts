import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { titleSaveSchema, type TitleSaveInput, type TitleSaveResponse } from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { CurrentUser } from '../../common/auth/auth.decorators';
import { zodBody } from '../../common/validation/zod-body.pipe';
import { TitleService } from './title.service';

@Controller('title')
export class TitleController {
  constructor(private readonly title: TitleService) {}

  @Post('save')
  @HttpCode(200)
  async save(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(titleSaveSchema)) dto: TitleSaveInput,
  ): Promise<TitleSaveResponse> {
    return this.title.saveTitle(user, dto);
  }
}
