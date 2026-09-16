/**
 * 把 @june/brand 的矢量资产同步到 apps/web/public/brand。
 *
 * 为什么需要这一步:
 *   品牌资产的唯一来源是 packages/brand/assets(便于统一校准),
 *   但 Next.js 的静态文件必须位于 apps/web/public 下。
 *   因此在 dev / build 前复制一份,而不是在两处各维护一套(会漂移)。
 *
 * 由 apps/web 的 predev / prebuild 自动执行,无需手动调用。
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../packages/brand/assets');
const target = resolve(here, '../public/brand');

if (!existsSync(source)) {
  console.error(`[brand] 未找到品牌资产目录:${source}`);
  process.exit(1);
}

// 先清空,避免删掉的资产残留在 public 里
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

console.log(`[brand] 品牌资产已同步到 public/brand`);
