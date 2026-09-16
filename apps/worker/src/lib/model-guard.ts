/**
 * 上游调用前的模型可用性复核。
 *
 * 为什么必须在 Worker 里再查一次:
 *   任务在队列里可能等了几分钟甚至几小时。这期间管理员完全可能停用模型、删除模型、
 *   或清空供应商凭据。如果 Worker 沿用提交时的快照直接调用,就会出现
 *   "后台已经停用了却还在花钱"的情况。
 *
 * 硬性要求(docs/CONVENTIONS.md §11):**回源数据库判断,不允许依赖任何可能过期的缓存放行。**
 */
import { ERROR_CODES, type ErrorCode, type ModelLimits } from '@june/shared';
import { DEFAULT_MODEL_LIMITS, modelLimitsSchema } from '@june/shared';
import type { ModelConfig, ModelProvider } from '@june/db';

import type { ProviderKindValue } from './provider-contract';

export interface UsableModel {
  modelConfig: ModelConfig;
  provider: ModelProvider;
  providerKind: ProviderKindValue;
  limits: ModelLimits;
  /** 供应商侧真实模型标识 */
  modelKey: string;
  /** 后台配置的供应商特有固定参数(如 watermark=false) */
  defaultParams: Record<string, unknown>;
}

export type ModelGuardResult =
  | { ok: true; model: UsableModel }
  | { ok: false; errorCode: ErrorCode; message: string };

type ModelConfigWithProvider = ModelConfig & { provider: ModelProvider | null };

export function checkModelUsable(modelConfig: ModelConfigWithProvider | null): ModelGuardResult {
  if (!modelConfig || modelConfig.deletedAt) {
    return {
      ok: false,
      errorCode: ERROR_CODES.MODEL_DISABLED,
      message: '所选模型已被删除,任务已终止且未产生任何上游调用',
    };
  }
  if (!modelConfig.enabled) {
    return {
      ok: false,
      errorCode: ERROR_CODES.MODEL_DISABLED,
      message: '所选模型已被停用,任务已终止且未产生任何上游调用',
    };
  }

  const provider = modelConfig.provider;
  if (!provider || provider.deletedAt) {
    return {
      ok: false,
      errorCode: ERROR_CODES.MODEL_DISABLED,
      message: '所选模型的供应商已被删除,任务已终止且未产生任何上游调用',
    };
  }
  if (!provider.enabled) {
    return {
      ok: false,
      errorCode: ERROR_CODES.MODEL_DISABLED,
      message: '所选模型的供应商已被停用,任务已终止且未产生任何上游调用',
    };
  }
  // 凭据被清除:hasCredential 与三个密文字段都要看,任一缺失都不可能调用成功
  if (!provider.hasCredential || !provider.apiKeyCipher || !provider.apiKeyIv || !provider.apiKeyTag) {
    return {
      ok: false,
      errorCode: ERROR_CODES.MODEL_CREDENTIAL_MISSING,
      message: '所选模型的供应商凭据已被清除,任务已终止且未产生任何上游调用',
    };
  }

  const parsed = modelLimitsSchema.safeParse(modelConfig.limits);
  return {
    ok: true,
    model: {
      modelConfig,
      provider,
      providerKind: provider.kind as ProviderKindValue,
      // limits 解析失败时退到最保守的默认能力,而不是放行一个可能越界的请求
      limits: parsed.success ? parsed.data : DEFAULT_MODEL_LIMITS,
      modelKey: modelConfig.modelKey,
      defaultParams:
        modelConfig.defaultParams && typeof modelConfig.defaultParams === 'object' && !Array.isArray(modelConfig.defaultParams)
          ? (modelConfig.defaultParams as Record<string, unknown>)
          : {},
    },
  };
}
