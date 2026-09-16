import { Injectable } from '@nestjs/common';
import { ContentRuleType, Prisma, RuleAction, type ContentRule } from '@june/db';
import {
  ERROR_CODES,
  PAGE_SIZE_DEFAULT,
  type AdminContentRuleView,
  type ContentRuleCreateInput,
  type PageQuery,
  type PageResult,
} from '@june/shared';

import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ModelConfigService } from '../models/model-config.service';
import {
  ContentRuleService,
  MAX_PATTERN_LENGTH,
  type BannedCategoryPayload,
  type BannedPhrasePayload,
  type BannedWordPayload,
  type PlatformRulePayload,
  type SystemPromptPayload,
} from './content-rule.service';

export type ContentRuleUpdateInput = Partial<Omit<ContentRuleCreateInput, 'type'>>;

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface ContentRuleVersionView {
  id: string;
  version: number;
  snapshot: Record<string, unknown>;
  changedBy: string | null;
  changeNote: string | null;
  createdAt: string;
}

/**
 * 内容规则后台管理。
 *
 * 两条硬要求:
 *  1. **每次修改都写版本快照**(ContentRuleVersion),规则改错时可以对照回滚;
 *  2. 写操作后 bumpRevision('content'),触发 SSE 广播,缓存 key 随版本号切换即刻失效。
 *
 * 正则类规则在写入前就要过安全检查:把危险表达式挡在库外,
 * 比在每次检查时兜底更可靠,也避免管理员误以为规则已生效。
 */
