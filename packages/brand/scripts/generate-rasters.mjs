#!/usr/bin/env node
/**
 * JUNE 品牌位图生成脚本:把 assets/icons/ 下的 SVG 栅格化成 PNG 与 favicon.ico。
 *
 * SVG 由 generate-vectors.mjs 从统一品牌组件生成。
 *
 * 用法:
 *   node packages/brand/scripts/generate-rasters.mjs
 *   node packages/brand/scripts/generate-rasters.mjs --out apps/web/public/icons
 *   node packages/brand/scripts/generate-rasters.mjs --dry-run
 *
 * 依赖(都不是本包的必装依赖,按需临时安装):
 *   sharp       —— PNG 栅格化,必需
 *   png-to-ico  —— 合成 favicon.ico,可选;缺失时跳过 ICO 并给出提示
 *
 * 注意:sharp 需要在 pnpm-workspace.yaml 的 allowBuilds 里放行(该仓库已放行)。
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const ICONS_DIR = join(PACKAGE_ROOT, 'assets', 'icons');

/**
 * 每个条目 = 一个源 SVG + 一个目标尺寸。
 * 源文件刻意按尺寸分档(16 / 32 用像素栅格专版,180 / 192 / 512 用完整细节版),
 * 所以这里是「一对一栅格化」而不是「从一张大图缩小」——缩小会把小尺寸专版的
 * 像素对齐优势全部抹掉。
 */
const PNG_TARGETS = [
  { src: 'favicon-16.svg', out: 'favicon-16.png', size: 16, opaque: false },
  { src: 'favicon-32.svg', out: 'favicon-32.png', size: 32, opaque: false },
  // Apple Touch Icon 必须不透明:iOS 会把透明像素合成为黑色。
  { src: 'apple-touch-icon.svg', out: 'apple-touch-icon.png', size: 180, opaque: true },
  { src: 'app-icon-192.svg', out: 'app-icon-192.png', size: 192, opaque: true },
  { src: 'app-icon-512.svg', out: 'app-icon-512.png', size: 512, opaque: true },
];

/** favicon.ico 内嵌的尺寸档。48 由 favicon.svg 现场渲染,不单独落盘 SVG。 */
const ICO_LAYERS = [
  { src: 'favicon-16.svg', size: 16 },
  { src: 'favicon-32.svg', size: 32 },
  { src: 'favicon.svg', size: 48 },
];

/** 深靛蓝 #101426,与 shared/brand.ts 的 BRAND_COLORS.indigo 一致。 */
const OPAQUE_BACKGROUND = { r: 0x10, g: 0x14, b: 0x26, alpha: 1 };

const SHARP_MISSING_HINT = [
  '',
  '  未找到 sharp,已跳过位图生成(这不是代码错误,只是缺少可选依赖)。',
  '',
  '  临时安装后再跑:',
  '    pnpm --filter @june/brand add -D sharp',
  '    node packages/brand/scripts/generate-rasters.mjs',
  '',
  '  或者不落地安装,直接用一次性运行:',
  '    pnpm dlx sharp-cli --help',
  '',
  '  提示:sharp 含原生二进制,需要在 pnpm-workspace.yaml 的 allowBuilds 中放行',
  '  (本仓库已放行 sharp: true)。',
  '',
].join('\n');

function parseArgs(argv) {
  const args = { out: ICONS_DIR, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--out') {
      const next = argv[i + 1];
      if (!next) throw new Error('--out 需要一个目录参数,例如 --out apps/web/public/icons');
      args.out = resolve(process.cwd(), next);
      i += 1;
    } else if (arg.startsWith('--out=')) {
      args.out = resolve(process.cwd(), arg.slice('--out='.length));
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`无法识别的参数:${arg}`);
    }
  }
  return args;
}

/**
 * sharp 默认按 72dpi 把 1 个 SVG 用户单位当成 1 个像素渲染。
 * 直接渲染再 resize 会经历一次多余的重采样,小尺寸图标会发糊,
 * 因此这里按「目标尺寸 / SVG 固有尺寸」抬高 density,让矢量一次性渲染到位。
 */
function intrinsicWidthOf(svgSource, fallback) {
  const viewBox = /viewBox\s*=\s*"([^"]+)"/.exec(svgSource);
  if (viewBox) {
    const parts = viewBox[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length === 4 && Number.isFinite(parts[2]) && parts[2] > 0) return parts[2];
  }
  const width = /\bwidth\s*=\s*"(\d+(?:\.\d+)?)"/.exec(svgSource);
  if (width) return Number(width[1]);
  return fallback;
}

