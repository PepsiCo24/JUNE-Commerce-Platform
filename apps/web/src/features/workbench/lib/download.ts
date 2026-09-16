/**
 * 下载工具。
 *
 * 批量下载的实现选择(重要):
 *   后端 /generation/tasks/:id/download-batch 只返回短时签名地址,
 *   前端**逐个触发浏览器下载**,不把原图 fetch 成 Blob 再在内存里拼 zip。
 *   一次批量最多 8 张 4K 图,拼 zip 会瞬时占用上百 MB 内存并卡死主线程,
 *   而浏览器原生下载是流式的、可断点的,也不占页面内存。
 */

/** 触发一次浏览器下载。同源资源用 download 属性,跨域签名地址交给浏览器按响应头处理。 */
export function triggerDownload(url: string, fileName?: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  if (fileName) anchor.download = fileName;
  anchor.rel = 'noopener';
  // 不加 target=_blank:带 download 时新标签页会被立刻关闭,部分浏览器会丢掉下载
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

/**
 * 逐个触发下载。相邻两次之间留间隔,避免浏览器把连续点击判定为弹窗滥用而拦截。
 */
export async function downloadSequentially(
  items: Array<{ url: string; fileName?: string }>,
  gapMs = 350,
): Promise<void> {
  for (const [index, item] of items.entries()) {
    triggerDownload(item.url, item.fileName);
    if (index < items.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
  }
}

/** 把前端生成的文本内容(CSV 模板、错误报告)下载为文件 */
export function downloadTextFile(content: string, fileName: string, mimeType = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    triggerDownload(url, fileName);
  } finally {
    // 交给浏览器开始下载后再回收,立即 revoke 会导致下载失败
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
