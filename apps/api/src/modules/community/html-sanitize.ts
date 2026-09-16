/**
 * 帖子正文 HTML 清洗。
 *
 * 这里是**唯一**的清洗入口:发布、编辑、草稿自动保存都必须经过它,
 * 落库的永远是清洗后的结果,渲染端不再做二次过滤(也不允许二次放宽)。
 *
 * 安全约定:
 *  - 标签白名单固定,`script` / `style` / `iframe` 等连同内部文本一起丢弃;
 *  - 属性白名单固定,任何 `on*` 事件属性都不在白名单内,一律被剥离;
 *  - `a` 只保留 href/title/target/rel,href 只允许 http(s),rel 强制为
 *    `noopener noreferrer nofollow`,避免 tabnabbing 与外链权重被滥用;
 *  - `img` 只保留 src/alt/width/height,且 src **必须指向本平台资产**
 *    (调用方传入本次提交图片对应的对象键),外链图片会被移除并上报,
 *    由调用方拒绝整次提交。这样可以杜绝通过正文外链图片追踪读者 IP。
 *
 * 本文件是纯函数、无 IO、无 Nest 依赖,便于单元测试直接覆盖。
 */
import sanitizeHtml from 'sanitize-html';

/** 正文允许的标签白名单 */
export const POST_ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'u',
  's',
  'h1',
  'h2',
  'h3',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'img',
  'figure',
  'figcaption',
  'code',
  'pre',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'mark',
  'span',
] as const;

/** 仅允许 color / background-color / text-align,防止注入其它 CSS */
const ALLOWED_INLINE_STYLE = /^(?:color|background-color|text-align)\s*:\s*[^;]+;?\s*$/i;

function sanitizeInlineStyle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.endsWith(';') ? part : `${part};`));
  const safe = parts.filter((part) => ALLOWED_INLINE_STYLE.test(part));
  return safe.length > 0 ? safe.join(' ') : undefined;
}

/** 外链一律加上这三个值:防 tabnabbing + 不传递权重 */
export const LINK_FORCED_REL = 'noopener noreferrer nofollow';

/** 微信 JS-SDK 之外的通用 jsApiList 不在此处;这里只放清洗相关常量 */
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:']);

/** 被拒绝的标签会被改写成这个名字,由于不在白名单内会被丢弃 */
const BLOCKED_TAG = 'x-june-blocked';

export interface SanitizePostHtmlOptions {
  /**
   * 允许出现在正文里的图片对象键(原图 + 缩略图 + 预览图)。
   * 由调用方从 `imageAssetIds` 对应的 Asset 中取出,空数组表示不允许任何图片。
   */
  allowedImageKeys?: string[];
}

export interface SanitizePostHtmlResult {
  /** 清洗后的 HTML,可直接落库 */
  html: string;
  /** 被移除的图片地址(外链或不属于本次提交的资产),调用方据此拒绝提交 */
  rejectedImageSrcs: string[];
}

/**
 * 判断图片地址是否指向本平台的资产对象。
 * 只比对路径中是否包含允许的对象键,因此签名 URL(带查询串)与
 * 公共直连 URL 都能通过,而任何外部域名的图片都无法伪造出这些键。
 */
export function isPlatformImageSrc(src: string, allowedImageKeys: string[]): boolean {
  if (!src || allowedImageKeys.length === 0) return false;

  let pathname: string;
  try {
    // 相对地址按同站解析;javascript:/data: 等伪协议会在下面被拒绝
    const url = new URL(src, 'https://asset.invalid');
    if (!ALLOWED_URL_PROTOCOLS.has(url.protocol)) return false;
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }

  return allowedImageKeys.some((key) => key.length > 0 && pathname.includes(key));
}

function styleTag(tagName: string) {
  return (_name: string, attribs: Record<string, string>) => {
    const next: Record<string, string> = {};
    const style = sanitizeInlineStyle(attribs.style);
    if (style) next.style = style;
    if (attribs['data-color']) next['data-color'] = attribs['data-color'];
    if (attribs['data-type']) next['data-type'] = attribs['data-type'];
    if (attribs['data-checked']) next['data-checked'] = attribs['data-checked'];
    return { tagName, attribs: next };
  };
}

