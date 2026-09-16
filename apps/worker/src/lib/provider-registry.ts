/**
 * 供应商适配器解析。
 *
 * 依赖:`@june/providers`(packages/providers)由另一任务实现。本任务编写时该包尚未
 * 产出 `src/index.ts` / `src/registry.ts`,因此这里:
 *   1. 类型上只依赖 provider-contract.ts(结构镜像 packages/providers/src/types.ts);
 *   2. 运行期用 require 动态加载,并按约定的导出名解析注册表。
 *
 * 期望 `@june/providers` 至少导出下列其中一组(按顺序尝试):
 *   - getImageProvider(kind: ProviderKind): ImageProvider | null
 *     getTextProvider(kind: ProviderKind): TextProvider | null
 *   - createImageProvider(kind) / createTextProvider(kind)
 *   - providerRegistry.image(kind) / providerRegistry.text(kind)
 *
 * 解析失败时抛出的错误会让任务以 MODEL_NOT_AVAILABLE 失败,**不会**触发上游调用,
 * 因此不存在"适配层没就绪却把钱花出去"的风险。
 */
import { createLogger } from './logger';
import type { ImageProvider, ProviderKindValue, TextProvider } from './provider-contract';

const log = createLogger('providers');

type ProvidersModule = {
  getImageProvider?: (kind: string) => ImageProvider | null | undefined;
  getTextProvider?: (kind: string) => TextProvider | null | undefined;
  createImageProvider?: (kind: string) => ImageProvider | null | undefined;
  createTextProvider?: (kind: string) => TextProvider | null | undefined;
  providerRegistry?: {
    image?: (kind: string) => ImageProvider | null | undefined;
    text?: (kind: string) => TextProvider | null | undefined;
  };
};

let cached: ProvidersModule | null = null;
let loadError: string | null = null;

function loadModule(): ProvidersModule {
  if (cached) return cached;
  if (loadError) throw new Error(loadError);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('@june/providers') as ProvidersModule;
    return cached;
  } catch (err) {
    loadError = `供应商适配层 @june/providers 不可用:${(err as Error).message}`;
    log.error(loadError);
    throw new Error(loadError);
  }
}

export function resolveImageProvider(kind: ProviderKindValue): ImageProvider {
  const mod = loadModule();
  const provider =
    mod.getImageProvider?.(kind) ?? mod.createImageProvider?.(kind) ?? mod.providerRegistry?.image?.(kind);
  if (!provider) {
    throw new Error(`没有匹配 ${kind} 的生图适配器(@june/providers 未注册该协议)`);
  }
  return provider;
}

export function resolveTextProvider(kind: ProviderKindValue): TextProvider {
  const mod = loadModule();
  const provider =
    mod.getTextProvider?.(kind) ?? mod.createTextProvider?.(kind) ?? mod.providerRegistry?.text?.(kind);
  if (!provider) {
    throw new Error(`没有匹配 ${kind} 的文本适配器(@june/providers 未注册该协议)`);
  }
  return provider;
}

/** 启动自检:只探测模块是否可加载,不做任何网络请求 */
export function providersAvailable(): boolean {
  try {
    loadModule();
    return true;
  } catch {
    return false;
  }
}
