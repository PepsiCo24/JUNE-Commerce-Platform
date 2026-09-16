import { describe, expect, it } from 'vitest';

import {
  findForeignImageSrcs,
  isEmptyPostHtml,
  LINK_FORCED_REL,
  sanitizePostHtml,
  toPlainText,
} from './html-sanitize';

/** 模拟一次提交里合法的图片对象键(原图 + 预览图) */
const ALLOWED_KEYS = [
  'u/user_1/post_image/202609/abc123.png',
  'u/user_1/post_image/202609/abc123_preview.webp',
];

describe('sanitizePostHtml', () => {
  it('移除 script 标签及其内部代码', () => {
    const { html } = sanitizePostHtml('<p>正文</p><script>alert("xss")</script>');

    expect(html).toBe('<p>正文</p>');
    expect(html).not.toContain('script');
    expect(html).not.toContain('alert');
  });

  it('移除 style / iframe 等非白名单标签', () => {
    const { html } = sanitizePostHtml(
      '<style>body{display:none}</style><iframe src="https://evil.test"></iframe><p>保留</p>',
    );

    expect(html).toBe('<p>保留</p>');
  });

  it('移除 on* 事件属性,保留标签本身', () => {
    const { html } = sanitizePostHtml(
      '<p onclick="steal()" onmouseover="steal()" class="x">点我</p>',
    );

    expect(html).toBe('<p>点我</p>');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onmouseover');
  });

  it('拒绝外链图片:移除标签并上报被拒地址', () => {
    const { html, rejectedImageSrcs } = sanitizePostHtml(
      '<p>看图</p><img src="https://evil.test/tracker.gif" alt="外链">',
      { allowedImageKeys: ALLOWED_KEYS },
    );

    expect(html).not.toContain('<img');
    expect(rejectedImageSrcs).toEqual(['https://evil.test/tracker.gif']);
  });

  it('拒绝 data: 伪协议图片', () => {
    const { html, rejectedImageSrcs } = sanitizePostHtml(
      '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
      { allowedImageKeys: ALLOWED_KEYS },
    );

    expect(html).not.toContain('<img');
    expect(rejectedImageSrcs).toHaveLength(1);
  });

  it('保留本平台资产图片及其宽高属性', () => {
    const { html, rejectedImageSrcs } = sanitizePostHtml(
      '<img src="https://cdn.june.test/u/user_1/post_image/202609/abc123.png?X-Amz-Signature=x" alt="图" width="800" height="600">',
      { allowedImageKeys: ALLOWED_KEYS },
    );

    expect(rejectedImageSrcs).toHaveLength(0);
    expect(html).toContain('<img');
    expect(html).toContain('width="800"');
    expect(html).toContain('height="600"');
  });

  it('未提交任何图片资产时,正文里的图片一律被拒', () => {
    const { rejectedImageSrcs } = sanitizePostHtml(
      '<img src="https://cdn.june.test/u/user_1/post_image/202609/abc123.png">',
    );

    expect(rejectedImageSrcs).toHaveLength(1);
  });

  it('a 标签强制补上 rel,并保留 href/title/target', () => {
    const { html } = sanitizePostHtml(
      '<a href="https://example.test/a" title="说明" target="_blank" onclick="x()">链接</a>',
    );

    expect(html).toContain(`rel="${LINK_FORCED_REL}"`);
    expect(html).toContain('href="https://example.test/a"');
    expect(html).toContain('title="说明"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('onclick');
  });

  it('a 标签已有的弱 rel 会被覆盖为强制值', () => {
    const { html } = sanitizePostHtml('<a href="https://example.test" rel="dofollow">链接</a>');

    expect(html).toContain(`rel="${LINK_FORCED_REL}"`);
    expect(html).not.toContain('dofollow');
  });

  it('javascript: 链接整个标签被丢弃,只保留文本', () => {
    const { html } = sanitizePostHtml('<a href="javascript:alert(1)">危险</a>');

    expect(html).toBe('危险');
    expect(html).not.toContain('javascript');
  });
});

describe('findForeignImageSrcs', () => {
  it('对清洗后的结果再次校验,发现残留外链图片', () => {
    const foreign = findForeignImageSrcs(
      '<p>a</p><img src="https://evil.test/x.png"><img src="/u/user_1/post_image/202609/abc123.png">',
      ALLOWED_KEYS,
    );

    expect(foreign).toEqual(['https://evil.test/x.png']);
  });

  it('全部为本平台图片时返回空数组', () => {
    const foreign = findForeignImageSrcs(
      '<img src="https://cdn.june.test/u/user_1/post_image/202609/abc123_preview.webp">',
      ALLOWED_KEYS,
    );

    expect(foreign).toEqual([]);
  });
});

describe('isEmptyPostHtml / toPlainText', () => {
  it('只有空标签视为空正文,含图片则不为空', () => {
    expect(isEmptyPostHtml('<p></p><p>&nbsp;</p>')).toBe(true);
    expect(isEmptyPostHtml('<p>有内容</p>')).toBe(false);
    expect(isEmptyPostHtml('<img src="https://cdn.june.test/a.png">')).toBe(false);
  });

  it('评论内容被转成纯文本,不保留任何标签', () => {
    expect(toPlainText('<b>加粗</b><script>alert(1)</script>说点什么')).toBe('加粗说点什么');
    expect(toPlainText('<img src="https://evil.test/x.png">')).toBe('');
  });
});
