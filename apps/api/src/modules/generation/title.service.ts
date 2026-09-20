import { Injectable } from '@nestjs/common';
import {
  CONTENT_CHECK_DISCLAIMER,
  type TitleSaveInput,
  type TitleSaveResponse,
} from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ContentRuleService } from '../content/content-rule.service';

/** 标题保存:编辑后同样执行输出检查 */
@Injectable()
export class TitleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly content: ContentRuleService,
  ) {}

  async saveTitle(user: AuthUser, dto: TitleSaveInput): Promise<TitleSaveResponse> {
    const product = await this.prisma.db.product.findFirst({
      where: { id: dto.productId, ownerId: user.id, deletedAt: null },
      select: { id: true, shop: { select: { platform: true } } },
    });
    if (!product) throw AppException.notOwner();

    const platform = product.shop?.platform ?? 'other';
    const check = await this.content.checkOutput({ titles: [dto.title], body: '' }, platform);

    if (!check.passed) {
      return {
        productId: product.id,
        check,
        saved: false,
        disclaimer: CONTENT_CHECK_DISCLAIMER,
      };
    }

    await this.prisma.db.product.update({
      where: { id: product.id },
      data: { title: dto.title },
    });

    return {
      productId: product.id,
      check,
      saved: true,
      disclaimer: CONTENT_CHECK_DISCLAIMER,
    };
  }
}
