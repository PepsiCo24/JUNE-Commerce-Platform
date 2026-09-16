import { Controller, Delete, HttpCode, Param, Post } from '@nestjs/common';
import { idSchema } from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { CurrentUser } from '../../common/auth/auth.decorators';
import { zodBody } from '../../common/validation/zod-body.pipe';
import { LikesService, type LikeResult } from './likes.service';

@Controller('community/posts')
export class LikesController {
  constructor(private readonly likes: LikesService) {}

  /** 点赞。重复点赞返回 409 ALREADY_LIKED,由数据库唯一约束判定。 */
  @Post(':id/like')
  @HttpCode(200)
  async like(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
  ): Promise<LikeResult> {
    return this.likes.like(user, id);
  }

  /** 取消点赞。未点赞时返回 409 NOT_LIKED。 */
  @Delete(':id/like')
  @HttpCode(200)
  async unlike(
    @CurrentUser() user: AuthUser,
    @Param('id', zodBody(idSchema)) id: string,
  ): Promise<LikeResult> {
    return this.likes.unlike(user, id);
  }
}
