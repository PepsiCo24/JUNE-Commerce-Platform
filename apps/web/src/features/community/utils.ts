import { HOT_SCORE_WEIGHTS, type PostListItem } from '@june/shared';

/**
 * 社区模块的纯函数。
 */

/**
 * 规范化动态路由里的 slug。
 * Next 有时传入已 decode 的中文,有时仍带 % 编码;统一 decode 一次再用于 API 与链接,避免二次编码导致 404。
 */
export function normalizePostSlug(raw: string): string {
  let slug = raw.trim();
  if (!slug) return slug;
  try {
    if (/%[0-9A-Fa-f]{2}/.test(slug)) {
      slug = decodeURIComponent(slug);
    }
  } catch {
    // 保留原值
  }
  return slug;
}

function encodedPostSlug(slug: string): string {
  return encodeURIComponent(normalizePostSlug(slug));
}

/** 帖子稳定公开链接的路径。发布时 slug 固定,之后改标题也不会变。 */
export function postPublicPath(slug: string): string {
  return `/p/${encodedPostSlug(slug)}`;
}

/** 社区内的帖子详情路径 */
export function postDetailPath(slug: string): string {
  return `/community/posts/${encodedPostSlug(slug)}`;
}

export function postEditPath(slug: string): string {
  return `/community/posts/${encodeURIComponent(slug)}/edit`;
}

/** 绝对公开链接。只在浏览器侧调用(需要 location.origin)。 */
export function absolutePublicUrl(slug: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}${postPublicPath(slug)}`;
}

/**
 * 正文是否为空。
 * 与后端 `html-sanitize.ts` 的 isEmptyPostHtml 同口径:有图片就不算空,
 * 否则去掉标签后没有可见字符即为空(TipTap 的空文档是 `<p></p>`)。
 * 这里只用于本地禁用按钮,真正的判定仍在后端。
 */
export function isEmptyPostContent(html: string): boolean {
  if (/<img\b/i.test(html)) return false;
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim().length === 0;
}

/**
 * 热门规则的用户可见说明。
 *
 * 直接由 HOT_SCORE_WEIGHTS 生成,口径与后端 computeHotScore 完全一致——
 * 不写"综合排序"这类无法验证的模糊说法。
 */
export function hotRuleDescription(): string {
  const { like, comment, view, viewCap, recomputeIntervalSeconds } = HOT_SCORE_WEIGHTS;
  const minutes = Math.round(recomputeIntervalSeconds / 60);
  return (
    `热门 = 点赞 ×${like} + 评论 ×${comment} + 浏览量 ×${view}(浏览量按 ${viewCap.toLocaleString('zh-CN')} 封顶,避免刷量主导),` +
    `再随发布时间衰减,越新的内容权重越高;由定时任务每 ${minutes} 分钟重算一次。` +
    '置顶帖不参与热门计算,始终排在最前面。'
  );
}

/** 列表卡片的封面:后端在列表接口返回的 coverUrl 就是 thumb 档,直接喂给 AssetImage */
export function coverAsset(post: PostListItem): {
  id: string;
  url: string;
  thumbUrl: string | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
} | null {
  if (!post.coverUrl) return null;
  return {
    id: `${post.id}-cover`,
    url: post.coverUrl,
    thumbUrl: post.coverUrl,
    previewUrl: post.coverUrl,
    width: post.coverWidth,
    height: post.coverHeight,
  };
}

/** 微信内置浏览器检测。只有在微信里才尝试 JS-SDK,外部浏览器不假装能唤起微信。 */
export function isWechatBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /micromessenger/i.test(navigator.userAgent);
}
