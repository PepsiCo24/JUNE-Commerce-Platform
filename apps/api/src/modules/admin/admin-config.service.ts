import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type SystemConfig } from '@june/db';
import {
  concurrencyConfigSchema,
  ERROR_CODES,
  maskSecret,
  PASSWORD_DISPLAY_MASK,
  type AdminShareConfigView,
  type ShareConfigUpdateInput,
} from '@june/shared';
import { z, type ZodType } from 'zod';

import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-context';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { ClientMeta } from './admin-user.service';
import type { AdminSystemConfigView, PublicShareConfig } from './admin.types';
import { ConfigRevisionService } from './config-revision.service';

// ---------------------------------------------------------------------------
// 键位约定
// ---------------------------------------------------------------------------

/** 分享配置的非敏感部分(单行 JSON) */
export const SHARE_CONFIG_KEY = 'share.config';
/** 微信 appSecret:isSecret=true,单独一行,加密存储 */
export const SHARE_WECHAT_SECRET_KEY = 'share.wechat.appSecret';
/** 二维码兜底开关。契约的 shareConfigUpdateSchema 没有这一项(不改契约),因此作为独立系统配置管理 */
export const SHARE_QRCODE_KEY = 'share.qrcodeEnabled';
/** 并发上限 */
export const CONCURRENCY_CONFIG_KEY = 'concurrency.limits';

/**
 * 只能通过专用接口写入的键。
 * 分享密钥必须走 `PUT /api/admin/share-config`,以保证 AAD、掩码与版本号语义一致;
 * 通用配置接口不允许绕过。
 */
const RESERVED_KEYS = new Set<string>([SHARE_WECHAT_SECRET_KEY]);

/** 不允许删除的键:删掉会让依赖它的功能行为不可预期 */
const UNDELETABLE_KEYS = new Set<string>([SHARE_CONFIG_KEY, CONCURRENCY_CONFIG_KEY]);

/**
 * 并发相关的**硬上限**。
 *
 * `concurrencyConfigSchema` 给的是绝对上限,这里按目标部署规格(4 核 8G、约 50 人在线)
 * 再收紧一层:即使管理员手填一个很大的值,也不会把机器压垮。
 * 需要更高上限时应先扩容并调整此处常量,而不是在运行时随意放开。
 */
const CONCURRENCY_HARD_CAPS = {
  imageGlobal: 50,
  textGlobal: 100,
  imagePerUserRunning: 5,
  imagePerUserPending: 20,
  imageProcess: 8,
  queueMaxDepthImage: 20_000,
  queueMaxDepthText: 50_000,
} as const;

/** 危险配置项的值校验。命中的键必须通过对应 schema 才允许写入。 */
const VALUE_SCHEMAS: Record<string, ZodType> = {
  [CONCURRENCY_CONFIG_KEY]: concurrencyConfigSchema.superRefine((value, ctx) => {
    for (const [field, cap] of Object.entries(CONCURRENCY_HARD_CAPS)) {
      const current = value[field as keyof typeof CONCURRENCY_HARD_CAPS];
      if (typeof current === 'number' && current > cap) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `超过当前部署规格的硬上限 ${cap}`,
        });
      }
    }
    if (value.imagePerUserRunning > value.imageGlobal) {
      ctx.addIssue({
        code: 'custom',
        path: ['imagePerUserRunning'],
        message: '单用户并发不能超过全局并发上限',
      });
    }
    if (value.imagePerUserPending < value.imagePerUserRunning) {
      ctx.addIssue({
        code: 'custom',
        path: ['imagePerUserPending'],
        message: '单用户待处理上限不能小于运行中上限',
      });
    }
  }),
  [SHARE_QRCODE_KEY]: z.object({ enabled: z.boolean() }),
  'storage.defaultQuotaBytes': z.object({
    // 1 MB ~ 1 TB,字符串传递避免 JSON number 精度问题
    bytes: z.string().regex(/^\d{7,13}$/, '默认配额必须在 1MB ~ 1TB 之间'),
  }),
  'task.retentionDays': z.object({ days: z.number().int().min(7).max(730) }),
};

/** 系统配置写入体 */
export const systemConfigUpsertSchema = z.object({
  /** 非敏感值:任意 JSON。敏感值(isSecret=true)必须是字符串明文,写入即加密 */
  value: z.unknown(),
  isSecret: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  group: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  /** 变更原因,写入审计 */
  reason: z.string().trim().max(300).optional(),
});
export type SystemConfigUpsertInput = z.infer<typeof systemConfigUpsertSchema>;

