import { Injectable } from '@nestjs/common';
import type { PostAuthorSummary } from '@june/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { AssetUrlService } from '../assets/asset-url.service';

/**
 * 作者信息批量装载。
 *
 * 帖子列表、评论列表都需要展示作者昵称与头像,逐条去查会立刻退化成 N+1,
 * 因此统一用一次 `IN` 查询取回,再在内存里按 id 组装。
 */
@Injectable()
export class AuthorSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly urls: AssetUrlService,
  ) {}

  async loadMany(userIds: string[]): Promise<Map<string, PostAuthorSummary>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (unique.length === 0) return new Map();

    const users = await this.prisma.db.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true, avatarKey: true },
    });

    const entries = await Promise.all(
      users.map(async (user): Promise<[string, PostAuthorSummary]> => [
        user.id,
        {
          id: user.id,
          displayName: user.displayName,
          // 头像是 PUBLIC 资产,优先走公共直连地址,拿不到再退回短时签名 URL
          avatarUrl: user.avatarKey ? await this.urls.signObjectKey(user.avatarKey, true) : null,
        },
      ]),
    );

    return new Map(entries);
  }

  /** 作者已注销时的占位,保证列表不会因为缺一条用户记录而整体失败 */
  fallback(userId: string): PostAuthorSummary {
    return { id: userId, displayName: '已注销用户', avatarUrl: null };
  }

  resolve(map: Map<string, PostAuthorSummary>, userId: string): PostAuthorSummary {
    return map.get(userId) ?? this.fallback(userId);
  }
}