@Injectable()
export class ContentRuleAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ModelConfigService,
    private readonly rules: ContentRuleService,
  ) {}

  // ---------------------------------------------------------------------------
  // 查询
  // ---------------------------------------------------------------------------

  async list(
    query: PageQuery & { type?: string; enabled?: string },
  ): Promise<PageResult<AdminContentRuleView>> {
    const where: Prisma.ContentRuleWhereInput = { deletedAt: null };
    if (query.type && query.type !== 'ALL') where.type = query.type as ContentRuleType;
    if (query.enabled === 'ENABLED') where.enabled = true;
    if (query.enabled === 'DISABLED') where.enabled = false;

    const pageSize = query.pageSize || PAGE_SIZE_DEFAULT;
    const [total, rows] = await Promise.all([
      this.prisma.db.contentRule.count({ where }),
      this.prisma.db.contentRule.findMany({
        where,
        orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
        skip: (query.page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map((row) => this.toView(row)),
      total,
      page: query.page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async listVersions(ruleId: string): Promise<ContentRuleVersionView[]> {
    await this.require(ruleId);
    const rows = await this.prisma.db.contentRuleVersion.findMany({
      where: { ruleId },
      orderBy: { version: 'desc' },
      take: 100,
    });
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      snapshot: (row.snapshot ?? {}) as Record<string, unknown>,
      changedBy: row.changedBy,
      changeNote: row.changeNote,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // ---------------------------------------------------------------------------
  // 写入
  // ---------------------------------------------------------------------------

  async create(
    user: AuthUser,
    dto: ContentRuleCreateInput,
    meta: ClientMeta,
  ): Promise<AdminContentRuleView> {
    const type = dto.type as ContentRuleType;
    this.assertPayload(type, dto.payload);

    const created = await this.prisma.db.$transaction(async (tx) => {
      const rule = await tx.contentRule.create({
        data: {
          type,
          action: dto.action as RuleAction,
          name: dto.name,
          platforms: dto.platforms,
          payload: dto.payload as Prisma.InputJsonValue,
          applyToInput: dto.applyToInput,
          applyToOutput: dto.applyToOutput,
          enabled: dto.enabled,
          sortOrder: dto.sortOrder,
          version: 1,
          createdBy: user.id,
          updatedBy: user.id,
        },
      });
      await tx.contentRuleVersion.create({
        data: {
          ruleId: rule.id,
          version: rule.version,
          snapshot: this.snapshotOf(rule),
          changedBy: user.id,
          changeNote: dto.changeNote ?? '创建规则',
        },
      });
      return rule;
    });

    await this.audit.record({
      actor: user,
      action: 'content.rule.create',
      targetType: 'ContentRule',
      targetId: created.id,
      diff: { type: { from: null, to: created.type }, name: { from: null, to: created.name } },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.config.bumpRevision('content', user.id);

    return this.toView(created);
  }

  async update(
    user: AuthUser,
    id: string,
    dto: ContentRuleUpdateInput,
    meta: ClientMeta,
  ): Promise<AdminContentRuleView> {
    const before = await this.require(id);
    if (dto.payload !== undefined) {
      this.assertPayload(before.type, dto.payload);
    }

    const data: Prisma.ContentRuleUpdateInput = { updatedBy: user.id, version: { increment: 1 } };
    if (dto.action !== undefined) data.action = dto.action as RuleAction;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.platforms !== undefined) data.platforms = dto.platforms;
    if (dto.payload !== undefined) data.payload = dto.payload as Prisma.InputJsonValue;
    if (dto.applyToInput !== undefined) data.applyToInput = dto.applyToInput;
    if (dto.applyToOutput !== undefined) data.applyToOutput = dto.applyToOutput;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    const after = await this.prisma.db.$transaction(async (tx) => {
      const updated = await tx.contentRule.update({ where: { id }, data });
      await tx.contentRuleVersion.create({
        data: {
          ruleId: id,
          version: updated.version,
          snapshot: this.snapshotOf(updated),
          changedBy: user.id,
          changeNote: dto.changeNote ?? '修改规则',
        },
      });
      return updated;
    });

    await this.audit.record({
      actor: user,
      action: 'content.rule.update',
      targetType: 'ContentRule',
      targetId: id,
      diff: this.audit.buildDiff(
        {
          action: before.action,
          name: before.name,
          platforms: before.platforms,
          payload: before.payload,
          applyToInput: before.applyToInput,
          applyToOutput: before.applyToOutput,
          enabled: before.enabled,
          sortOrder: before.sortOrder,
        },
        {
          action: after.action,
          name: after.name,
          platforms: after.platforms,
          payload: after.payload,
          applyToInput: after.applyToInput,
          applyToOutput: after.applyToOutput,
          enabled: after.enabled,
          sortOrder: after.sortOrder,
        },
      ),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.config.bumpRevision('content', user.id);

    return this.toView(after);
  }

  /** 启停。单独开一个接口,便于后台做快速开关而不必提交整份表单。 */
  async setEnabled(
    user: AuthUser,
    id: string,
    enabled: boolean,
    meta: ClientMeta,
  ): Promise<AdminContentRuleView> {
    const before = await this.require(id);
    if (before.enabled === enabled) return this.toView(before);

    const after = await this.prisma.db.$transaction(async (tx) => {
      const updated = await tx.contentRule.update({
        where: { id },
        data: { enabled, updatedBy: user.id, version: { increment: 1 } },
      });
      await tx.contentRuleVersion.create({
        data: {
          ruleId: id,
          version: updated.version,
          snapshot: this.snapshotOf(updated),
          changedBy: user.id,
          changeNote: enabled ? '启用规则' : '停用规则',
        },
      });
      return updated;
    });

    await this.audit.record({
      actor: user,
      action: 'content.rule.update',
      targetType: 'ContentRule',
      targetId: id,
      diff: { enabled: { from: before.enabled, to: enabled } },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.config.bumpRevision('content', user.id);

    return this.toView(after);
  }

  /** 删除走软删除:版本历史需要保留,规则被误删时能对照恢复。 */
  async remove(user: AuthUser, id: string, meta: ClientMeta): Promise<{ deleted: true }> {
    const before = await this.require(id);

    await this.prisma.db.$transaction(async (tx) => {
      const updated = await tx.contentRule.update({
        where: { id },
        data: { deletedAt: new Date(), enabled: false, updatedBy: user.id, version: { increment: 1 } },
      });
      await tx.contentRuleVersion.create({
        data: {
          ruleId: id,
          version: updated.version,
          snapshot: this.snapshotOf(updated),
          changedBy: user.id,
          changeNote: '删除规则',
        },
      });
    });

    await this.audit.record({
      actor: user,
      action: 'content.rule.delete',
      targetType: 'ContentRule',
      targetId: id,
      diff: { name: { from: before.name, to: before.name }, deleted: { from: false, to: true } },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.config.bumpRevision('content', user.id);

    return { deleted: true };
  }

  // ---------------------------------------------------------------------------
  // 载荷校验
  // ---------------------------------------------------------------------------

  /** 按 type 校验 payload 结构。不合规直接拒绝写入,避免"规则存在但永远不生效"。 */
  private assertPayload(type: ContentRuleType, payload: Record<string, unknown>): void {
    const fail = (message: string, path = 'payload'): never => {
      throw AppException.validation([{ path, message }], message);
    };

    switch (type) {
      case ContentRuleType.BANNED_WORD: {
        const p = payload as unknown as BannedWordPayload;
        if (!Array.isArray(p.words) || p.words.length === 0) fail('违禁词规则必须提供 words 数组');
        if (p.words.some((w) => typeof w !== 'string' || w.trim().length === 0)) {
          fail('违禁词不能为空字符串', 'payload.words');
        }
        if (p.words.length > 5_000) fail('单条规则最多 5000 个违禁词', 'payload.words');
        return;
      }
      case ContentRuleType.BANNED_PHRASE: {
        const p = payload as unknown as BannedPhrasePayload;
        if (!Array.isArray(p.patterns) || p.patterns.length === 0) fail('禁用表达规则必须提供 patterns 数组');
        if (p.patterns.length > 200) fail('单条规则最多 200 个正则', 'payload.patterns');

        const issues = this.rules.validatePatterns(p.patterns);
        if (issues.length > 0) {
          throw AppException.validation(
            issues.map((i) => ({ path: 'payload.patterns', message: `「${i.pattern}」${i.reason}` })),
            `有 ${issues.length} 条正则未通过安全检查(长度上限 ${MAX_PATTERN_LENGTH},禁止嵌套量词与反向引用)`,
          );
        }
        return;
      }
      case ContentRuleType.BANNED_CATEGORY: {
        const p = payload as unknown as BannedCategoryPayload;
        if (typeof p.category !== 'string' || p.category.trim().length === 0) {
          fail('禁止类别必须提供 category', 'payload.category');
        }
        if (!Array.isArray(p.keywords)) fail('禁止类别必须提供 keywords 数组(可为空)', 'payload.keywords');
        return;
      }
      case ContentRuleType.PLATFORM_RULE: {
        const p = payload as unknown as PlatformRulePayload;
        for (const key of ['maxTitleChars', 'maxBodyChars'] as const) {
          const value = p[key];
          if (value !== undefined && (typeof value !== 'number' || value <= 0 || value > 100_000)) {
            fail(`${key} 必须是 1 到 100000 之间的整数`, `payload.${key}`);
          }
        }
        for (const key of ['forbiddenSymbols', 'requireKeywords'] as const) {
          const value = p[key];
          if (value !== undefined && !Array.isArray(value)) {
            fail(`${key} 必须是数组`, `payload.${key}`);
          }
        }
        return;
      }
      case ContentRuleType.SYSTEM_PROMPT: {
        const p = payload as unknown as SystemPromptPayload;
        if (typeof p.text !== 'string' || p.text.trim().length === 0) {
          fail('系统提示词规则必须提供 text', 'payload.text');
        }
        if (p.text.length > 8_000) fail('系统提示词最多 8000 个字符', 'payload.text');
        return;
      }
      default:
        throw AppException.badRequest(ERROR_CODES.VALIDATION_FAILED, '未知的规则类型');
    }
  }

  // ---------------------------------------------------------------------------

  private async require(id: string): Promise<ContentRule> {
    const rule = await this.prisma.db.contentRule.findFirst({ where: { id, deletedAt: null } });
    if (!rule) throw AppException.notFound('内容规则不存在或已被删除');
    return rule;
  }

  /** 完整快照:回滚时可以直接照着这份数据还原 */
  private snapshotOf(rule: ContentRule): Prisma.InputJsonValue {
    return {
      type: rule.type,
      action: rule.action,
      name: rule.name,
      platforms: rule.platforms,
      payload: (rule.payload ?? {}) as Prisma.InputJsonValue,
      applyToInput: rule.applyToInput,
      applyToOutput: rule.applyToOutput,
      enabled: rule.enabled,
      sortOrder: rule.sortOrder,
      deletedAt: rule.deletedAt?.toISOString() ?? null,
    } as Prisma.InputJsonValue;
  }

  private toView(rule: ContentRule): AdminContentRuleView {
    return {
      id: rule.id,
      type: rule.type,
      action: rule.action,
      name: rule.name,
      platforms: rule.platforms,
      payload: (rule.payload ?? {}) as Record<string, unknown>,
      applyToInput: rule.applyToInput,
      applyToOutput: rule.applyToOutput,
      enabled: rule.enabled,
      sortOrder: rule.sortOrder,
      version: rule.version,
      updatedAt: rule.updatedAt.toISOString(),
      updatedBy: rule.updatedBy,
    };
  }
}
