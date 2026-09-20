import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type ModelCapability, type ModelConfig, type ModelProvider, type ProviderKind } from '@june/db';
import {
  DEFAULT_MODEL_LIMITS,
  ERROR_CODES,
  maskSecret,
  modelLimitsSchema,
  type AdminModelConfigView,
  type AdminProviderView,
  type ModelConfigCreateInput,
  type ModelPolicyUpdateInput,
  type ModelSelectionPolicy,
  type ProviderCreateInput,
  type ProviderTestResult,
} from '@june/shared';

import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-context';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { MODEL_POLICY_KEY, ModelConfigService } from './model-config.service';
import { assertSafeProviderUrl } from './provider-url.validator';

export type ProviderUpdateInput = Partial<Omit<ProviderCreateInput, 'slug' | 'kind'>> & {
  apiKey?: string;
};
export type ModelConfigUpdateInput = Partial<Omit<ModelConfigCreateInput, 'providerId'>>;

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface ModelDeleteResult {
  /** 是否被物理删除 */
  deleted: boolean;
  /** 是否改为软删除 + 停用 */
  disabled: boolean;
  /** 被历史任务引用的次数,用于界面提示 */
  taskRefCount: number;
  message: string;
}

/** 连接测试的超时时间。探测必须有硬上限,否则管理后台会被一个挂死的地址拖住。 */
const PROBE_TIMEOUT_MS = 8_000;

/**
 * 只声明"互斥默认模型"需要的那一个方法。
 * 这样普通客户端与事务客户端都能传进来,不必依赖 Prisma 内部的事务客户端类型别名。
 */
interface ModelConfigUpdateManyCapable {
  modelConfig: {
    updateMany(args: {
      where: Prisma.ModelConfigWhereInput;
      data: Prisma.ModelConfigUpdateManyMutationInput;
    }): Promise<{ count: number }>;
  };
}

/**
 * 模型与供应商的后台管理。
 *
 * 密钥处理原则:
 *  - 明文只在写入时出现一次,立即用 AES-256-GCM 加密(AAD 绑定 providerId)后入库;
 *  - 任何读接口只回 apiKeyMasked,**永不回传明文**;
 *  - 审计 diff 里不写 apiKey,只记录"凭据是否变化"。
 *
 * 每一次写操作结束都会 bumpRevision('models'),从而触发 SSE 广播,
 * 前端在 2 秒内补拉公开配置完成热更新。
 */
@Injectable()
export class ModelAdminService {
  private readonly logger = new Logger(ModelAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly models: ModelConfigService,
  ) {}

  // ===========================================================================
  // 供应商
  // ===========================================================================

