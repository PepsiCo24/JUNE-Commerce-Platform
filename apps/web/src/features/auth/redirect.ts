/**
 * 登录后回跳地址的白名单校验。
 *
 * `?redirect=` 来自 URL,属于完全不可信输入。不校验就直接 `router.replace()` 等于开放重定向:
 * 攻击者可以把 `https://june.example/login?redirect=https://phishing.example/login`
 * 发给用户,用户在真站点登录后被甩到钓鱼站的仿冒页面继续输入密码。
 *
 * 规则(全部满足才放行,否则退回 `/`):
 *  1. 必须以 `/` 开头 —— 排除 `https://evil.com`、`javascript:` 这类绝对地址与伪协议;
 *  2. 不能以 `//` 或 `/\` 开头 —— 浏览器会把 `//evil.com` 当作协议相对的**跨站**地址;
 *  3. 不含控制字符与换行 —— 防止在拼接场景下注入;
 *  4. 不落在认证页自身 —— 否则登录成功又被送回登录页,形成死循环。
 */

const FALLBACK = '/';

/** 回跳到这些路径没有意义,一律改回首页 */
const DISALLOWED_TARGETS = ['/login', '/register', '/admin/login'];

export function sanitizeRedirect(value: string | null | undefined, fallback: string = FALLBACK): string {
  if (!value) return fallback;

  // 处理被多次编码 / 带空白的情况
  const raw = value.trim();
  if (raw.length === 0 || raw.length > 512) return fallback;

  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  // eslint-disable-next-line no-control-regex -- 显式拦截控制字符
  if (/[\u0000-\u001F\u007F]/.test(raw)) return fallback;

  const pathOnly = raw.split(/[?#]/)[0] ?? '';
  if (DISALLOWED_TARGETS.includes(pathOnly)) return fallback;

  return raw;
}
