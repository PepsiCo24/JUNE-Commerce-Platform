/**
 * 首屏主题初始化脚本,在 React hydration 前写入 data-theme,避免夜间模式闪白。
 * 读取顺序:按当前用户 id 隔离的 localStorage → 匿名键 → 跟随系统。
 */
export function ThemeScript(): React.JSX.Element {
  const script = `
(function(){
  try {
    var keys = Object.keys(localStorage).filter(function(k){ return k.indexOf('june.prefs.theme') === 0; });
    var pref = null;
    for (var i = keys.length - 1; i >= 0; i--) {
      var v = localStorage.getItem(keys[i]);
      if (v === 'light' || v === 'dark' || v === 'system') { pref = v; break; }
    }
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = pref === 'light' ? 'light' : pref === 'dark' ? 'dark' : (dark ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
  } catch (e) {}
})();
`.trim();

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
