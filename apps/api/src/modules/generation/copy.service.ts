import { Injectable } from '@nestjs/common';
import { CONTENT_CHECK_DISCLAIMER, type CopySaveInput, type CopySaveResponse } from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ContentRuleService } from '../content/content-rule.service';

/**
 * 文案保存。
 *
 * 关键点:**用户编辑后的内容同样要过输出检查**。
 * 只检查模型输出是不够的——用户完全可以把违禁词手动加回去再保存,
 * 那样平台侧的检查就形同虚设。
 */
@Injectable()
export class CopyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly content: ContentRuleService,
  ) {}

  async saveEditedCopy(user: AuthUser, dto: CopySaveInput): Promise<CopySaveResponse> {
    const product = await this.prisma.db.product.findFirst({
      where: { id: dto.productId, ownerId: user.id, deletedAt: null },
      select: { id: true, shop: { select: { platform: true } } },
    });
    if (!product) throw AppException.notOwner();

    // 平台规则按商品所属店铺的平台判定;未填写平台时用通用规则
    const platform = product.shop?.platform ?? 'other';
    const check = await this.content.checkOutput({ titles: [dto.title], body: dto.body }, platform);

    if (!check.passed) {
      // 拒绝保存,但把违规详情原样带回,让用户知道改哪里
      return {
        productId: product.id,
        check,
        saved: false,
        disclaimer: CONTENT_CHECK_DISCLAIMER,
      };
    }

    await this.prisma.db.product.update({
      where: { id: product.id },
      data: { title: dto.title, description: dto.body },
    });

    return {
      productId: product.id,
      check,
      saved: true,
      // 明确不宣称"能保证第三方审核通过":平台规则由各电商独立调整
      disclaimer: CONTENT_CHECK_DISCLAIMER,
    };
  }

  /** 保存前预检:前端可在用户编辑过程中调用,提前提示违规项 */
  async previewCheck(
    user: AuthUser,
    dto: CopySaveInput,
  ): Promise<{ check: CopySaveResponse['check']; disclaimer: string }> {
    const product = await this.prisma.db.product.findFirst({
      where: { id: dto.productId, ownerId: user.id, deletedAt: null },
      select: { shop: { select: { platform: true } } },
    });
    if (!product) throw AppException.notOwner();

    const platform = product.shop?.platform ?? 'other';
    const check = await this.content.checkOutput({ titles: [dto.title], body: dto.body }, platform);
    return { check, disclaimer: CONTENT_CHECK_DISCLAIMER };
  }
}
