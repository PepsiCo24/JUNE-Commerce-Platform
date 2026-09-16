import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, ShopCredential } from '@june/db';
import {
  PASSWORD_DISPLAY_MASK,
  type CredentialCreateInput,
  type CredentialRevealResponse,
  type CredentialSummary,
  type PageResult,
  type credentialListQuerySchema,
  type credentialUpdateSchema,
} from '@june/shared';
import { nanoid } from 'nanoid';
import type { z } from 'zod';

import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-context';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { ClientMeta } from './commerce.types';
import { ShopsService } from './shops.service';

export type CredentialListQuery = z.infer<typeof credentialListQuerySchema>;
export type CredentialUpdateInput = z.infer<typeof credentialUpdateSchema>;

/** 明文在前端的建议保留时长(秒)。到期前端自动隐藏,减少肩窥与截图风险。 */
const CREDENTIAL_REVEAL_VISIBLE_SECONDS = 30;

/** 预生成 id 的长度。字符集与 idSchema 一致(A-Za-z0-9_-)。 */
const CREDENTIAL_ID_LENGTH = 24;

/**
 * 店铺账号凭据。
 *
 * 安全约定:
 *  - 密码用 AES-256-GCM 加密存储,**AAD 绑定记录自身**(`credential:<id>`),
 *    把 A 记录的密文搬到 B 记录上解密必然失败;
 *  - 列表/详情等普通接口只返回固定掩码,绝不返回明文,也不泄漏真实长度;
 *  - 取明文只有 reveal 一个入口,且必须通过 ReauthGuard 的一次性令牌,并强制写审计。
 */
@Injectable()
export class CredentialsService {
  private readonly logger = new Logger(CredentialsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly shops: ShopsService,
  ) {}

  // ---------------------------------------------------------------------------
  // 列表 / 搜索
  // ---------------------------------------------------------------------------