async function loadSharp() {
  try {
    const mod = await import('sharp');
    return mod.default ?? mod;
  } catch (error) {
    if (isModuleNotFound(error, 'sharp')) {
      // Reuse Next.js's installed image runtime in the application workspace.
      try {
        const webRequire = createRequire(resolve(PACKAGE_ROOT, '../../apps/web/package.json'));
        const nextRequire = createRequire(webRequire.resolve('next/package.json'));
        return nextRequire('sharp');
      } catch {
        return null;
      }
    }
    // sharp 装了但原生二进制加载失败(常见于跨平台复制 node_modules):
    // 这属于环境问题,同样给出可读提示而不是抛栈。
    console.error('\n  sharp 已安装但加载失败,原始错误:');
    console.error(`    ${error && error.message ? error.message : String(error)}`);
    console.error('  多为原生二进制与当前平台/Node 版本不匹配,重装即可:');
    console.error('    pnpm --filter @june/brand rebuild sharp\n');
    return null;
  }
}

async function loadPngToIco() {
  try {
    const mod = await import('png-to-ico');
    return mod.default ?? mod;
  } catch (error) {
    if (isModuleNotFound(error, 'png-to-ico')) return null;
    throw error;
  }
}

function isModuleNotFound(error, specifier) {
  if (!error) return false;
  if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') return true;
  return typeof error.message === 'string' && error.message.includes(`'${specifier}'`);
}

async function renderPng(sharp, svgPath, size, opaque) {
  const source = await readFile(svgPath, 'utf8');
  const intrinsic = intrinsicWidthOf(source, size);
  const density = Math.max(72, Math.round((72 * size) / intrinsic));

  let pipeline = sharp(Buffer.from(source), { density }).resize(size, size, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });

  if (opaque) pipeline = pipeline.flatten({ background: OPAQUE_BACKGROUND });

  return pipeline.png({ compressionLevel: 9, palette: false }).toBuffer();
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      [
        '',
        '  JUNE 品牌位图生成',
        '',
        '    --out <dir>   输出目录(默认 packages/brand/assets/icons)',
        '    --dry-run     只列出将要生成的文件,不写盘',
        '    -h, --help    显示本帮助',
        '',
      ].join('\n'),
    );
    return 0;
  }

  // 先校验源文件齐全,避免渲染到一半才报错。
  const required = [...new Set([...PNG_TARGETS.map((t) => t.src), ...ICO_LAYERS.map((l) => l.src)])];
  const missing = [];
  for (const name of required) {
    if (!(await exists(join(ICONS_DIR, name)))) missing.push(name);
  }
  if (missing.length > 0) {
    console.error(`\n  以下源 SVG 不存在于 ${relative(process.cwd(), ICONS_DIR)}:`);
    for (const name of missing) console.error(`    - ${name}`);
    console.error('');
    return 1;
  }

  if (args.dryRun) {
    console.log(`\n  [dry-run] 输出目录:${args.out}`);
    for (const target of PNG_TARGETS) {
      console.log(`  [dry-run] ${target.src} → ${target.out} (${target.size}×${target.size})`);
    }
    console.log(`  [dry-run] ${ICO_LAYERS.map((l) => l.size).join(' / ')} → favicon.ico\n`);
    return 0;
  }

  const sharp = await loadSharp();
  if (!sharp) {
    console.warn(SHARP_MISSING_HINT);
    // 缺可选依赖不算构建失败:返回 0,让 CI / 上层脚本继续往下走。
    return 0;
  }

  await mkdir(args.out, { recursive: true });

  for (const target of PNG_TARGETS) {
    const buffer = await renderPng(sharp, join(ICONS_DIR, target.src), target.size, target.opaque);
    await writeFile(join(args.out, target.out), buffer);
    console.log(`  ✓ ${target.out.padEnd(24)} ${target.size}×${target.size}`);
  }

  const pngToIco = await loadPngToIco();
  if (pngToIco) {
    const layers = [];
    for (const layer of ICO_LAYERS) {
      layers.push(await renderPng(sharp, join(ICONS_DIR, layer.src), layer.size, false));
    }
    await writeFile(join(args.out, 'favicon.ico'), await pngToIco(layers));
    console.log(`  ✓ ${'favicon.ico'.padEnd(24)} ${ICO_LAYERS.map((l) => l.size).join(' / ')}`);
  } else {
    console.warn(
      [
        '',
        '  未找到 png-to-ico,已跳过 favicon.ico(PNG 均已生成)。',
        '  sharp 本身不支持写 .ico 容器,需要额外的合成库:',
        '    pnpm --filter @june/brand add -D png-to-ico',
        '',
        '  现代浏览器优先读 <link rel="icon" type="image/svg+xml">,',
        '  favicon.ico 只是给旧版浏览器与部分抓取器的兜底,可以晚一步补。',
        '',
      ].join('\n'),
    );
  }

  console.log(`\n  输出目录:${args.out}\n`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    // 兜底:任何未预期的异常都打印成一行可读信息,不往终端糊一整片堆栈。
    console.error(`\n  位图生成失败:${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
