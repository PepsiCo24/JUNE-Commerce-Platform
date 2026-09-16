import { TARGET_PLATFORMS } from '@june/shared';

export const RULE_TYPE_LABELS: Record<string, string> = {
  SYSTEM_PROMPT: '系统提示词',
  BANNED_WORD: '违禁词',
  BANNED_PHRASE: '违禁短语 / 正则',
  BANNED_CATEGORY: '违禁类别',
  PLATFORM_RULE: '平台规则',
};

export const RULE_ACTION_LABELS: Record<string, string> = {
  BLOCK: '拦截',
  REWRITE: '改写',
  WARN: '警告',
};

export const TASK_TYPE_LABELS: Record<string, string> = {
  IMAGE_GENERATE: '文生图',
  IMAGE_EDIT: '图编辑',
  TEXT_COPY: '文案',
};

export const CLEANUP_KIND_LABELS: Record<string, string> = {
  orphan_asset: '孤儿资产',
  expired_upload: '过期上传',
  recycled_asset: '回收站过期',
  queue_record: '队列记录',
};

export const PLATFORM_OPTIONS = TARGET_PLATFORMS.map((item) => ({ value: item.value, label: item.label }));

export function labelOf(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}