  async list(
    user: AuthUser,
    shopId: string,
    query: CredentialListQuery,
  ): Promise<PageResult<CredentialSummary>> {
    const shop = await this.shops.mustOwn(user, shopId);

    const where: Prisma.ShopCredentialWhereInput = {
      shopId: shop.id,
      ownerId: user.id,
      deletedAt: null,
      ...(query.q
        ? {
            OR: [
              { purpose: { contains: query.q, mode: 'insensitive' } },
              { account: { contains: query.q, mode: 'insensitive' } },
              { note: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.db.shopCredential.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.db.shopCredential.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.toSummary(row, shop.name)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  // ---------------------------------------------------------------------------
  // 写入
  // ---------------------------------------------------------------------------

  /**
   * 创建凭据。
   * 先预生成 id 再加密,这样 AAD 从一开始就绑定最终记录,
   * 不需要"先落占位密文再回填"的两步写入。
   */
  async create(
    user: AuthUser,
    shopId: string,
    input: CredentialCreateInput,
    meta: ClientMeta,
  ): Promise<CredentialSummary> {
    const shop = await this.shops.mustOwn(user, shopId);

    const id = nanoid(CREDENTIAL_ID_LENGTH);
    const sealed = this.crypto.seal(input.password, 'credential', credentialAad(id));

    const created = await this.prisma.db.shopCredential.create({
      data: {
        id,
        shopId: shop.id,
        ownerId: user.id,
        purpose: input.purpose,
        account: input.account,
        loginUrl: input.loginUrl ?? null,
        note: input.note ?? null,
        passwordCipher: sealed.cipher,
        passwordIv: sealed.iv,
        passwordTag: sealed.tag,
        keyVersion: sealed.keyVersion,
        passwordUpdatedAt: new Date(),
      },
    });

    await this.audit.record({
      actor: user,
      action: 'credential.create',
      targetType: 'ShopCredential',
      targetId: created.id,
      metadata: { shopId: shop.id, purpose: created.purpose, account: created.account },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.toSummary(created, shop.name);
  }

  /** 更新凭据。不传 password 表示不改密码;传了则重新加密并刷新 passwordUpdatedAt。 */
  async update(
    user: AuthUser,
    shopId: string,
    id: string,
    input: CredentialUpdateInput,
    meta: ClientMeta,
  ): Promise<CredentialSummary> {
    const shop = await this.shops.mustOwn(user, shopId);
    const before = await this.mustOwnCredential(user, shop.id, id);

    const data: Prisma.ShopCredentialUncheckedUpdateInput = {
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.account !== undefined ? { account: input.account } : {}),
      ...(input.loginUrl !== undefined ? { loginUrl: input.loginUrl ?? null } : {}),
      ...(input.note !== undefined ? { note: input.note ?? null } : {}),
    };

    if (input.password !== undefined) {
      // AAD 用记录自身的 id,轮换密码不改变绑定关系
      const sealed = this.crypto.seal(input.password, 'credential', credentialAad(before.id));
      data.passwordCipher = sealed.cipher;
      data.passwordIv = sealed.iv;
      data.passwordTag = sealed.tag;
      data.keyVersion = sealed.keyVersion;
      data.passwordUpdatedAt = new Date();
    }

    const updated = await this.prisma.db.shopCredential.update({ where: { id: before.id }, data });

    await this.audit.record({
      actor: user,
      action: 'credential.update',
      targetType: 'ShopCredential',
      targetId: updated.id,
      // 只对非敏感字段做 diff,密码是否变更单独用布尔表示,绝不进入日志内容
      diff: this.audit.buildDiff(
        {
          purpose: before.purpose,
          account: before.account,
          loginUrl: before.loginUrl,
          note: before.note,
        },
        {
          purpose: updated.purpose,
          account: updated.account,
          loginUrl: updated.loginUrl,
          note: updated.note,
        },
      ),
      metadata: { shopId: shop.id, passwordRotated: input.password !== undefined },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.toSummary(updated, shop.name);
  }

  /** 删除凭据(软删) */
  async remove(user: AuthUser, shopId: string, id: string, meta: ClientMeta): Promise<void> {
    const shop = await this.shops.mustOwn(user, shopId);
    const credential = await this.mustOwnCredential(user, shop.id, id);

    await this.prisma.db.shopCredential.update({
      where: { id: credential.id },
      data: { deletedAt: new Date() },
    });

    await this.audit.record({
      actor: user,
      action: 'credential.delete',
      targetType: 'ShopCredential',
      targetId: credential.id,
      metadata: { shopId: shop.id, purpose: credential.purpose },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  // ---------------------------------------------------------------------------
  // 受控解密
  // ---------------------------------------------------------------------------

  /**
   * 取回明文密码。唯一的解密出口。
   *
   * 鉴权链路:SessionGuard(登录) → CsrfGuard(写请求) → ReauthGuard(一次性重验令牌)
   *          → 这里再按 ownerId 校验归属。管理员也无法读取他人的凭据。
   */
  async reveal(
    user: AuthUser,
    shopId: string,
    id: string,
    meta: ClientMeta,
  ): Promise<CredentialRevealResponse> {
    const shop = await this.shops.mustOwn(user, shopId);
    const credential = await this.mustOwnCredential(user, shop.id, id);

    let password: string;
    try {
      password = this.crypto.open(
        {
          cipher: credential.passwordCipher,
          iv: credential.passwordIv,
          tag: credential.passwordTag,
          keyVersion: credential.keyVersion,
        },
        'credential',
        credentialAad(credential.id),
      );
    } catch (err) {
      // 解密失败也要留痕(可能是密钥配置错误或数据被篡改),但不记录任何密文片段
      await this.audit.record({
        actor: user,
        action: 'credential.reveal',
        targetType: 'ShopCredential',
        targetId: credential.id,
        metadata: { shopId: shop.id, reason: 'decrypt_failed' },
        ip: meta.ip,
        userAgent: meta.userAgent,
        result: 'failure',
      });
      this.logger.error(`凭据 ${credential.id} 解密失败:${(err as Error).message}`);
      throw AppException.internal('凭据解密失败,请联系管理员检查密钥配置');
    }

    // 审计是硬要求:记录谁在什么时候、从哪个 IP 看了哪条凭据,但绝不记录密码本身
    await this.audit.record({
      actor: user,
      action: 'credential.reveal',
      targetType: 'ShopCredential',
      targetId: credential.id,
      metadata: { shopId: shop.id, purpose: credential.purpose, account: credential.account },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      id: credential.id,
      password,
      expiresInSeconds: CREDENTIAL_REVEAL_VISIBLE_SECONDS,
    };
  }

  /**
   * 前端点"复制"时调用:只写审计,不返回明文。
   * 明文来自此前的 reveal 结果,复制动作本身不再经过服务端。
   */
  async recordCopy(user: AuthUser, shopId: string, id: string, meta: ClientMeta): Promise<void> {
    const shop = await this.shops.mustOwn(user, shopId);
    const credential = await this.mustOwnCredential(user, shop.id, id);

    await this.audit.record({
      actor: user,
      action: 'credential.copy',
      targetType: 'ShopCredential',
      targetId: credential.id,
      metadata: { shopId: shop.id, purpose: credential.purpose },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  // ---------------------------------------------------------------------------

  private async mustOwnCredential(
    user: AuthUser,
    shopId: string,
    id: string,
  ): Promise<ShopCredential> {
    const credential = await this.prisma.db.shopCredential.findFirst({
      where: { id, shopId, ownerId: user.id, deletedAt: null },
    });
    if (!credential) throw AppException.notOwner();
    return credential;
  }

  private toSummary(row: ShopCredential, shopName: string): CredentialSummary {
    return {
      id: row.id,
      shopId: row.shopId,
      shopName,
      purpose: row.purpose,
      account: row.account,
      loginUrl: row.loginUrl,
      note: row.note,
      // 固定掩码:既不返回明文,也不通过长度泄漏信息
      passwordMask: PASSWORD_DISPLAY_MASK,
      passwordUpdatedAt: row.passwordUpdatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** 加密附加认证数据:把密文与具体记录绑定,跨记录搬运密文会解密失败 */
export function credentialAad(credentialId: string): string {
  return `credential:${credentialId}`;
}