  async listProviders(): Promise<AdminProviderView[]> {
    const rows = await this.prisma.db.modelProvider.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { models: true } } },
    });
    return rows.map((row) => this.toProviderView(row, row._count.models));
  }

  async createProvider(
    user: AuthUser,
    dto: ProviderCreateInput,
    meta: ClientMeta,
  ): Promise<AdminProviderView> {
    // SSRF 防护:地址必须在写库前通过校验
    await assertSafeProviderUrl(dto.baseUrl);

    const duplicate = await this.prisma.db.modelProvider.findUnique({ where: { slug: dto.slug } });
    if (duplicate) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, '该供应商标识已存在');
    }

    const provider = await this.prisma.db.$transaction(async (tx) => {
      const created = await tx.modelProvider.create({
        data: {
          slug: dto.slug,
          kind: dto.kind as ProviderKind,
          name: dto.name,
          baseUrl: dto.baseUrl,
          enabled: dto.enabled,
          sortOrder: dto.sortOrder,
          rateLimitPerMinute: dto.rateLimitPerMinute,
          maxConcurrency: dto.maxConcurrency,
          hasCredential: false,
        },
      });

      if (!dto.apiKey) return created;

      // AAD 绑定记录 id:密文被复制到别的供应商记录上会解密失败
      const sealed = this.crypto.seal(dto.apiKey, 'provider', `provider:${created.id}`);
      return tx.modelProvider.update({
        where: { id: created.id },
        data: {
          apiKeyCipher: sealed.cipher,
          apiKeyIv: sealed.iv,
          apiKeyTag: sealed.tag,
          keyVersion: sealed.keyVersion,
          apiKeyMasked: maskSecret(dto.apiKey),
          hasCredential: true,
        },
      });
    });

    await this.audit.record({
      actor: user,
      action: 'provider.create',
      targetType: 'ModelProvider',
      targetId: provider.id,
      // 不传 apiKey,只记录凭据是否已配置
      diff: {
        slug: { from: null, to: provider.slug },
        name: { from: null, to: provider.name },
        baseUrl: { from: null, to: provider.baseUrl },
        hasCredential: { from: false, to: provider.hasCredential },
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    await this.models.bumpRevision('models', user.id);
    return this.toProviderView(provider, 0);
  }

  async updateProvider(
    user: AuthUser,
    id: string,
    dto: ProviderUpdateInput,
    meta: ClientMeta,
  ): Promise<AdminProviderView> {
    const before = await this.requireProvider(id);

    if (dto.baseUrl !== undefined) {
      await assertSafeProviderUrl(dto.baseUrl);
    }

    const data: Prisma.ModelProviderUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.baseUrl !== undefined) data.baseUrl = dto.baseUrl;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.rateLimitPerMinute !== undefined) data.rateLimitPerMinute = dto.rateLimitPerMinute;
    if (dto.maxConcurrency !== undefined) data.maxConcurrency = dto.maxConcurrency;

    let credentialChange: 'set' | 'cleared' | null = null;
    if (dto.apiKey !== undefined) {
      if (dto.apiKey === '') {
        // 空字符串表示清除已保存的密钥
        credentialChange = 'cleared';
        data.apiKeyCipher = null;
        data.apiKeyIv = null;
        data.apiKeyTag = null;
        data.apiKeyMasked = null;
        data.hasCredential = false;
      } else {
        credentialChange = 'set';
        const sealed = this.crypto.seal(dto.apiKey, 'provider', `provider:${id}`);
        data.apiKeyCipher = sealed.cipher;
        data.apiKeyIv = sealed.iv;
        data.apiKeyTag = sealed.tag;
        data.keyVersion = sealed.keyVersion;
        data.apiKeyMasked = maskSecret(dto.apiKey);
        data.hasCredential = true;
      }
    }

    const after = await this.prisma.db.modelProvider.update({ where: { id }, data });

    await this.audit.record({
      actor: user,
      action: 'provider.update',
      targetType: 'ModelProvider',
      targetId: id,
      diff: {
        ...this.audit.buildDiff(
          {
            name: before.name,
            baseUrl: before.baseUrl,
            enabled: before.enabled,
            sortOrder: before.sortOrder,
            rateLimitPerMinute: before.rateLimitPerMinute,
            maxConcurrency: before.maxConcurrency,
          },
          {
            name: after.name,
            baseUrl: after.baseUrl,
            enabled: after.enabled,
            sortOrder: after.sortOrder,
            rateLimitPerMinute: after.rateLimitPerMinute,
            maxConcurrency: after.maxConcurrency,
          },
        ),
        ...(credentialChange ? { credential: { changed: true, action: credentialChange } } : {}),
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    // 停用供应商等价于停用它名下所有模型,要把这些 id 一并广播给前端
    const disabledModelIds =
      before.enabled && after.enabled === false ? await this.modelIdsOfProvider(id) : undefined;
    await this.models.bumpRevision('models', user.id, disabledModelIds);

    const modelCount = await this.prisma.db.modelConfig.count({ where: { providerId: id } });
    return this.toProviderView(after, modelCount);
  }

  /**
   * 删除供应商。名下仍有模型时改为停用:
   * 直接删会让历史任务的模型引用断裂,也会因外键 Restrict 失败。
   */
  async deleteProvider(user: AuthUser, id: string, meta: ClientMeta): Promise<ModelDeleteResult> {
    const provider = await this.requireProvider(id);
    const modelCount = await this.prisma.db.modelConfig.count({
      where: { providerId: id, deletedAt: null },
    });

    if (modelCount > 0) {
      await this.prisma.db.modelProvider.update({ where: { id }, data: { enabled: false } });
      await this.audit.record({
        actor: user,
        action: 'provider.update',
        targetType: 'ModelProvider',
        targetId: id,
        diff: { enabled: { from: provider.enabled, to: false }, reason: '名下仍有模型,已改为停用' },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await this.models.bumpRevision('models', user.id, await this.modelIdsOfProvider(id));
      return {
        deleted: false,
        disabled: true,
        taskRefCount: modelCount,
        message: `该供应商下仍有 ${modelCount} 个模型,已改为停用而非删除`,
      };
    }

    await this.prisma.db.modelProvider.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        enabled: false,
        // 删除时一并清除密文,不留下无人管理的密钥
        apiKeyCipher: null,
        apiKeyIv: null,
        apiKeyTag: null,
        apiKeyMasked: null,
        hasCredential: false,
      },
    });
    await this.audit.record({
      actor: user,
      action: 'provider.update',
      targetType: 'ModelProvider',
      targetId: id,
      diff: { deleted: { from: false, to: true } },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.models.bumpRevision('models', user.id);

    return { deleted: true, disabled: false, taskRefCount: 0, message: '供应商已删除' };
  }

  /**
   * 连接测试。
   *
   * 这里只做**受控的连通性探测**:对 baseUrl 发一个带超时的请求,确认网络可达、
   * 并记录凭据是否已配置。完整的模型可用性联调(真实鉴权、参数翻译、返回解析)
   * 由 Worker 侧的供应商适配器负责,API 不承担该职责,也不在此处发起计费调用。
   */
  async testProvider(user: AuthUser, id: string, meta: ClientMeta): Promise<ProviderTestResult> {
    const provider = await this.requireProvider(id);

    // 每次测试前重新校验地址:配置可能在上次校验后被改动过
    await assertSafeProviderUrl(provider.baseUrl);

    const startedAt = Date.now();
    let ok = false;
    let message: string;

    try {
      const response = await this.probe(provider.baseUrl);
      // 4xx 也说明网络可达(多半是缺少鉴权头),这在连通性层面算通过
      ok = response.status < 500;
      message = ok
        ? `网络可达(HTTP ${response.status})${provider.hasCredential ? ',凭据已配置' : ',但尚未配置 API Key'}`
        : `目标服务返回 HTTP ${response.status}`;
    } catch (err) {
      ok = false;
      message = this.describeProbeError(err);
    }

    const latencyMs = Date.now() - startedAt;
    const testedAt = new Date();

    await this.prisma.db.modelProvider.update({
      where: { id },
      data: { lastTestedAt: testedAt, lastTestOk: ok, lastTestMessage: message },
    });

    await this.audit.record({
      actor: user,
      action: 'provider.update',
      targetType: 'ModelProvider',
      targetId: id,
      metadata: { test: 'connectivity', ok, latencyMs },
      ip: meta.ip,
      userAgent: meta.userAgent,
      result: ok ? 'success' : 'failure',
    });

    return { ok, message, latencyMs, testedAt: testedAt.toISOString() };
  }

  private async probe(baseUrl: string): Promise<Response> {
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    try {
      return await fetch(baseUrl, { method: 'HEAD', signal, redirect: 'manual' });
    } catch {
      // 部分网关不接受 HEAD,回退到 GET(同样带超时)
      return fetch(baseUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        redirect: 'manual',
      });
    }
  }

  /** 探测失败信息必须脱敏:只暴露错误类别,不回显请求头、密钥或完整堆栈 */
  private describeProbeError(err: unknown): string {
    const name = err instanceof Error ? err.name : 'Error';
    const raw = err instanceof Error ? err.message : String(err);

    if (name === 'TimeoutError' || /abort/i.test(raw)) return `连接超时(${PROBE_TIMEOUT_MS / 1000} 秒未响应)`;
    if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return '域名无法解析';
    if (/ECONNREFUSED/i.test(raw)) return '目标端口拒绝连接';
    if (/certificate|SSL|TLS/i.test(raw)) return 'TLS 证书校验失败';
    return '网络不可达';
  }

  // ===========================================================================
  // 模型配置
  // ===========================================================================

  async listModels(): Promise<AdminModelConfigView[]> {
    const rows = await this.prisma.db.modelConfig.findMany({
      where: { deletedAt: null },
      include: { provider: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    // 一次 groupBy 拿到全部引用计数,避免每个模型各查一次
    const grouped = await this.prisma.db.generationTask.groupBy({
      by: ['modelConfigId'],
      _count: { _all: true },
      where: { modelConfigId: { in: rows.map((r) => r.id) } },
    });
    const refCounts = new Map(grouped.map((g) => [g.modelConfigId, g._count._all]));

    return rows.map((row) => this.toModelView(row, row.provider, refCounts.get(row.id) ?? 0));
  }

  async createModel(
    user: AuthUser,
    dto: ModelConfigCreateInput,
    meta: ClientMeta,
  ): Promise<AdminModelConfigView> {
    const provider = await this.requireProvider(dto.providerId);

    const duplicate = await this.prisma.db.modelConfig.findUnique({ where: { slug: dto.slug } });
    if (duplicate) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, '该模型标识已存在');
    }

    const capabilities = dto.capabilities.map((c) => ModelConfigService.toPrismaCapability(c));

    const created = await this.prisma.db.$transaction(async (tx) => {
      const model = await tx.modelConfig.create({
        data: {
          providerId: dto.providerId,
          slug: dto.slug,
          displayName: dto.displayName,
          modelKey: dto.modelKey,
          capabilities,
          enabled: dto.enabled,
          visible: dto.visible,
          sortOrder: dto.sortOrder,
          isDefault: dto.isDefault,
          limits: dto.limits as unknown as Prisma.InputJsonValue,
          defaultParams: dto.defaultParams as Prisma.InputJsonValue,
        },
      });
      if (dto.isDefault) {
        await this.clearOtherDefaults(tx, model.id, capabilities);
      }
      return model;
    });

    await this.audit.record({
      actor: user,
      action: 'model.create',
      targetType: 'ModelConfig',
      targetId: created.id,
      diff: {
        slug: { from: null, to: created.slug },
        displayName: { from: null, to: created.displayName },
        modelKey: { from: null, to: created.modelKey },
        capabilities: { from: null, to: created.capabilities },
        enabled: { from: null, to: created.enabled },
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    await this.models.bumpRevision('models', user.id);
    return this.toModelView(created, provider, 0);
  }

  async updateModel(
    user: AuthUser,
    id: string,
    dto: ModelConfigUpdateInput,
    meta: ClientMeta,
  ): Promise<AdminModelConfigView> {
    const before = await this.requireModel(id);

    const capabilities = dto.capabilities?.map((c) => ModelConfigService.toPrismaCapability(c));

    const data: Prisma.ModelConfigUpdateInput = {};
    if (dto.slug !== undefined) data.slug = dto.slug;
    if (dto.displayName !== undefined) data.displayName = dto.displayName;
    if (dto.modelKey !== undefined) data.modelKey = dto.modelKey;
    if (capabilities !== undefined) data.capabilities = capabilities;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.visible !== undefined) data.visible = dto.visible;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.limits !== undefined) data.limits = dto.limits as unknown as Prisma.InputJsonValue;
    if (dto.defaultParams !== undefined) data.defaultParams = dto.defaultParams as Prisma.InputJsonValue;
    if (dto.isDefault !== undefined) data.isDefault = dto.isDefault;

    const after = await this.prisma.db.$transaction(async (tx) => {
      const updated = await tx.modelConfig.update({ where: { id }, data });
      if (dto.isDefault === true) {
        await this.clearOtherDefaults(tx, id, updated.capabilities);
      }
      return updated;
    });

    const becameUnavailable = before.enabled && after.enabled === false;

    await this.audit.record({
      actor: user,
      action: becameUnavailable ? 'model.disable' : 'model.update',
      targetType: 'ModelConfig',
      targetId: id,
      diff: this.audit.buildDiff(
        {
          slug: before.slug,
          displayName: before.displayName,
          modelKey: before.modelKey,
          capabilities: before.capabilities,
          enabled: before.enabled,
          visible: before.visible,
          sortOrder: before.sortOrder,
          isDefault: before.isDefault,
          limits: before.limits,
          defaultParams: before.defaultParams,
        },
        {
          slug: after.slug,
          displayName: after.displayName,
          modelKey: after.modelKey,
          capabilities: after.capabilities,
          enabled: after.enabled,
          visible: after.visible,
          sortOrder: after.sortOrder,
          isDefault: after.isDefault,
          limits: after.limits,
          defaultParams: after.defaultParams,
        },
      ),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    await this.models.bumpRevision('models', user.id, becameUnavailable ? [id] : undefined);

    const provider = await this.requireProvider(after.providerId);
    const taskRefCount = await this.prisma.db.generationTask.count({ where: { modelConfigId: id } });
    return this.toModelView(after, provider, taskRefCount);
  }

  /**
   * 删除模型。被历史任务引用时改为软删除 + 停用:
   * 物理删除会把历史任务的模型引用置空,用户将看不到"当时用的是哪个模型"。
   */
  async deleteModel(user: AuthUser, id: string, meta: ClientMeta): Promise<ModelDeleteResult> {
    await this.requireModel(id);
    const taskRefCount = await this.prisma.db.generationTask.count({ where: { modelConfigId: id } });

    if (taskRefCount > 0) {
      await this.prisma.db.modelConfig.update({
        where: { id },
        data: { deletedAt: new Date(), enabled: false, visible: false, isDefault: false },
      });
      await this.audit.record({
        actor: user,
        action: 'model.disable',
        targetType: 'ModelConfig',
        targetId: id,
        diff: { deleted: { from: false, to: true }, reason: `被 ${taskRefCount} 个历史任务引用,已软删除` },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await this.models.bumpRevision('models', user.id, [id]);
      return {
        deleted: false,
        disabled: true,
        taskRefCount,
        message: `该模型被 ${taskRefCount} 个历史任务引用,已改为停用并隐藏,历史记录仍可查看`,
      };
    }

    await this.prisma.db.modelConfig.delete({ where: { id } });
    await this.audit.record({
      actor: user,
      action: 'model.disable',
      targetType: 'ModelConfig',
      targetId: id,
      diff: { deleted: { from: false, to: true } },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.models.bumpRevision('models', user.id, [id]);

    return { deleted: true, disabled: false, taskRefCount: 0, message: '模型已删除' };
  }

  /** 设为默认模型。同一能力下只能有一个默认。 */
  async setDefault(user: AuthUser, id: string, meta: ClientMeta): Promise<AdminModelConfigView> {
    const model = await this.requireModel(id);
    if (!model.enabled) {
      throw AppException.badRequest(ERROR_CODES.MODEL_DISABLED, '已停用的模型不能设为默认');
    }

    const updated = await this.prisma.db.$transaction(async (tx) => {
      await this.clearOtherDefaults(tx, id, model.capabilities);
      return tx.modelConfig.update({ where: { id }, data: { isDefault: true } });
    });

    await this.audit.record({
      actor: user,
      action: 'model.update',
      targetType: 'ModelConfig',
      targetId: id,
      diff: { isDefault: { from: model.isDefault, to: true } },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.models.bumpRevision('models', user.id);

    const provider = await this.requireProvider(updated.providerId);
    const taskRefCount = await this.prisma.db.generationTask.count({ where: { modelConfigId: id } });
    return this.toModelView(updated, provider, taskRefCount);
  }

  private async clearOtherDefaults(
    tx: ModelConfigUpdateManyCapable,
    keepId: string,
    capabilities: ModelCapability[],
  ): Promise<void> {
    for (const capability of capabilities) {
      await tx.modelConfig.updateMany({
        where: { id: { not: keepId }, isDefault: true, capabilities: { has: capability } },
        data: { isDefault: false },
      });
    }
  }

  // ===========================================================================
  // 策略
  // ===========================================================================

  async getPolicy(): Promise<ModelSelectionPolicy> {
    return this.models.getPolicy();
  }

  async updatePolicy(
    user: AuthUser,
    dto: ModelPolicyUpdateInput,
    meta: ClientMeta,
  ): Promise<ModelSelectionPolicy> {
    const before = await this.models.getPolicy();

    if (dto.image.mode === 'fixed') {
      await this.assertFixedTargetUsable(dto.image.fixedModelId, ['TEXT_TO_IMAGE', 'IMAGE_EDIT'], '生图');
    }
    if (dto.text.mode === 'fixed') {
      await this.assertFixedTargetUsable(dto.text.fixedModelId, ['TEXT'], '文案');
    }
    const titleInput = dto.title ?? before.title;
    if (!titleInput.inheritFromText && titleInput.mode === 'fixed') {
      await this.assertFixedTargetUsable(titleInput.fixedModelId, ['TEXT'], '标题生成');
    }

    const value: ModelSelectionPolicy = {
      image: {
        mode: dto.image.mode,
        fixedModelId: dto.image.mode === 'fixed' ? dto.image.fixedModelId : null,
      },
      text: {
        mode: dto.text.mode,
        fixedModelId: dto.text.mode === 'fixed' ? dto.text.fixedModelId : null,
      },
      title: {
        mode: titleInput.mode,
        fixedModelId: titleInput.inheritFromText || titleInput.mode !== 'fixed' ? null : titleInput.fixedModelId,
        inheritFromText: titleInput.inheritFromText,
      },
    };

    await this.prisma.db.systemConfig.upsert({
      where: { key: MODEL_POLICY_KEY },
      create: {
        key: MODEL_POLICY_KEY,
        value: value as unknown as Prisma.InputJsonValue,
        group: 'models',
        isPublic: true,
        isSecret: false,
        description: '模型选择策略:用户可选 / 后台固定单模型',
        updatedBy: user.id,
      },
      update: {
        value: value as unknown as Prisma.InputJsonValue,
        version: { increment: 1 },
        updatedBy: user.id,
      },
    });

    await this.audit.record({
      actor: user,
      action: 'model.policy.update',
      targetType: 'SystemConfig',
      targetId: MODEL_POLICY_KEY,
      diff: this.audit.buildDiff(
        { image: before.image, text: before.text },
        { image: value.image, text: value.text },
      ),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    await this.models.bumpRevision('models', user.id);
    return value;
  }

  /** 固定模型必须真的能用,否则用户提交时才发现不可用,且无法自行更换 */
  private async assertFixedTargetUsable(
    modelConfigId: string | null,
    capabilities: Array<'TEXT_TO_IMAGE' | 'IMAGE_EDIT' | 'TEXT'>,
    label: string,
  ): Promise<void> {
    if (!modelConfigId) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        `${label}设置为固定模型时必须指定具体模型`,
      );
    }

    const model = await this.prisma.db.modelConfig.findFirst({
      where: { id: modelConfigId, deletedAt: null },
      include: { provider: true },
    });
    if (!model) throw AppException.badRequest(ERROR_CODES.MODEL_NOT_AVAILABLE, `${label}指定的模型不存在`);
    if (!model.enabled) throw AppException.badRequest(ERROR_CODES.MODEL_DISABLED, `${label}指定的模型已停用`);
    if (!model.provider.enabled || model.provider.deletedAt) {
      throw AppException.badRequest(ERROR_CODES.MODEL_DISABLED, `${label}指定模型的供应商已停用`);
    }
    if (!model.provider.hasCredential) {
      throw AppException.badRequest(ERROR_CODES.MODEL_CREDENTIAL_MISSING, `${label}指定的模型尚未配置凭据`);
    }
    const wanted = capabilities.map((c) => ModelConfigService.toPrismaCapability(c));
    if (!wanted.some((c) => model.capabilities.includes(c))) {
      throw AppException.badRequest(
        ERROR_CODES.MODEL_CAPABILITY_MISMATCH,
        `${label}指定的模型不具备所需能力`,
      );
    }
  }

  // ===========================================================================
  // 辅助
  // ===========================================================================

  private async requireProvider(id: string): Promise<ModelProvider> {
    const provider = await this.prisma.db.modelProvider.findFirst({ where: { id, deletedAt: null } });
    if (!provider) throw AppException.notFound('供应商不存在或已被删除');
    return provider;
  }

  private async requireModel(id: string): Promise<ModelConfig> {
    const model = await this.prisma.db.modelConfig.findFirst({ where: { id, deletedAt: null } });
    if (!model) throw AppException.notFound('模型不存在或已被删除');
    return model;
  }

  private async modelIdsOfProvider(providerId: string): Promise<string[]> {
    const rows = await this.prisma.db.modelConfig.findMany({
      where: { providerId, deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** 供应商视图。只回脱敏后的密钥展示值,绝不回传明文。 */
  private toProviderView(provider: ModelProvider, modelCount: number): AdminProviderView {
    return {
      id: provider.id,
      slug: provider.slug,
      kind: provider.kind as AdminProviderView['kind'],
      name: provider.name,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      sortOrder: provider.sortOrder,
      apiKeyMasked: provider.apiKeyMasked,
      hasCredential: provider.hasCredential,
      rateLimitPerMinute: provider.rateLimitPerMinute,
      maxConcurrency: provider.maxConcurrency,
      modelCount,
      lastTestedAt: provider.lastTestedAt?.toISOString() ?? null,
      lastTestOk: provider.lastTestOk,
      lastTestMessage: provider.lastTestMessage,
      createdAt: provider.createdAt.toISOString(),
    };
  }

  private toModelView(
    model: ModelConfig,
    provider: ModelProvider,
    taskRefCount: number,
  ): AdminModelConfigView {
    const limits = modelLimitsSchema.safeParse(model.limits);
    if (!limits.success) {
      this.logger.warn(`模型 ${model.slug} 的 limits 字段不合法,后台展示使用默认值`);
    }

    return {
      id: model.id,
      providerId: provider.id,
      providerSlug: provider.slug,
      providerName: provider.name,
      providerKind: provider.kind as AdminModelConfigView['providerKind'],
      providerHasCredential: provider.hasCredential,
      slug: model.slug,
      displayName: model.displayName,
      modelKey: model.modelKey,
      capabilities: model.capabilities,
      enabled: model.enabled,
      visible: model.visible,
      sortOrder: model.sortOrder,
      isDefault: model.isDefault,
      limits: limits.success ? limits.data : DEFAULT_MODEL_LIMITS,
      defaultParams: (model.defaultParams ?? {}) as Record<string, unknown>,
      taskRefCount,
      createdAt: model.createdAt.toISOString(),
      updatedAt: model.updatedAt.toISOString(),
    };
  }
}
