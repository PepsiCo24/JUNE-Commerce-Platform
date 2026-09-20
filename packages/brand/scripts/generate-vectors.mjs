/** Generate static assets from the same geometry and component used by the app. */
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(resolve(root, 'apps/web/package.json'));
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { BrandLogo } = require(resolve(root, 'packages/brand/dist/BrandLogo.js'));
const { JUNE_PATHS } = require(resolve(root, 'packages/brand/dist/geometry.js'));
const { COLOR_SCALES: colors } = require('@june/shared');
const assets = resolve(root, 'packages/brand/assets');
const logo = (props) =>
  renderToStaticMarkup(
    createElement(BrandLogo, {
      title: 'JUNE Commerce Platform',
      ...props,
    }),
  );
const svg = (size, content) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size}" role="img" aria-label="JUNE">${content}</svg>`;
const save = async (name, content) => writeFile(resolve(assets, name), `${content}\n`);

for (const [file, variant, theme] of [
  ['icon', 'icon', 'light'],
  ['icon-simplified', 'icon', 'light'],
  ['icon-mono', 'icon', 'mono'],
  ['lockup-horizontal', 'horizontal', 'light'],
  ['lockup-full', 'full', 'light'],
  ['lockup-full-mono', 'full', 'mono'],
]) {
  await save(`${file}.svg`, logo({ variant, theme, size: variant === 'icon' ? 360 : 272 }));
}
for (const theme of ['dark', 'light']) {
  const bg = theme === 'dark' ? colors.indigo[900] : colors.ivory[50];
  await save(
    `lockup-horizontal-${theme}-bg.svg`,
    svg(
      '1402 432',
      `<path fill="${bg}" d="M0 0H1402V432H0Z"/><g transform="translate(80 80)">${logo({ variant: 'full', theme, size: 272 })}</g>`,
    ),
  );
}
await save(
  'wordmark.svg',
  svg(
    '795 173',
    JUNE_PATHS.map(
      (d, i) => `<path d="${d}" fill="${i === 3 ? colors.teal[400] : colors.indigo[900]}"/>`,
    ).join(''),
  ),
);

for (const [name, size, rounded] of [
  ['favicon', 64, true],
  ['favicon-16', 16, true],
  ['favicon-32', 32, true],
  ['apple-touch-icon', 180, false],
  ['app-icon-192', 192, false],
  ['app-icon-512', 512, false],
]) {
  const markSize = size * 0.7;
  const inset = size * 0.15;
  await save(
    `icons/${name}.svg`,
    svg(
      `${size} ${size}`,
      `<rect width="${size}" height="${size}" rx="${rounded ? size * 0.21 : 0}" fill="${colors.indigo[900]}"/><g transform="translate(${inset} ${inset})" color="${colors.ivory[50]}">${logo({ variant: 'icon', theme: 'mono', size: markSize })}</g>`,
    ),
  );
}
console.log('Generated JUNE vector assets from BrandLogo.');
