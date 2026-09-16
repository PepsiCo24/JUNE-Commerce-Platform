/**
 * 供应商注册表。
 *
 * 原则:**未实现的组合必须显式抛错,不做静默降级**。
 * 如果一个 providerSlug 没有对应的文本适配器,就抛 ProviderNotImplementedError,
 * 而不是「悄悄回退到 OpenAI」—— 静默降级会导致用户以为在用 A 模型、
 * 账单却出现在 B 供应商上,而且排查时毫无线索。
 */

import { ERROR_CODES, type ErrorCode } from '@june/shared';

import { AliyunWanxImageProvider } from './image/aliyun-wanx';
import { ArkSeedreamImageProvider } from './image/ark-seedream';
import { BflFluxImageProvider } from './image/bfl-flux';
import { GeminiImageProvider } from './image/gemini';
import { MockImageProvider, type MockProviderConfig } from './image/mock';
import { OpenAiImageProvider } from './image/openai';
import { GeminiTextProvider } from './text/gemini-text';
import { OpenAiCompatibleTextProvider } from './text/openai-compatible';
import type { ImageProvider, ProviderKind, TextProvider } from './types';

/** 携带统一错误码的异常,便于上层直接映射成 ApiErrorBody */
export class ProviderNotImplementedError extends Error {
  readonly code: ErrorCode = ERROR_CODES.MODEL_CAPABILITY_MISMATCH;

  constructor(kind: string, capability: 'image' | 'text') {
    super(
      capability === 'image'
        ? `供应商 ${kind} 没有生图适配器实现`
        : `供应商 ${kind} 没有文本适配器实现`,
    );
    this.name = 'ProviderNotImplementedError';
  }
}

/** 传入的 kind 不在 ProviderKind 枚举内 */
export class UnknownProviderError extends Error {
  readonly code: ErrorCode = ERROR_CODES.MODEL_NOT_AVAILABLE;

  constructor(kind: string) {
    super(`未知的供应商标识:${kind}`);
    this.name = 'UnknownProviderError';
  }
}

// 适配器是无状态的(凭据每次调用传入),可以安全复用单例。
// MOCK 例外:它持有异步任务表与压测配置,由 createMockImageProvider 按需构造。
const openAiImage = new OpenAiImageProvider();
const geminiImage = new GeminiImageProvider();
const arkImage = new ArkSeedreamImageProvider();
const wanxImage = new AliyunWanxImageProvider();
const bflImage = new BflFluxImageProvider();
const defaultMockImage = new MockImageProvider();

const openAiText = new OpenAiCompatibleTextProvider('OPENAI');
const openAiCompatibleText = new OpenAiCompatibleTextProvider('OPENAI_COMPATIBLE');
const geminiText = new GeminiTextProvider();

const KNOWN_KINDS = new Set<string>([
  'OPENAI',
  'GEMINI',
  'ARK_SEEDREAM',
  'ALIYUN_WANX',
  'BFL_FLUX',
  'OPENAI_COMPATIBLE',
  'MOCK',
]);

export function getImageProvider(kind: ProviderKind): ImageProvider {
  if (!KNOWN_KINDS.has(kind)) {
    throw new UnknownProviderError(String(kind));
  }
  switch (kind) {
    case 'OPENAI':
      return openAiImage;
    case 'GEMINI':
      return geminiImage;
    case 'ARK_SEEDREAM':
      return arkImage;
    case 'ALIYUN_WANX':
      return wanxImage;
    case 'BFL_FLUX':
      return bflImage;
    case 'MOCK':
      return defaultMockImage;
    case 'OPENAI_COMPATIBLE':
      // OpenAI 兼容网关的 /images 端点各家实现差异极大(有的只有 chat),
      // 未逐个核对之前不提供生图适配,显式抛错而不是拿 OpenAI 的实现顶上。
      throw new ProviderNotImplementedError(kind, 'image');
  }
}

export function getTextProvider(kind: ProviderKind): TextProvider {
  if (!KNOWN_KINDS.has(kind)) {
    throw new UnknownProviderError(String(kind));
  }
  switch (kind) {
    case 'OPENAI':
      return openAiText;
    case 'OPENAI_COMPATIBLE':
      return openAiCompatibleText;
    case 'GEMINI':
      return geminiText;
    case 'ARK_SEEDREAM':
    case 'ALIYUN_WANX':
    case 'BFL_FLUX':
    case 'MOCK':
      // 火山方舟有 chat 能力但本次未核对其文本接口;
      // 万相与 FLUX 是纯图像供应商;MOCK 只模拟生图。
      throw new ProviderNotImplementedError(kind, 'text');
  }
}

/**
 * 构造带压测配置的模拟供应商。
 * 压测时需要不同延迟 / 失败率的多个实例,不能共用注册表里的默认单例。
 */
export function createMockImageProvider(config?: Partial<MockProviderConfig>): MockImageProvider {
  return new MockImageProvider(config);
}

/** 汇总所有适配器声明的默认模型,供后台「一键导入模型」使用 */
export function describeAllDefaultModels(): Array<{
  kind: ProviderKind;
  capability: 'image' | 'text';
  models: ReturnType<ImageProvider['describeDefaultModels']>;
}> {
  const imageKinds: ProviderKind[] = ['OPENAI', 'GEMINI', 'ARK_SEEDREAM', 'ALIYUN_WANX', 'BFL_FLUX', 'MOCK'];
  const textKinds: ProviderKind[] = ['OPENAI', 'OPENAI_COMPATIBLE', 'GEMINI'];

  return [
    ...imageKinds.map((kind) => ({
      kind,
      capability: 'image' as const,
      models: getImageProvider(kind).describeDefaultModels(),
    })),
    ...textKinds.map((kind) => ({
      kind,
      capability: 'text' as const,
      models: getTextProvider(kind).describeDefaultModels(),
    })),
  ];
}
