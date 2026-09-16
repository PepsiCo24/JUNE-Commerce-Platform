/** 工作台展示用格式化。不从管理站复用,避免跨模块依赖。 */

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

export const SHOP_TYPE_LABEL: Record<'MAIN' | 'SUB', string> = {
  MAIN: '主店',
  SUB: '子店',
};

export const TASK_TYPE_LABEL: Record<string, string> = {
  IMAGE_GENERATE: '生图',
  IMAGE_EDIT: '改图',
  TEXT_COPY: '文案',
};

export const PRODUCT_STATUS_OPTIONS = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'ACTIVE', label: '在售' },
  { value: 'OFF_SHELF', label: '已下架' },
  { value: 'ARCHIVED', label: '已归档' },
] as const;
