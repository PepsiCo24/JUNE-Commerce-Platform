import { Injectable, Logger } from '@nestjs/common';
import type { AlipayAccount, Prisma } from '@june/db';
import {
  ERROR_CODES,
  maskPhone,
  type AlipayAccountCreateInput,
  type AlipayAccountDetail,
  type AlipayAccountSummary,
  type AlipayAccountUpdateInput,
  type AlipayPasswordRevealResponse,
  type AlipayPhoneRevealResponse,
  type PageResult,
  type alipayAccountListQuerySchema,
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

export type AlipayAccountListQuery = z.infer<typeof alipayAccountListQuerySchema>;

const REVEAL_VISIBLE_SECONDS = 30;
const ALIPAY_ID_LENGTH = 24;

/** 清空密码时写入的占位明文:不可用于登录,仅用于覆盖旧密文 */
const CLEARED_PASSWORD_PLACEHOLDER = '';

@Injectable()
export class AlipayAccountsService {
  private readonly logger = new Logger(AlipayAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly shops: ShopsService,
  ) {}

  async list(user: AuthUser, query: AlipayAccountListQuery): Promise<PageResult<AlipayAccountSummary>> {
    const where: Prisma.AlipayAccountWhereInput = {
      ownerId: user.id,
      deletedAt: null,
      ...(query.shopId ? { shopId: query.shopId } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { phone: { contains: query.q, mode: 'insensitive' } },
              { note: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.db.alipayAccount.findMany({
        where,
        include: { shop: { select: { name: true } } },
        orderBy: [{ updatedAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.db.alipayAccount.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.toSummary(row, row.shop?.name ?? null)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  async detail(user: AuthUser, id: string): Promise<AlipayAccountDetail> {
    const row = await this.mustOwn(user, id);
    const shopName = row.shopId
      ? (
          await this.prisma.db.shop.findFirst({
            where: { id: row.shopId, deletedAt: null },
            select: { name: true },
          })
        )?.name ?? null
      : null;
    return this.toSummary(row, shopName);
  }

  async create(
    user: AuthUser,
    input: AlipayAccountCreateInput,
    meta: ClientMeta,
  ): Promise<AlipayAccountSummary> {
    if (input.shopId) {
      await this.shops.mustOwn(user, input.shopId);
    }

    const id = nanoid(ALIPAY_ID_LENGTH);
    const sealed = this.crypto.seal(input.password, 'credential', alipayAad(id));

    const created = await this.prisma.db.alipayAccount.create({
      data: {
        id,
        ownerId: user.id,
        name: input.name,
        phone: input.phone,
        note: input.note ?? null,
        shopId: input.shopId ?? null,
        hasPassword: true,
        passwordCipher: sealed.cipher,
        passwordIv: sealed.iv,
        passwordTag: sealed.tag,
        keyVersion: sealed.keyVersion,
        passwordUpdatedAt: new Date(),
      },
      include: { shop: { select: { name: true } } },
    });

    await this.audit.record({
      actor: user,
      action: 'alipay.create',
      targetType: 'AlipayAccount',
      targetId: created.id,
      metadata: { name: created.name, shopId: created.shopId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.toSummary(created, created.shop?.name ?? null);
  }

  async update(
    user: AuthUser,
    id: string,
    input: AlipayAccountUpdateInput,
    meta: ClientMeta,
  ): Promise<AlipayAccountSummary> {
    const before = await this.mustOwn(user, id);

    if (input.shopId) {
      await this.shops.mustOwn(user, input.shopId);
    }

    const data: Prisma.AlipayAccountUncheckedUpdateInput = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.note !== undefined ? { note: input.note ?? null } : {}),
      ...(input.shopId !== undefined ? { shopId: input.shopId ?? null } : {}),
    };

    let passwordRotated = false;
    let passwordCleared = false;

    if (input.clearPassword) {
      const sealed = this.crypto.seal(CLEARED_PASSWORD_PLACEHOLDER, 'credential', alipayAad(before.id));
      data.passwordCipher = sealed.cipher;
      data.passwordIv = sealed.iv;
      data.passwordTag = sealed.tag;
      data.keyVersion = sealed.keyVersion;
      data.passwordUpdatedAt = new Date();
      data.hasPassword = false;
      passwordCleared = true;
    } else if (input.password !== undefined) {
      const sealed = this.crypto.seal(input.password, 'credential', alipayAad(before.id));
      data.passwordCipher = sealed.cipher;
      data.passwordIv = sealed.iv;
      data.passwordTag = sealed.tag;
      data.keyVersion = sealed.keyVersion;
      data.passwordUpdatedAt = new Date();
      data.hasPassword = true;
      passwordRotated = true;
    }

    const updated = await this.prisma.db.alipayAccount.update({
      where: { id: before.id },
      data,
      include: { shop: { select: { name: true } } },
    });

    await this.audit.record({
      actor: user,
      action: 'alipay.update',
      targetType: 'AlipayAccount',
      targetId: updated.id,
      diff: this.audit.buildDiff(
        { name: before.name, phone: before.phone, note: before.note, shopId: before.shopId },
        { name: updated.name, phone: updated.phone, note: updated.note, shopId: updated.shopId },
      ),
      metadata: { passwordRotated, passwordCleared },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.toSummary(updated, updated.shop?.name ?? null);
  }

  async remove(user: AuthUser, id: string, meta: ClientMeta): Promise<void> {
    const row = await this.mustOwn(user, id);
    await this.prisma.db.alipayAccount.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });

    await this.audit.record({
      actor: user,
      action: 'alipay.delete',
      targetType: 'AlipayAccount',
      targetId: row.id,
      metadata: { name: row.name },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async revealPhone(
    user: AuthUser,
    id: string,
    meta: ClientMeta,
  ): Promise<AlipayPhoneRevealResponse> {
    const row = await this.mustOwn(user, id);

    await this.audit.record({
      actor: user,
      action: 'alipay.reveal_phone',
      targetType: 'AlipayAccount',
      targetId: row.id,
      metadata: { name: row.name },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { id: row.id, phone: row.phone };
  }

  async revealPassword(
    user: AuthUser,
    id: string,
    meta: ClientMeta,
  ): Promise<AlipayPasswordRevealResponse> {
    const row = await this.mustOwn(user, id);

    if (!row.hasPassword) {
      throw AppException.badRequest(ERROR_CODES.VALIDATION_FAILED, '该账户尚未设置登录密码');
    }

    let password: string;
    try {
      password = this.crypto.open(
        {
          cipher: row.passwordCipher,
          iv: row.passwordIv,
          tag: row.passwordTag,
          keyVersion: row.keyVersion,
        },
        'credential',
        alipayAad(row.id),
      );
    } catch (err) {
      await this.audit.record({
        actor: user,
        action: 'alipay.reveal_password',
        targetType: 'AlipayAccount',
        targetId: row.id,
        metadata: { reason: 'decrypt_failed' },
        ip: meta.ip,
        userAgent: meta.userAgent,
        result: 'failure',
      });
      this.logger.error(`支付宝账户 ${row.id} 解密失败:${(err as Error).message}`);
      throw AppException.internal('密码解密失败,请联系管理员检查密钥配置');
    }

    await this.audit.record({
      actor: user,
      action: 'alipay.reveal_password',
      targetType: 'AlipayAccount',
      targetId: row.id,
      metadata: { name: row.name },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      id: row.id,
      password,
      expiresInSeconds: REVEAL_VISIBLE_SECONDS,
    };
  }

  async recordCopy(user: AuthUser, id: string, meta: ClientMeta): Promise<void> {
    const row = await this.mustOwn(user, id);
    await this.audit.record({
      actor: user,
      action: 'alipay.copy_password',
      targetType: 'AlipayAccount',
      targetId: row.id,
      metadata: { name: row.name },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  private async mustOwn(user: AuthUser, id: string): Promise<AlipayAccount> {
    const row = await this.prisma.db.alipayAccount.findFirst({
      where: { id, ownerId: user.id, deletedAt: null },
    });
    if (!row) throw AppException.notOwner();
    return row;
  }

  private toSummary(
    row: AlipayAccount,
    shopName: string | null,
  ): AlipayAccountSummary {
    return {
      id: row.id,
      name: row.name,
      phoneMasked: maskPhone(row.phone),
      hasPassword: row.hasPassword,
      note: row.note,
      shopId: row.shopId,
      shopName,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export function alipayAad(accountId: string): string {
  return `alipay:${accountId}`;
}
