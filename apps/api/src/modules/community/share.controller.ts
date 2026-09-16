import { Controller, Get, Param } from '@nestjs/common';
import type { ShareResponse } from '@june/shared';
import { z } from 'zod';

import { Public } from '../../common/auth/auth.decorators';
import { zodBody } from '../../common/validation/zod-body.pipe';
import { ShareService } from './share.service';

const slugSchema = z.string().trim().min(1).max(120);

@Controller('community/posts')
export class ShareController {
  constructor(private readonly share: ShareService) {}

  /**
   * 分享信息:元数据 + 后端生成的二维码 SVG + 各渠道可用性。
   * 未配置的渠道会明确返回不可用与降级方式,不伪造成功。
   */
  @Public()
  @Get(':slug/share')
  async get(@Param('slug', zodBody(slugSchema)) slug: string): Promise<ShareResponse> {
    return this.share.getShare(slug);
  }
}
