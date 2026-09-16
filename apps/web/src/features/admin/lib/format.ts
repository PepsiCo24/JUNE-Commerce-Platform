/**
 * 管理站的展示格式化。
 *
 * `@/lib/utils` 已提供 formatDateTime / formatCount / formatPercent 等通用函数;
 * 这里只补管理站特有的格式(字节、毫秒、成功率、图表用的中文日期)。
 * 所有字节量在后端是 BigInt → 字符串,这里用 BigInt 解析,绝不先转 number。
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** 字节数(字符串或数字)转人类可读。输入非法时返回 '—',不猜测数值。 */
export function formatBytes(value: string | number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || value === '') return '—';

  let bytes: number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    bytes = value;
  } else {
    if (!/^-?\d+$/.test(value.trim())) return '—';
    // 超过 Number.MAX_SAFE_INTEGER 的量级在本平台不会出现,但解析仍从 BigInt 起步,
    // 避免字符串被 parseFloat 截断成科学计数法。
    bytes = Number(BigInt(value.trim()));
  }

  if (bytes === 0) return '0 B';
  const negative = bytes < 0;
  let abs = Math.abs(bytes);
  let unitIndex = 0;
  while (abs >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    abs /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? String(Math.round(abs)) : abs.toFixed(digits);
  return `${negative ? '-' : ''}${rounded} ${BYTE_UNITS[unitIndex]}`;
}

/** 把字节字符串安全地转成 number,供图表使用。非法返回 0。 */
export function bytesToNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (!/^-?\d+$/.test(value.trim())) return 0;
  return Number(BigInt(value.trim()));
}

/** GB ↔ 字节字符串互转,用于配额编辑表单 */
export function bytesToGb(value: string | null | undefined): string {
  const bytes = bytesToNumber(value);
  if (bytes === 0) return '0';
  return (bytes / 1024 ** 3).toFixed(2);
}

export function gbToBytes(gb: string): string | null {
  const num = Number(gb);
  if (!Number.isFinite(num) || num < 0) return null;
  return BigInt(Math.round(num * 1024 ** 3)).toString();
}

/** 耗时。毫秒级保持毫秒,秒级以上换算,避免"12000ms"这种难读的数字。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

/** 后端已经把成功率算成 0~100 并保留一位小数,这里只补单位 */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

/** 千分位整数。表格里配合 `tabular` 使用。 */
export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN').format(value);
}

/** 图表坐标轴与 Tooltip 用的中文日期。后端给的是 YYYY-MM-DD 或 ISO。 */
export function formatChartDate(value: string): string {
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

export function formatChartDateFull(value: string): string {
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

/** 角色的中文名。角色判定始终在后端,这里只负责显示。 */
export const ROLE_LABELS: Record<string, string> = {
  user: '普通用户',
  admin: '管理员',
  super_admin: '超级管理员',
};

export function describeRoles(roles: string[]): string {
  if (roles.length === 0) return '—';
  return roles.map((role) => ROLE_LABELS[role] ?? role).join('、');
}
