import { Injectable, Logger } from '@nestjs/common';
import type { ModelConfig, ModelProvider } from '@june/db';
import {
  DEFAULT_MODEL_LIMITS,
  ERROR_CODES,
  modelLimitsSchema,
  type ModelLimits,
  type ModelSelectionPolicy,
} from '@june/shared';

import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ModelConfigService } from './model-config.service';

export type RequestCapability = 'TEXT_TO_IMAGE' | 'IMAGE_EDIT' | 'TEXT';

export interface ResolveForSubmitInput {
  capability: RequestCapability;
  /** 用户请求里指定的模型。fixed 策略下会被忽略或直接拒绝。 */
  requestedModelConfigId?: string | undefined;
}

export interface ResolvedModel {
  modelConfig: ModelConfig;
  provider: ModelProvider;
  limits: ModelLimits;
  configVersion: number;
  /** 本次是否由后台策略强制指定 */
  locked: boolean;
}

/**
 * 提交任务时的模型裁决。安全关键路径。
 *
 * 三条硬性规则:
 *  1. **一律回源数据库**。停用状态、凭据状态、能力都不允许由缓存放行,
 *     否则"后台刚停用的模型"会在缓存 TTL 内继续被调用并产生费用。
 *  2. **策略优先于请求参数**。后台设为固定单模型时,请求体里的 modelConfigId
 *     被忽略;如果请求显式指定了另一个模型,直接拒绝并告知已锁定,
 *     而不是静默替换——用户必须知道自己实际用的是哪个模型。
 *  3. 每一步失败都有独立错误码,前端能给出准确提示而不是笼统的"不可用"。
 */
@Injectable()
export class ModelResolverService {
  private readonly logger = new Logger(ModelResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly models: ModelConfigService,
  ) {}

  async resolveForSubmit(input: ResolveForSubmitInput): Promise<ResolvedModel> {
    const policy = await this.models.getPolicy();
    const scoped = input.capability === 'TEXT' ? policy.text : policy.image;

    const { modelConfigId, locked } = await this.pickModelId(input, scoped);
    const { modelConfig, provider } = await this.loadAndValidate(modelConfigId, input.capability, locked);

    return {
      modelConfig,
      provider,
      limits: this.parseLimits(modelConfig),
      configVersion: await this.models.getRevision('models'),
      locked,
    };
  }

  // ---------------------------------------------------------------------------

  private async pickModelId(
    input: ResolveForSubmitInput,
    scoped: ModelSelectionPolicy['image'],
  ): Promise<{ modelConfigId: string; locked: boolean }> {
    if (scoped.mode === 'fixed') {
      if (!scoped.fixedModelId) {
        throw AppException.badRequest(
          ERROR_CODES.MODEL_NOT_AVAILABLE,
          '后台已设置为固定模型模式但尚未指定模型,请联系管理员',
        );
      }
      if (input.requestedModelConfigId && input.requestedModelConfigId !== scoped.fixedModelId) {
        // 明确拒绝而不是静默替换:用户有权知道请求没有按其指定执行
        throw AppException.badRequest(
          ERROR_CODES.MODEL_SELECTION_LOCKED,
          '当前由后台指定固定模型,不接受自选模型,请刷新页面后重试',
        );
      }
      return { modelConfigId: scoped.fixedModelId, locked: true };
    }

    if (input.requestedModelConfigId) {
      return { modelConfigId: input.requestedModelConfigId, locked: false };
    }

    const fallback = await this.prisma.db.modelConfig.findFirst({
      where: {
        isDefault: true,
        enabled: true,
        visible: true,
        deletedAt: null,
        capabilities: { has: ModelConfigService.toPrismaCapability(input.capability) },
        provider: { enabled: true, hasCredential: true, deletedAt: null },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });

    if (!fallback) {
      throw AppException.badRequest(
        ERROR_CODES.MODEL_NOT_AVAILABLE,
        '当前没有可用的默认模型,请选择模型或联系管理员配置',
      );
    }
    return { modelConfigId: fallback.id, locked: false };
  }

  /**
   * 逐项校验。顺序即错误码的优先级:先判存在,再判停用,最后判能力,
   * 这样用户拿到的提示总是"最根本的那个原因"。
   */
  private async loadAndValidate(
    modelConfigId: string,
    capability: RequestCapability,
    locked: boolean,
  ): Promise<{ modelConfig: ModelConfig; provider: ModelProvider }> {
    const row = await this.prisma.db.modelConfig.findFirst({
      where: { id: modelConfigId, deletedAt: null },
      include: { provider: true },
    });

    if (!row) {
      throw AppException.badRequest(ERROR_CODES.MODEL_NOT_AVAILABLE, '所选模型不存在或已被删除');
    }
    if (!row.enabled) {
      throw AppException.badRequest(ERROR_CODES.MODEL_DISABLED);
    }
    // 可见性只约束"用户能不能自己选"。fixed 模式是管理员显式指定的,
    // 此时模型对用户不可见是正常配置(前端本来就隐藏了选择器),不应因此拒绝提交。
    if (!row.visible && !locked) {
      throw AppException.badRequest(ERROR_CODES.MODEL_NOT_AVAILABLE, '所选模型当前不可选用');
    }
    if (row.provider.deletedAt || !row.provider.enabled) {
      throw AppException.badRequest(ERROR_CODES.MODEL_DISABLED, '该模型所属供应商已停用');
    }
    if (!row.provider.hasCredential) {
      throw AppException.badRequest(ERROR_CODES.MODEL_CREDENTIAL_MISSING);
    }
    if (!row.capabilities.includes(ModelConfigService.toPrismaCapability(capability))) {
      throw AppException.badRequest(ERROR_CODES.MODEL_CAPABILITY_MISMATCH);
    }

    const { provider, ...modelConfig } = row;
    return { modelConfig, provider };
  }

  /** limits 解析失败时回落到最保守的默认能力,并记警告,而不是让提交直接崩掉 */
  private parseLimits(modelConfig: ModelConfig): ModelLimits {
    const parsed = modelLimitsSchema.safeParse(modelConfig.limits);
    if (parsed.success) return parsed.data;

    this.logger.warn(
      `模型 ${modelConfig.slug} 的 limits 字段不合法,已回落为默认能力:${
        parsed.error.issues[0]?.message ?? '未知原因'
      }`,
    );
    return DEFAULT_MODEL_LIMITS;
  }
}
