'use client';

import { BrandLogo } from '@june/brand';
import { BRAND_FULL_NAME } from '@june/shared';

/**
 * 全站页脚。
 * 只展示事实信息:完整品牌名、版权、平台包含的功能模块。不加任何宣传语。
 */
export function SiteFooter({ theme }: { theme: 'dark' | 'light' }): React.JSX.Element {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border-default bg-bg-elevated/60">
      <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-3 px-4 py-6 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-2">
          <BrandLogo variant="icon" theme={theme} size="sm" />
          <span className="font-medium text-fg">{BRAND_FULL_NAME}</span>
        </div>

        <p className="text-xs text-fg-muted">社区 · 生图与文案工作台 · 店铺与商品管理</p>

        <p className="text-xs text-fg-subtle">
          © {year} {BRAND_FULL_NAME}
        </p>
      </div>
    </footer>
  );
}