export const systemConfigKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, '配置键只能包含字母、数字、点、下划线、冒号与连字符');

export const systemConfigListQuerySchema = z.object({
  group: z.string().trim().max(40).optional(),
});
export type SystemConfigListQuery = z.infer<typeof systemConfigListQuerySchema>;

/**
 * 系统配置与分享配置。
 *
 * 敏感值处理:`isSecret=true` 的配置用 `CryptoService.seal(plain, 'provider', 'config:${key}')`
 * 加密后存 `valueCipher/valueIv/valueTag`,`value` 列写 SQL NULL。
 * AAD 绑定到具体 key,把 A 键的密文复制到 B 键会直接解密失败。
 * **任何读接口都只返回掩码**,明文只在写入时接受一次。
 */
@Injectable()
export class AdminConfigService {
  private readonly logger = new Logger(AdminConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly revisions: ConfigRevisionService,
  ) {}

  // ---------------------------------------------------------------------------
  // 通用 SystemConfig
  // ---------------------------------------------------------------------------

  async list(query: SystemConfigListQuery): Promise<AdminSystemConfigView[]> {
    const rows = await this.prisma.db.systemConfig.findMany({
      where: query.group ? { group: query.group } : {},
      orderBy: [{ group: 'asc' }, { key: 'asc' }],
    });
    return rows.map((row) => this.toView(row));
  }

  async get(key: string): Promise<AdminSystemConfigView> {
    const row = await this.prisma.db.systemConfig.findUnique({ where: { key } });
    if (!row) throw AppException.notFound('配置项不存在');
    return this.toView(row);
  }

