import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { AuthorSummaryService } from './author-summary.service';
import { BookmarksController } from './bookmarks.controller';
import { BookmarksService } from './bookmarks.service';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { DraftsController } from './drafts.controller';
import { DraftsService } from './drafts.service';
import { LikesController } from './likes.controller';
import { LikesService } from './likes.service';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { ShareController } from './share.controller';
import { ShareService } from './share.service';
import { UserSearchController } from './user-search.controller';

/**
 * 社区模块:帖子、草稿、评论、点赞、收藏、分享、用户搜索。
 */
@Module({
  imports: [AssetsModule],
  controllers: [
    PostsController,
    DraftsController,
    CommentsController,
    LikesController,
    BookmarksController,
    ShareController,
    UserSearchController,
  ],
  providers: [
    PostsService,
    DraftsService,
    CommentsService,
    LikesService,
    BookmarksService,
    ShareService,
    AuthorSummaryService,
  ],
  exports: [PostsService, DraftsService, CommentsService, LikesService, BookmarksService, ShareService],
})
export class CommunityModule {}
