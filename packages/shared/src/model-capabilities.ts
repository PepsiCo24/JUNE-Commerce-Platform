/**
 * 模型能力描述。
 *
 * 重要原则:
 *  1. 每个模型的真实能力(尺寸、比例、输出张数、参考图数量、是否异步)由后台配置的
 *     limits 字段决定,前端根据 limits 决定渲染哪些控件,后端在提交时再次强校验。
 *     "前端隐藏"不等于"后端放行",两侧使用同一份校验函数。
 *  2. 不假设各家接口兼容:同步返回 / 异步轮询、尺寸表达方式(size 字符串或 width+height)、
 *     是否支持负向提示词等,都在 limits 中显式声明,由适配层翻译成各家参数。
 *  3. 未配置凭据或已停用的模型不得出现在用户可选列表中。
 */

import { z } from 'zod';

/** 尺寸表达方式:各家接口不同,适配层据此翻译 */
export const SIZE_MODES = ['size_string', 'width_height', 'aspect_ratio'] as const;
export type SizeMode = (typeof SIZE_MODES)[number];

/** 结果返回方式 */
export const DELIVERY_MODES = ['sync', 'async_poll'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** 图片返回载体 */
export const RESULT_CARRIERS = ['url', 'base64'] as const;
export type ResultCarrier = (typeof RESULT_CARRIERS)[number];

export const modelLimitsSchema = z.object({
  /** 单次请求可产出的最大图片数。若上游不支持 n>1,适配层会拆分为多次调用,每次调用都计入配额与限流 */
  maxOutputs: z.number().int().min(1).max(16).default(1),
  /** 上游单次调用支持的最大张数;小于 maxOutputs 时由适配层拆分调用 */
  maxOutputsPerCall: z.number().int().min(1).max(16).default(1),
  /** 参考图数量上限。0 表示不支持参考图(纯文生图) */
  maxReferenceImages: z.number().int().min(0).max(16).default(0),
  /** 参考图单张最大字节数,0 表示沿用平台默认 */
  maxReferenceBytes: z.number().int().min(0).default(0),
  /** 支持的固定尺寸(size_string 模式使用),如 "1024x1024" */
  sizes: z.array(z.string().regex(/^\d{2,5}x\d{2,5}$/)).default([]),
  /** 支持的宽高比(aspect_ratio 模式使用),如 "1:1" */
  aspectRatios: z.array(z.string().regex(/^\d{1,2}:\d{1,2}$/)).default([]),
  /** width_height 模式的取值范围与步长 */
  minWidth: z.number().int().min(64).optional(),
  maxWidth: z.number().int().max(8192).optional(),
  minHeight: z.number().int().min(64).optional(),
  maxHeight: z.number().int().max(8192).optional(),
  dimensionStep: z.number().int().min(1).default(64),
  sizeMode: z.enum(SIZE_MODES).default('size_string'),
  deliveryMode: z.enum(DELIVERY_MODES).default('sync'),
  resultCarrier: z.enum(RESULT_CARRIERS).default('url'),
  supportsNegativePrompt: z.boolean().default(false),
  supportsSeed: z.boolean().default(false),
  supportsImageEdit: z.boolean().default(false),
  /** 提示词最大长度(字符),0 表示沿用平台默认 */
  maxPromptChars: z.number().int().min(0).default(0),
  /** 上游返回的临时图片链接有效期(秒),用于提示"必须及时转存" */
  resultUrlTtlSeconds: z.number().int().min(0).default(0),
  /** 供应商侧文档地址,便于运维核对 */
  docsUrl: z.string().optional(),
  /**
   * 该 limits 是否已对照官方文档核对并完成真实联调。
   * false 表示仍处于"待真实联调"状态,管理后台会显著标注,不冒充可用。
   */
  verified: z.boolean().default(false),
  /** 文本模型专用:是否支持结构化输出(JSON Schema / json_object) */
  supportsStructuredOutput: z.boolean().default(false),
  maxOutputTokens: z.number().int().min(0).default(0),
});

export type ModelLimits = z.infer<typeof modelLimitsSchema>;

/** limits 的兜底默认值(后台未填写时使用最保守的能力) */
export const DEFAULT_MODEL_LIMITS: ModelLimits = modelLimitsSchema.parse({});

/**
 * 校验生图参数是否落在模型能力范围内。前端与后端共用,保证提示一致。
 * 返回空数组表示通过。
 */
export function validateImageParamsAgainstLimits(
  params: {
    count: number;
    size?: string | null;
    aspectRatio?: string | null;
    width?: number | null;
    height?: number | null;
    referenceCount: number;
    negativePrompt?: string | null;
    prompt: string;
  },
  limits: ModelLimits,
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];

  if (params.count < 1 || params.count > limits.maxOutputs) {
    issues.push({ path: 'count', message: `该模型单次最多生成 ${limits.maxOutputs} 张` });
  }

  if (params.referenceCount > limits.maxReferenceImages) {
    issues.push({
      path: 'referenceAssetIds',
      message:
        limits.maxReferenceImages === 0
          ? '该模型不支持参考图'
          : `该模型最多支持 ${limits.maxReferenceImages} 张参考图`,
    });
  }

  if (limits.maxPromptChars > 0 && params.prompt.length > limits.maxPromptChars) {
    issues.push({ path: 'prompt', message: `提示词最多 ${limits.maxPromptChars} 个字符` });
  }

  if (params.negativePrompt && !limits.supportsNegativePrompt) {
    issues.push({ path: 'negativePrompt', message: '该模型不支持负向提示词' });
  }

  switch (limits.sizeMode) {
    case 'size_string': {
      if (!params.size) {
        issues.push({ path: 'size', message: '请选择输出尺寸' });
      } else if (limits.sizes.length > 0 && !limits.sizes.includes(params.size)) {
        issues.push({ path: 'size', message: `该模型仅支持:${limits.sizes.join('、')}` });
      }
      break;
    }
    case 'aspect_ratio': {
      if (!params.aspectRatio) {
        issues.push({ path: 'aspectRatio', message: '请选择输出比例' });
      } else if (limits.aspectRatios.length > 0 && !limits.aspectRatios.includes(params.aspectRatio)) {
        issues.push({ path: 'aspectRatio', message: `该模型仅支持:${limits.aspectRatios.join('、')}` });
      }
      break;
    }
    case 'width_height': {
      const { width, height } = params;
      if (!width || !height) {
        issues.push({ path: 'width', message: '请填写输出宽高' });
        break;
      }
      if (limits.minWidth && width < limits.minWidth) {
        issues.push({ path: 'width', message: `宽度不能小于 ${limits.minWidth}` });
      }
      if (limits.maxWidth && width > limits.maxWidth) {
        issues.push({ path: 'width', message: `宽度不能大于 ${limits.maxWidth}` });
      }
      if (limits.minHeight && height < limits.minHeight) {
        issues.push({ path: 'height', message: `高度不能小于 ${limits.minHeight}` });
      }
      if (limits.maxHeight && height > limits.maxHeight) {
        issues.push({ path: 'height', message: `高度不能大于 ${limits.maxHeight}` });
      }
      if (limits.dimensionStep > 1) {
        if (width % limits.dimensionStep !== 0 || height % limits.dimensionStep !== 0) {
          issues.push({ path: 'width', message: `宽高需为 ${limits.dimensionStep} 的整数倍` });
        }
      }
      break;
    }
  }

  return issues;
}

/**
 * 计算一个生图任务需要向上游发起的实际调用次数。
 * 批量任务被拆分时,每次调用都要计入供应商频率限制与计费统计。
 */
export function countUpstreamCalls(requestedCount: number, limits: ModelLimits): number {
  const perCall = Math.max(1, Math.min(limits.maxOutputsPerCall, limits.maxOutputs));
  return Math.ceil(requestedCount / perCall);
}
