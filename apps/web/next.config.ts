import type { NextConfig } from 'next';

/**
 * Next.js 配置。
 *
 * 要点:
 *  - `output: 'standalone'`:生产镜像只需 .next/standalone,体积小、启动快。
 *    monorepo 下必须设置 outputFileTracingRoot 指向仓库根,否则会漏掉 workspace 依赖。
 *  - 浏览器直连 API:`NEXT_PUBLIC_API_BASE_URL` 由 Nginx 统一到同源 /api,
 *    避免跨域与 Cookie SameSite 问题。开发环境用 rewrites 代理到本地 API。
 *  - 图片:对象存储域名走 remotePatterns 白名单;私有资产通过后端签名 URL 访问,
 *    因此这里只允许配置化的域名,不开放任意远程图片。
 */

const isProd = process.env.NODE_ENV === 'production';

/** 对象存储公共访问域名(可选)。私有资产始终走后端签名 URL。 */
const publicAssetHost = process.env.NEXT_PUBLIC_ASSET_HOST?.trim();

function parseHost(value: string | undefined): { protocol: 'http' | 'https'; hostname: string; port: string } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return {
      protocol: url.protocol === 'http:' ? 'http' : 'https',
      hostname: url.hostname,
      port: url.port,
    };
  } catch {
    return null;
  }
}

const assetHost = parseHost(publicAssetHost);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,

  // 允许从 workspace 包直接引入 TS/TSX 源码(@june/brand 导出 React 组件)
  transpilePackages: ['@june/brand', '@june/shared'],

  experimental: {
    // 只对确定用到的包做按需引入优化,减小首屏 JS
    optimizePackageImports: ['lucide-react', 'recharts', 'date-fns'],
  },

  images: {
    // 派生图已在服务端生成(thumb/preview),这里只做尺寸协商,不做二次转码
    formats: ['image/webp'],
    deviceSizes: [390, 640, 768, 1024, 1280, 1440, 1920],
    imageSizes: [64, 96, 128, 200, 256, 400, 800],
    remotePatterns: assetHost
      ? [{ protocol: assetHost.protocol, hostname: assetHost.hostname, port: assetHost.port, pathname: '/**' }]
      : [],
    // 签名 URL 带查询参数且短时有效,交给浏览器缓存即可
    minimumCacheTTL: 300,
  },

  async rewrites() {
    // 生产由 Nginx 统一反代 /api,这里只在开发环境代理,避免双重代理
    if (isProd) return [];
    const apiOrigin = process.env.DEV_API_ORIGIN ?? 'http://127.0.0.1:3001';
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        // 品牌资产不含用户数据,可长期缓存
        source: '/brand/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
};

export default nextConfig;