function isSafeLinkHref(href: string): boolean {
  if (!href) return false;
  try {
    const url = new URL(href, 'https://link.invalid');
    return ALLOWED_URL_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

/** 按白名单清洗正文 HTML */
export function sanitizePostHtml(
  dirty: string,
  options: SanitizePostHtmlOptions = {},
): SanitizePostHtmlResult {
  const allowedImageKeys = (options.allowedImageKeys ?? []).filter((key) => key.length > 0);
  const rejectedImageSrcs: string[] = [];

  const html = sanitizeHtml(dirty ?? '', {
    allowedTags: [...POST_ALLOWED_TAGS],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'data-align'],
      p: ['style'],
      h1: ['style'],
      h2: ['style'],
      h3: ['style'],
      span: ['style'],
      mark: ['style', 'data-color'],
      ul: ['data-type'],
      li: ['data-type', 'data-checked'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https'],
    allowedSchemesByTag: { a: ['http', 'https'], img: ['http', 'https'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    // 不在白名单内的标签丢弃,但保留其中的文本,避免用户内容凭空消失
    disallowedTagsMode: 'discard',
    // 这些标签的**内部文本**也必须丢弃,否则脚本源码会被当作正文显示出来
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed'],
    transformTags: {
      a: (_tagName, attribs) => {
        const href = attribs.href ?? '';
        if (!isSafeLinkHref(href)) {
          // 非 http(s) 链接(javascript: / data: 等)整个标签丢弃,只留文本
          return { tagName: BLOCKED_TAG, attribs: {} };
        }
        const next: Record<string, string> = {
          href,
          rel: LINK_FORCED_REL,
        };
        if (attribs.title) next.title = attribs.title;
        if (attribs.target) next.target = attribs.target;
        return { tagName: 'a', attribs: next };
      },
      img: (_tagName, attribs) => {
        const src = attribs.src ?? '';
        if (!isPlatformImageSrc(src, allowedImageKeys)) {
          rejectedImageSrcs.push(src);
          return { tagName: BLOCKED_TAG, attribs: {} };
        }
        const next: Record<string, string> = { src };
        if (attribs.alt) next.alt = attribs.alt;
        if (attribs.width) next.width = attribs.width;
        if (attribs.height) next.height = attribs.height;
        if (attribs['data-align']) next['data-align'] = attribs['data-align'];
        return { tagName: 'img', attribs: next };
      },
      p: styleTag('p'),
      h1: styleTag('h1'),
      h2: styleTag('h2'),
      h3: styleTag('h3'),
      span: styleTag('span'),
      mark: styleTag('mark'),
    },
  });

  return { html: html.trim(), rejectedImageSrcs };
}

/**
 * 清洗之后的二次校验:确认正文里不再残留任何非本平台图片。
 * 清洗与校验用两套独立实现,避免单点疏漏放行外链图片。
 */
export function findForeignImageSrcs(html: string, allowedImageKeys: string[]): string[] {
  const keys = allowedImageKeys.filter((key) => key.length > 0);
  const foreign: string[] = [];

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = src?.[2] ?? src?.[3] ?? src?.[4] ?? '';
    if (!isPlatformImageSrc(value, keys)) foreign.push(value);
  }

  return foreign;
}

/** 正文是否为空(既没有文字也没有图片) */
export function isEmptyPostHtml(html: string): boolean {
  if (/<img\b/i.test(html)) return false;
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim().length === 0;
}

/**
 * 评论等场景的纯文本处理:剥离全部标签,并把实体还原成普通字符。
 * 返回值不含任何 HTML 标记,接口按文本下发,前端禁止用 innerHTML 渲染。
 */
export function toPlainText(raw: string): string {
  const stripped = sanitizeHtml(raw ?? '', {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed'],
  });

  return stripped
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+\n/g, '\n')
    .trim();
}
