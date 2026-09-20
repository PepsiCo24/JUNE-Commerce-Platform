import Script from 'next/script';

/**
 * 首屏主题初始化脚本,在 React hydration 前写入 data-theme,避免夜间模式闪白。
 * 必须使用 next/script 的 beforeInteractive,不能在组件里直接渲染 <script>。
 */
export const THEME_INIT_SCRIPT = `
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

export function ThemeScript(): React.JSX.Element {
  return (
    <Script id="june-theme-init" strategy="beforeInteractive">
      {THEME_INIT_SCRIPT}
    </Script>
  );
}
