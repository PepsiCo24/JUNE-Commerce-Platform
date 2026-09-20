import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  pageQuerySchema,
  type PageResult,
  type PostListItem,
  type PublicUserProfile,
} from '@june/shared';
import type { z } from 'zod';

import { Public } from '../../common/auth/auth.decorators';
import { zodQuery } from '../../common/validation/zod-body.pipe';
import { UserProfileService } from './user-profile.service';

type UserPostsQuery = z.infer<typeof pageQuerySchema>;

/**
 * 公开个人主页。不含邮箱、草稿、收藏等私密信息。
 */
@Controller('community/users')
export class UserProfileController {
  constructor(private readonly profiles: UserProfileService) {}

  @Public()
  @Get(':id')
  async getProfile(@Param('id') id: string): Promise<PublicUserProfile> {
    return this.profiles.getPublicProfile(id);
  }

  @Public()
  @Get(':id/posts')
  async listPosts(
    @Param('id') id: string,
    @Query(zodQuery(pageQuerySchema)) query: UserPostsQuery,
  ): Promise<PageResult<PostListItem>> {
    return this.profiles.listPublicPosts(id, query);
  }
}
