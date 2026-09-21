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

export const ASSET_KIND_LABELS: Record<string, string> = {
  POST_IMAGE: '帖子图',
  PRODUCT_IMAGE: '商品图',
  SHOP_IMAGE: '店铺图',
  AVATAR: '头像',
  REFERENCE_IMAGE: '参考图',
  GENERATED_IMAGE: '生成图',
  IMPORT_FILE: '导入文件',
};

export const PLATFORM_OPTIONS = TARGET_PLATFORMS.map((item) => ({ value: item.value, label: item.label }));

export function labelOf(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}
