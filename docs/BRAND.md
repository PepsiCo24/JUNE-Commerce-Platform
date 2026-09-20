# JUNE 品牌视觉规范

系统 Logo 按用户提供的 JUNE 品牌图重绘为 SVG。图形采用平面填色保留参考稿的轮廓和配色，不包含展示海报的背景纹理。

## 图形与配色

- JE 图标：独立的 J 竖笔、向左延伸的大弯钩，以及三段分离的 E 横条。上横和下横的右侧向下收圆，中横较短。
- 紫色交叠位于 J 竖笔右下侧，处于弯钩内侧。单色图标去掉紫色部分，保留笔画间隙。
- JUNE 字标：四个字母采用固定矢量轮廓，JUN 使用主色，E 使用青绿；不依赖系统字体。
- 深底主色为象牙白，浅底主色为深靛蓝。彩色 Logo 的 E 均使用品牌青绿，按参考图呈现。正文、链接和交互控件的对比度规则仍由设计系统管理。
- 浏览器和应用图标使用深靛蓝底、象牙白单色 JE，对应参考图右下角版本。
- 副标为 `COMMERCE PLATFORM`，用系统无衬线字体和固定文字宽度对齐字标。不添加口号。

色值沿用 `packages/shared/src/brand.ts`：深靛蓝 `indigo[900]`、象牙白 `ivory[50]`、青绿 `teal[400]`、紫色 `purple[400]`（深底）或 `purple[500]`（浅底）。

## 唯一来源

`packages/brand/src/geometry.ts` 保存 JE 和 JUNE 的路径与版式参数。`BrandLogo.tsx` 是页面的统一渲染入口，静态 SVG 由同一组件生成，避免资源与页面各画一套。

| 版式       | viewBox    | 用途                                              |
| ---------- | ---------- | ------------------------------------------------- |
| icon       | 360 × 360  | 独立图标，图形在正方形中垂直居中                  |
| horizontal | 1242 × 272 | JE + JUNE，无副标，用于导航栏                     |
| full       | 1242 × 272 | JE + JUNE + COMMERCE PLATFORM，用于登录等品牌展示 |

`size` 表示渲染高度，宽度按比例计算。保留 `theme="dark" / "light" / "mono"`、`showSubtitle`、`title`、`aria-label`、`className`、`style` 和 `data-testid` 接口。`mono` 跟随 `currentColor`。未提供无障碍名称时作为装饰图形。

小尺寸图标沿用相同轮廓，保证品牌形态一致。`icon-simplified.svg` 保留为旧资产路径的兼容别名。使用容器间距保留 Logo 周围留白，不拉伸图形。

## 静态资源与生成

```bash
pnpm brand:icons
```

该命令依次编译共享令牌和品牌组件、生成 SVG、生成 PNG，并同步到 `apps/web/public/brand`。

- `packages/brand/scripts/generate-vectors.mjs`：从组件和路径生成彩色、单色、深浅底组合标，以及 16 / 32 / 64 / 180 / 192 / 512 图标。
- `packages/brand/scripts/generate-rasters.mjs`：使用 sharp 生成 PNG；可复用 web 应用中 Next.js 的 sharp。安装了可选 `png-to-ico` 时同时生成 ICO。
- `apps/web/scripts/sync-brand-assets.mjs`：将源资产同步到 web 的 public 目录，dev / build 前也会执行。
- `manifest.webmanifest`：所有图标引用 `/brand/icons/`；应用图标底色不透明，JE 位于 maskable 安全区域内。
- Apple Touch Icon 使用 180 × 180 PNG，浏览器优先使用 SVG favicon。

修改路径或配色后重新运行生成命令，不直接编辑 `apps/web/public/brand` 中的副本。
