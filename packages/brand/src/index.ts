/**
 * @june/brand —— JUNE 品牌视觉资产包。
 *
 * ⚠ 待对照用户提供的品牌设计图校准(当前为按书面规则制作的初稿)。
 *
 * 本包只导出一个渲染入口 BrandLogo:所有页面的 Logo 必须由它管理,
 * 禁止各页面自行拼 <svg> / <img> 或截图裁切。
 *
 * 原始矢量资产(SVG / webmanifest)不经过打包,直接从 assets/ 目录取用:
 *   packages/brand/assets/            图标、字标、四种组合标
 *   packages/brand/assets/icons/      favicon、apple-touch-icon、PWA 图标、manifest
 *   packages/brand/scripts/           位图栅格化脚本
 *
 * 品牌规范见 docs/BRAND.md。
 */

export { BrandLogo, BRAND_LOGO_NAME } from './BrandLogo';
export type { BrandLogoProps, BrandLogoSize, BrandLogoTheme, BrandLogoVariant } from './BrandLogo';
