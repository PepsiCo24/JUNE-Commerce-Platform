/**
 * 工作台场景下的错误码文案与分支判定。
 *
 * 原则:一律按 `ApiError.code` 分支,不匹配错误文案(契约第 3 节)。
 * 这里只覆盖"需要比默认提示更具体"的错误码,其余交回 describeError。
 */

import { ERROR_CODES } from '@june/shared';

import { ApiError } from '@/lib/api/errors';
import { describeError } from '@/lib/api/errors';

/** 生图/文案提交阶段需要特别提示的错误码 */
export const SUBMIT_ERROR_COPY: Record<string, string> = {
  [ERROR_CODES.QUEUE_FULL]: '任务队列已满,请稍后再提交',
  [ERROR_CODES.MODEL_SELECTION_LOCKED]:
    '后台已将生成模型固定,不接受自选模型;已为你刷新最新配置,请重新提交',
  [ERROR_CODES.MODEL_DISABLED]: '所选模型已被停用,请重新选择',
  [ERROR_CODES.MODEL_NOT_AVAILABLE]: '所选模型当前不可用,请重新选择',
  [ERROR_CODES.MODEL_CREDENTIAL_MISSING]: '该模型尚未配置凭据,暂不可用',
  [ERROR_CODES.MODEL_CAPABILITY_MISMATCH]: '所选模型不支持该操作,请更换模型',
  [ERROR_CODES.PARAM_EXCEEDS_MODEL_LIMIT]: '参数超出该模型的能力上限,请按下方字段提示调整',
  [ERROR_CODES.CONTENT_BLOCKED_INPUT]: '输入内容未通过内容检查,请按提示修改后重试',
  [ERROR_CODES.TASK_NOT_RETRYABLE]: '该任务当前状态不支持重试',
  [ERROR_CODES.UPSTREAM_RESULT_UNKNOWN]: '上游结果待确认,系统正在核对,请勿重复提交',
};

/** 店铺相关错误码。层级/归属类错误需要明确指出原因,否则用户无从下手 */
export const SHOP_ERROR_COPY: Record<string, string> = {
  [ERROR_CODES.SHOP_CYCLE_DETECTED]: '店铺关系不能形成循环:不能把店铺挂到它自己的下级店铺下',
  [ERROR_CODES.SHOP_CROSS_OWNER]: '不能挂接到其他用户的店铺,请选择自己名下的主店铺',
  [ERROR_CODES.SHOP_PARENT_MUST_BE_MAIN]: '子店铺只能挂接到主店铺,不能挂到另一个子店铺下',
  [ERROR_CODES.SHOP_DEPTH_EXCEEDED]: '店铺层级超出上限(当前业务只支持主店 → 子店两级)',
  [ERROR_CODES.SHOP_HAS_DEPENDENTS]: '该主店铺下仍有子店铺、商品或凭据,请先选择处理方式',
};

export const PRODUCT_ERROR_COPY: Record<string, string> = {
  [ERROR_CODES.PRODUCT_SKU_DUPLICATE]: '同一店铺下 SKU 不能重复',
  [ERROR_CODES.IMPORT_TOO_MANY_ROWS]: 'CSV 行数超出上限,请拆分文件后再导入',
  [ERROR_CODES.QUOTA_EXCEEDED]: '存储空间不足,请先清理不用的图片',
  [ERROR_CODES.FILE_TOO_LARGE]: '文件超过大小上限',
  [ERROR_CODES.UNSUPPORTED_MEDIA_TYPE]: '不支持该文件类型',
};

/** 按覆盖表取文案,未覆盖的错误码回落到统一描述 */
export function describeWithOverrides(error: unknown, overrides: Record<string, string>): string {
  if (error instanceof ApiError) {
    const override = overrides[error.code];
    if (override) return override;
  }
  return describeError(error);
}

export function errorCodeOf(error: unknown): string | null {
  return error instanceof ApiError ? String(error.code) : null;
}

export function isCode(error: unknown, code: string): boolean {
  return errorCodeOf(error) === code;
}

/**
 * USER_CONCURRENCY_LIMIT 的提示需要带上当前运行/待执行数与上限。
 * 后端把这三个数字放在 details 里(path 形如 running / pending / limit),
 * 拿不到时退回不带数字的通用提示,绝不编造数值。
 */
export function describeConcurrencyLimit(
  error: unknown,
  fallbackLimits?: { running: number; pending: number },
): string {
  if (!(error instanceof ApiError)) return describeError(error);

  const numbers = new Map<string, string>();
  for (const detail of error.details) {
    numbers.set(detail.path, detail.message);
  }

  const running = numbers.get('running');
  const pending = numbers.get('pending');
  const runningLimit = numbers.get('runningLimit') ?? numbers.get('limit');
  const pendingLimit = numbers.get('pendingLimit');

  const parts: string[] = [];
  if (running !== undefined) {
    parts.push(`正在运行 ${running}${runningLimit ? ` / 上限 ${runningLimit}` : ''}`);
  } else if (fallbackLimits) {
    parts.push(`运行中任务上限 ${fallbackLimits.running}`);
  }
  if (pending !== undefined) {
    parts.push(`待执行 ${pending}${pendingLimit ? ` / 上限 ${pendingLimit}` : ''}`);
  } else if (fallbackLimits) {
    parts.push(`待执行任务上限 ${fallbackLimits.pending}`);
  }

  return parts.length > 0
    ? `已达到并发上限(${parts.join(',')}),请等待在途任务完成后再提交`
    : error.message;
}