  /**
   * 新建或更新配置项。
   * 危险键(并发上限等)必须通过 VALUE_SCHEMAS 的校验与范围限制。
   */
  async upsert(
    actor: AuthUser,
    key: string,
    input: SystemConfigUpsertInput,
    meta: ClientMeta,
  ): Promise<AdminSystemConfigView> {
    if (RESERVED_KEYS.has(key)) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        '该配置项包含敏感凭据,请使用对应的专用接口修改',
      );
    }

    const existing = await this.prisma.db.systemConfig.findUnique({ where: { key } });
    const isSecret = input.isSecret ?? existing?.isSecret ?? false;
    const group = input.group ?? existing?.group ?? this.groupOf(key);
    const isPublic = input.isPublic ?? existing?.isPublic ?? false;

    if (isSecret && isPublic) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        '敏感配置不能标记为 public:public 配置会随 SSE 公开配置下发',
      );
    }

    const row = isSecret
      ? await this.writeSecret(key, group, isPublic, input, existing, actor.id)
      : await this.writePlain(key, group, isPublic, input, existing, actor.id);

    // 敏感值不进 diff:只记录"已变更"
    const diff = isSecret
      ? this.audit.buildDiff({ secret: 'unchanged' }, { secret: 'updated' })
      : this.audit.buildDiff(
          { value: existing?.value ?? null, isPublic: existing?.isPublic ?? false },
          { value: (input.value ?? null) as Prisma.JsonValue, isPublic },
        );

    await this.audit.record({
      actor,
      action: existing ? 'admin.system_config.update' : 'admin.system_config.create',
      targetType: 'SystemConfig',
      targetId: key,
      diff,
      metadata: { group, isSecret, reason: input.reason ?? null },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    await this.bumpForKey(key, group, actor.id);
    return this.toView(row);
  }

  async remove(
    actor: AuthUser,
    key: string,
    reason: string | undefined,
    meta: ClientMeta,
  ): Promise<{ key: string; deleted: true }> {
    if (RESERVED_KEYS.has(key) || UNDELETABLE_KEYS.has(key)) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, '该配置项受保护,不允许删除');
    }
    const existing = await this.prisma.db.systemConfig.findUnique({ where: { key } });
    if (!existing) throw AppException.notFound('配置项不存在');

    await this.prisma.db.systemConfig.delete({ where: { key } });

    await this.audit.record({
      actor,
      action: 'admin.system_config.delete',
      targetType: 'SystemConfig',
      targetId: key,
      metadata: { group: existing.group, isSecret: existing.isSecret, reason: reason ?? null },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    await this.bumpForKey(key, existing.group, actor.id);
    return { key, deleted: true };
  }

  private async writePlain(
    key: string,
    group: string,
    isPublic: boolean,
    input: SystemConfigUpsertInput,
    existing: SystemConfig | null,
    actorId: string,
  ): Promise<SystemConfig> {
    const value = this.validateValue(key, input.value);
    const description = input.description ?? existing?.description ?? null;

    return this.prisma.db.systemConfig.upsert({
      where: { key },
      create: {
        key,
        group,
        isPublic,
        isSecret: false,
        description,
        value: value as Prisma.InputJsonValue,
        updatedBy: actorId,
      },
      update: {
        group,
        isPublic,
        isSecret: false,
        description,
        value: value as Prisma.InputJsonValue,
        // 清掉可能残留的密文,避免"曾经是 secret 的键"留下无主密文
        valueCipher: null,
        valueIv: null,
        valueTag: null,
        version: { increment: 1 },
        updatedBy: actorId,
      },
    });
  }

  private async writeSecret(
    key: string,
    group: string,
    isPublic: boolean,
    input: SystemConfigUpsertInput,
    existing: SystemConfig | null,
    actorId: string,
  ): Promise<SystemConfig> {
    if (typeof input.value !== 'string' || input.value.length === 0) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        '敏感配置的值必须是非空字符串明文',
      );
    }
    if (input.value.length > 2000) {
      throw AppException.badRequest(ERROR_CODES.VALIDATION_FAILED, '敏感配置的值过长');
    }

    const sealed = this.crypto.seal(input.value, 'provider', this.aadFor(key));
    const description = input.description ?? existing?.description ?? null;

    return this.prisma.db.systemConfig.upsert({
      where: { key },
      create: {
        key,
        group,
        isPublic: false,
        isSecret: true,
        description,
        // 敏感值只存密文,明文列写 SQL NULL
        value: Prisma.DbNull,
        valueCipher: sealed.cipher,
        valueIv: sealed.iv,
        valueTag: sealed.tag,
        keyVersion: sealed.keyVersion,
        updatedBy: actorId,
      },
      update: {
        group,
        isPublic: false,
        isSecret: true,
        description,
        value: Prisma.DbNull,
        valueCipher: sealed.cipher,
        valueIv: sealed.iv,
        valueTag: sealed.tag,
        keyVersion: sealed.keyVersion,
        version: { increment: 1 },
        updatedBy: actorId,
      },
    });
  }

  /** 危险键必须过 schema;未登记的键按自由 JSON 处理 */
  private validateValue(key: string, value: unknown): unknown {
    const schema = VALUE_SCHEMAS[key];
    if (!schema) return value ?? null;

    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw AppException.validation(
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.') || '(root)',
          message: issue.message,
        })),
        `配置项 ${key} 的值不符合要求`,
      );
    }
    return parsed.data;
  }

  /** AAD 绑定到具体配置键,密文无法跨键复用 */
  private aadFor(key: string): string {
    return `config:${key}`;
  }

  private groupOf(key: string): string {
    const prefix = key.split('.')[0] ?? 'system';
    return prefix.slice(0, 40);
  }

  /**
   * 写操作后自增配置修订号触发 SSE 同步。
   * 与 models 模块的 bumpRevision 语义一致(同一张 config_revisions 表、同一个广播频道)。
   * 并发类配置额外 bump 'concurrency',这样前端能立刻补拉公开的并发提示值。
   */
  private async bumpForKey(key: string, group: string, actorId: string): Promise<void> {
    await this.revisions.bumpRevision('system', actorId);
    if (group === 'concurrency' || key.startsWith('concurrency.')) {
      await this.revisions.bumpRevision('concurrency', actorId);
    }
    if (group === 'share' || key.startsWith('share.')) {
      await this.revisions.bumpRevision('share', actorId);
    }
  }

  private toView(row: SystemConfig): AdminSystemConfigView {
    const hasSecret = Boolean(row.valueCipher && row.valueIv && row.valueTag);
    return {
      key: row.key,
      group: row.group,
      description: row.description,
      isSecret: row.isSecret,
      isPublic: row.isPublic,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
      // 敏感值永不回传,连密文也不回传
      value: row.isSecret ? null : (row.value ?? null),
      valueMasked: row.isSecret ? this.maskOf(row) : null,
      hasSecret,
    };
  }

  /**
   * 敏感值的掩码。
   * 为了给出"前 3 后 4"这种可辨识的掩码需要在服务端解密一次,
   * **明文只用于生成掩码,不写日志、不返回**。解密失败(密钥轮换未迁移)时退回固定掩码。
   */
  private maskOf(row: SystemConfig): string | null {
    if (!row.valueCipher || !row.valueIv || !row.valueTag) return null;
    try {
      const plain = this.crypto.open(
        {
          cipher: row.valueCipher,
          iv: row.valueIv,
          tag: row.valueTag,
          keyVersion: row.keyVersion,
        },
        'provider',
        this.aadFor(row.key),
      );
      return maskSecret(plain);
    } catch {
      this.logger.warn(`配置 ${row.key} 的密文无法解密(可能需要密钥轮换迁移),已返回固定掩码`);
      return PASSWORD_DISPLAY_MASK;
    }
  }

  // ---------------------------------------------------------------------------
  // 分享配置
  // ---------------------------------------------------------------------------

  /** 管理端视图:appSecret 只给掩码 */
  async getShareConfig(): Promise<AdminShareConfigView> {
    const [configRow, secretRow] = await Promise.all([
      this.prisma.db.systemConfig.findUnique({ where: { key: SHARE_CONFIG_KEY } }),
      this.prisma.db.systemConfig.findUnique({ where: { key: SHARE_WECHAT_SECRET_KEY } }),
    ]);

    const stored = this.parseShareValue(configRow?.value);
    const hasSecret = Boolean(secretRow?.valueCipher);

    return {
      publicOrigin: stored.publicOrigin,
      wechat: {
        enabled: stored.wechat.enabled,
        appId: stored.wechat.appId,
        appSecretMasked: secretRow ? this.maskOf(secretRow) : null,
        hasSecret,
        jsApiDomain: stored.wechat.jsApiDomain,
      },
      qq: { enabled: stored.qq.enabled, appId: stored.qq.appId },
    };
  }

  /**
   * 供社区/分享模块**内部调用**的公开分享配置。
   * 只含 appId 与开关,**绝不含 appSecret**,因此可以安全地下发给前端。
   */
  async getPublicShareConfig(): Promise<PublicShareConfig> {
    const [configRow, secretRow, qrcodeRow, version] = await Promise.all([
      this.prisma.db.systemConfig.findUnique({ where: { key: SHARE_CONFIG_KEY } }),
      this.prisma.db.systemConfig.findUnique({
        where: { key: SHARE_WECHAT_SECRET_KEY },
        select: { valueCipher: true },
      }),
      this.prisma.db.systemConfig.findUnique({ where: { key: SHARE_QRCODE_KEY } }),
      this.revisions.currentVersion('share'),
    ]);

    const stored = this.parseShareValue(configRow?.value);
    const configured = Boolean(secretRow?.valueCipher) && stored.wechat.appId.length > 0;
    const qrcodeValue = qrcodeRow?.value;
    const qrcodeEnabled =
      qrcodeValue && typeof qrcodeValue === 'object' && !Array.isArray(qrcodeValue)
        ? (qrcodeValue as Record<string, unknown>).enabled !== false
        : true;

    return {
      publicOrigin: stored.publicOrigin,
      wechat: {
        // 未配置凭据时对外一律视为不可用,避免前端调起必然失败的分享
        enabled: stored.wechat.enabled && configured,
        appId: stored.wechat.appId,
        jsApiDomain: stored.wechat.jsApiDomain,
        configured,
      },
      qq: { enabled: stored.qq.enabled && stored.qq.appId.length > 0, appId: stored.qq.appId },
      // 二维码兜底不依赖任何第三方凭据,默认开启
      qrcodeEnabled,
      version,
    };
  }

  async updateShareConfig(
    actor: AuthUser,
    input: ShareConfigUpdateInput,
    meta: ClientMeta,
  ): Promise<AdminShareConfigView> {
    const existingSecret = await this.prisma.db.systemConfig.findUnique({
      where: { key: SHARE_WECHAT_SECRET_KEY },
      select: { valueCipher: true },
    });
    const submittedSecret = input.wechat.appSecret;
    const willHaveSecret =
      submittedSecret === undefined
        ? Boolean(existingSecret?.valueCipher)
        : submittedSecret.length > 0;

    if (input.wechat.enabled && (input.wechat.appId.length === 0 || !willHaveSecret)) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        '启用微信分享前必须填写 appId 与 appSecret',
      );
    }
    if (input.qq.enabled && input.qq.appId.length === 0) {
      throw AppException.badRequest(ERROR_CODES.VALIDATION_FAILED, '启用 QQ 分享前必须填写 appId');
    }

    const before = await this.getShareConfig();
    const nextValue = {
      publicOrigin: input.publicOrigin,
      wechat: {
        enabled: input.wechat.enabled,
        appId: input.wechat.appId,
        jsApiDomain: input.wechat.jsApiDomain,
      },
      qq: { enabled: input.qq.enabled, appId: input.qq.appId },
    };

    await this.prisma.db.$transaction(async (tx) => {
      await tx.systemConfig.upsert({
        where: { key: SHARE_CONFIG_KEY },
        create: {
          key: SHARE_CONFIG_KEY,
          group: 'share',
          isPublic: true,
          isSecret: false,
          description: '分享域名与各渠道 appId / 开关(不含任何密钥)',
          value: nextValue,
          updatedBy: actor.id,
        },
        update: { value: nextValue, version: { increment: 1 }, updatedBy: actor.id },
      });

      if (submittedSecret !== undefined) {
        if (submittedSecret.length === 0) {
          // 传空字符串表示清除已保存的密钥
          await tx.systemConfig.deleteMany({ where: { key: SHARE_WECHAT_SECRET_KEY } });
        } else {
          const sealed = this.crypto.seal(
            submittedSecret,
            'provider',
            this.aadFor(SHARE_WECHAT_SECRET_KEY),
          );
          await tx.systemConfig.upsert({
            where: { key: SHARE_WECHAT_SECRET_KEY },
            create: {
              key: SHARE_WECHAT_SECRET_KEY,
              group: 'share',
              isPublic: false,
              isSecret: true,
              description: '微信公众号 appSecret(加密存储,任何读接口只返回掩码)',
              value: Prisma.DbNull,
              valueCipher: sealed.cipher,
              valueIv: sealed.iv,
              valueTag: sealed.tag,
              keyVersion: sealed.keyVersion,
              updatedBy: actor.id,
            },
            update: {
              value: Prisma.DbNull,
              valueCipher: sealed.cipher,
              valueIv: sealed.iv,
              valueTag: sealed.tag,
              keyVersion: sealed.keyVersion,
              version: { increment: 1 },
              updatedBy: actor.id,
            },
          });
        }
      }
    });

    await this.revisions.bumpRevision('share', actor.id);

    await this.audit.record({
      actor,
      action: 'admin.share_config.update',
      targetType: 'SystemConfig',
      targetId: SHARE_CONFIG_KEY,
      // 只记录非敏感字段的变化;appSecret 只标记"是否变更",不记录任何值
      diff: this.audit.buildDiff(
        {
          publicOrigin: before.publicOrigin,
          wechatEnabled: before.wechat.enabled,
          wechatAppId: before.wechat.appId,
          jsApiDomain: before.wechat.jsApiDomain,
          qqEnabled: before.qq.enabled,
          qqAppId: before.qq.appId,
        },
        {
          publicOrigin: nextValue.publicOrigin,
          wechatEnabled: nextValue.wechat.enabled,
          wechatAppId: nextValue.wechat.appId,
          jsApiDomain: nextValue.wechat.jsApiDomain,
          qqEnabled: nextValue.qq.enabled,
          qqAppId: nextValue.qq.appId,
        },
      ),
      metadata: {
        appSecretChanged: submittedSecret !== undefined,
        appSecretCleared: submittedSecret === '',
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.getShareConfig();
  }

  private parseShareValue(value: unknown): {
    publicOrigin: string;
    wechat: { enabled: boolean; appId: string; jsApiDomain: string };
    qq: { enabled: boolean; appId: string };
  } {
    const fallback = {
      publicOrigin: '',
      wechat: { enabled: false, appId: '', jsApiDomain: '' },
      qq: { enabled: false, appId: '' },
    };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;

    const shape = z
      .object({
        publicOrigin: z.string().default(''),
        wechat: z
          .object({
            enabled: z.boolean().default(false),
            appId: z.string().default(''),
            jsApiDomain: z.string().default(''),
          })
          .default({ enabled: false, appId: '', jsApiDomain: '' }),
        qq: z
          .object({ enabled: z.boolean().default(false), appId: z.string().default('') })
          .default({ enabled: false, appId: '' }),
      })
      .safeParse(value);

    return shape.success ? shape.data : fallback;
  }
}
