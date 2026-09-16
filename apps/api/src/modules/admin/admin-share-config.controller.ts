import { Body, Controller, Get, Put } from '@nestjs/common';
import { ROLE_ADMIN, ROLE_LEVEL } from '@june/db';
import { shareConfigUpdateSchema, type AdminShareConfigView, type ShareConfigUpdateInput } from '@june/shared';

import type { AuthUser } from '../../common/auth/auth-context';
import { ClientInfo, CurrentUser, MinRoleLevel } from '../../common/auth/auth.decorators';
import { zodBody } from '../../common/validation/zod-body.pipe';
import { AdminConfigService } from './admin-config.service';
import type { ClientMeta } from './admin-user.service';

/**
 * 分享配置:微信 appId/appSecret、QQ appId、分享域名。
 *
 * 读接口给管理员的是**掩码版**(appSecretMasked),明文只在写入时提交一次。
 * 社区模块需要的公开配置走 `AdminConfigService.getPublicShareConfig()`(内部调用,
 * 只含 appId 与开关,绝不含 secret),不经过本控制器。
 *
 * 二维码兜底开关不在契约的 shareConfigUpdateSchema 里,作为 `share.qrcodeEnabled`
 * 系统配置项管理(默认开启),避免修改共享契约。
 */
@Controller('admin/share-config')
@MinRoleLevel(ROLE_LEVEL[ROLE_ADMIN])
export class AdminShareConfigController {
  constructor(private readonly configs: AdminConfigService) {}

  @Get()
  async get(): Promise<AdminShareConfigView> {
    return this.configs.getShareConfig();
  }

  /** appSecret 传空字符串表示清除已保存的密钥;不传表示保持不变 */
  @Put()
  async update(
    @CurrentUser() actor: AuthUser,
    @Body(zodBody(shareConfigUpdateSchema)) dto: ShareConfigUpdateInput,
    @ClientInfo() meta: ClientMeta,
  ): Promise<AdminShareConfigView> {
    return this.configs.updateShareConfig(actor, dto, meta);
  }
}
