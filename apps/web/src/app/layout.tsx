import { BRAND_FULL_NAME, BRAND_SHORT_NAME, TITLE_SEPARATOR } from '@june/shared';
import type { Metadata, Viewport } from 'next';

import { AppProviders } from '@/providers/app-providers';
import { SessionWatcher } from '@/components/system/session-watcher';
import { ThemeScript } from '@/components/system/theme-script';

import './globals.css';

/**
 * 根布局。
 *
 * 说明:
 *  - 页面标题统一为「页面名称 · JUNE」,由各页面的 metadata.title 配合 template 生成;
 *    帖子详情页会覆盖 openGraph 以生成按帖子定制的分享元信息。
 *  - 默认 data-theme="dark":登录页、双入口首页、工作台都是深色场景;
 *    社区与 /admin 在自己的布局里改为 data-theme="light"。
 *  - 不引入任何外部字体 CDN,字体栈见 globals.css。
 */

export const metadata: Metadata = {
  title: {
    default: `${BRAND_SHORT_NAME}${TITLE_SEPARATOR}电商创作与运营平台`,
    template: `%s${TITLE_SEPARATOR}${BRAND_SHORT_NAME}`,
  },
  description: `${BRAND_FULL_NAME} —— 面向电商团队的创作与运营平台,提供社区、生图与文案工作台、店铺商品管理。`,
  applicationName: BRAND_FULL_NAME,
  // 品牌图标全部来自 @june/brand,构建前由 scripts/sync-brand-assets.mjs 同步到 public/brand
  icons: {
    icon: [
      { url: '/brand/icons/favicon.svg', type: 'image/svg+xml' },
      { url: '/brand/icons/favicon-32.svg', type: 'image/svg+xml', sizes: '32x32' },
      { url: '/brand/icons/favicon-16.svg', type: 'image/svg+xml', sizes: '16x16' },
    ],
    apple: [{ url: '/brand/icons/apple-touch-icon.svg' }],
  },
  manifest: '/brand/icons/manifest.webmanifest',
  formatDetection: { telephone: false, email: false, address: false },
  // 社区帖子是公开可索引的,其余区域由各布局单独收敛
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // 允许用户缩放,这是可访问性要求,不做 maximum-scale 限制
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0A0D1A' },
    { media: '(prefers-color-scheme: light)', color: '#FAFAF9' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        {/* 键盘用户的跳转链接:聚焦时才显示 */}
        <a
          href="#main"
          className="sr-only rounded-md bg-accent px-4 py-2 text-accent-fg focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-100"
        >
          跳到主要内容
        </a>
        <AppProviders>
          <SessionWatcher />
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
