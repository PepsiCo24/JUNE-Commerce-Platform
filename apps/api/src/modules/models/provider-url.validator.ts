import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { ERROR_CODES } from '@june/shared';

import { AppException } from '../../common/errors/app-exception';
import { loadEnv } from '../../config/env';

/**
 * 供应商 API 地址的 SSRF 防护。
 *
 * 管理员填写的 baseUrl 会被服务端直接请求,如果不加限制,
 * 一个能进后台的账号就能把 API 变成内网探测器(读云元数据、打内部服务)。
 * 因此写库前与发起连接测试前都必须过这道校验。
 *
 * 校验顺序:协议 -> 主机名黑名单 -> 端口 -> DNS 解析出的**全部** A/AAAA 地址。
 * 只校验主机名字符串是不够的:攻击者可以把公网域名解析到 127.0.0.1。
 */

/** 允许的协议。生产环境进一步收紧为仅 https。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 明显不属于 HTTP API 的端口。命中直接拒绝,避免把供应商配置当成内网端口扫描器。
 * 这是可选加固项,不构成主要防线(主要防线是地址网段判断)。
 */
const BLOCKED_PORTS = new Set([22, 23, 25, 110, 143, 445, 3306, 3389, 5432, 6379, 9200, 11211, 27017]);

export interface ProviderUrlPolicy {
  /**
   * 跳过私网/保留地址检查。
   *
   * 仅用于本地开发与压测:此时 MOCK 供应商、MinIO、自建模拟服务都跑在
   * localhost 或 Docker 内网地址上,不放开就无法联调。
   * 由环境变量 PROVIDER_URL_ALLOW_PRIVATE_NETWORK=true 打开,
   * **生产环境绝不能开启**,否则 SSRF 防护形同虚设。
   */
  allowPrivateNetwork: boolean;
  /** 只允许 https(生产环境) */
  requireHttps: boolean;
  /** DNS 解析器。可注入,便于单测在不依赖真实 DNS 的情况下覆盖各网段。 */
  resolveHost: (hostname: string) => Promise<string[]>;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/**
 * 合并调用方覆盖项与环境配置。
 * 只有在调用方没有显式给出开关时才读环境变量,这样单测可以完全脱离 .env 运行。
 */
function resolvePolicy(overrides: Partial<ProviderUrlPolicy>): ProviderUrlPolicy {
  let allowPrivateNetwork = overrides.allowPrivateNetwork;
  let requireHttps = overrides.requireHttps;

  if (allowPrivateNetwork === undefined || requireHttps === undefined) {
    const env = loadEnv();
    allowPrivateNetwork ??= env.PROVIDER_URL_ALLOW_PRIVATE_NETWORK;
    requireHttps ??= env.NODE_ENV === 'production';
  }

  return {
    allowPrivateNetwork,
    requireHttps,
    resolveHost: overrides.resolveHost ?? defaultResolveHost,
  };
}

// ---------------------------------------------------------------------------
// 地址判定
// ---------------------------------------------------------------------------

type Ipv4Tuple = [number, number, number, number];

function parseIpv4(value: string): Ipv4Tuple | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return [out[0] as number, out[1] as number, out[2] as number, out[3] as number];
}

/** IPv4 私有 / 回环 / 链路本地 / 保留网段 */
function isPrivateIpv4(ip: Ipv4Tuple): boolean {
  const [a, b] = ip;

  if (a === 0) return true; // 0.0.0.0/8 "本网络"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 回环
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 运营商级 NAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地(含 169.254.169.254 云元数据)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF 协议专用 + 192.0.2.0/24 文档用
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试
  if (a === 198 && b === 51) return true; // 198.51.100.0/24 文档用
  if (a === 203 && b === 0) return true; // 203.0.113.0/24 文档用
  if (a >= 224) return true; // 224/4 组播、240/4 保留、255.255.255.255 广播

  return false;
}

/** 把 IPv6 文本展开为 8 组 16 位数值。支持 :: 压缩与内嵌 IPv4。 */
export function parseIpv6(input: string): number[] | null {
  let text = (input.split('%')[0] ?? '').trim();
  if (!text) return null;

  // 内嵌 IPv4(::ffff:1.2.3.4 / ::1.2.3.4 / 64:ff9b::1.2.3.4)
  const trailing: number[] = [];
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':');
    if (cut < 0) return null;
    const v4 = parseIpv4(text.slice(cut + 1));
    if (!v4) return null;
    trailing.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
    text = text.slice(0, cut + 1);
  }

  const wanted = 8 - trailing.length;
  let tokens: string[];

  const doubleColon = text.indexOf('::');
  if (doubleColon >= 0) {
    if (text.indexOf('::', doubleColon + 1) >= 0) return null;
    const head = text.slice(0, doubleColon).split(':').filter((s) => s.length > 0);
    const tail = text.slice(doubleColon + 2).split(':').filter((s) => s.length > 0);
    const missing = wanted - head.length - tail.length;
    if (missing < 0) return null;
    tokens = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  } else {
    tokens = text.split(':').filter((s) => s.length > 0);
    if (tokens.length !== wanted) return null;
  }

  const groups: number[] = [];
  for (const token of tokens) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
    groups.push(Number.parseInt(token, 16));
  }
  groups.push(...trailing);

  return groups.length === 8 ? groups : null;
}

function isPrivateIpv6(groups: number[]): boolean {
  const g = (i: number): number => groups[i] ?? 0;

  const allZeroUpTo = (end: number): boolean => {
    for (let i = 0; i < end; i += 1) {
      if (g(i) !== 0) return false;
    }
    return true;
  };

  // :: (未指定地址) 与 ::1 (回环)
  if (allZeroUpTo(7) && (g(7) === 0 || g(7) === 1)) return true;

  // IPv4-mapped ::ffff:a.b.c.d —— 必须还原成 IPv4 再判,否则是绕过点
  if (allZeroUpTo(5) && g(5) === 0xffff) {
    return isPrivateIpv4(groupsToIpv4(g(6), g(7)));
  }
  // IPv4-compatible ::a.b.c.d(已废弃但仍可被解析)
  if (allZeroUpTo(6) && (g(6) !== 0 || g(7) !== 0)) {
    return isPrivateIpv4(groupsToIpv4(g(6), g(7)));
  }
  // NAT64 64:ff9b::/96
  if (g(0) === 0x0064 && g(1) === 0xff9b && g(2) === 0 && g(3) === 0 && g(4) === 0 && g(5) === 0) {
    return true;
  }
  // 100::/64 丢弃前缀
  if (g(0) === 0x0100 && g(1) === 0 && g(2) === 0 && g(3) === 0) return true;

  if ((g(0) & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地地址
  if ((g(0) & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((g(0) & 0xff00) === 0xff00) return true; // ff00::/8 组播

  return false;
}

function groupsToIpv4(high: number, low: number): Ipv4Tuple {
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

/** 判断单个 IP 字面量是否落在私有 / 保留网段。导出供单测逐网段覆盖。 */
export function isPrivateOrReservedAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '');

  const v4 = parseIpv4(normalized);
  if (v4) return isPrivateIpv4(v4);

  const v6 = parseIpv6(normalized);
  if (v6) return isPrivateIpv6(v6);

  // 解析不了的地址一律按不安全处理(拒绝优于放行)
  return true;
}

/** 主机名黑名单:这些名字无论解析到哪里都不接受 */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (host.endsWith('.localdomain') || host.endsWith('.home.arpa')) return true;
  // 云厂商元数据服务的常见别名
  if (host === 'metadata' || host === 'metadata.google.internal' || host === 'instance-data') return true;
  return false;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

function reject(message: string): never {
  throw AppException.badRequest(ERROR_CODES.PROVIDER_URL_NOT_ALLOWED, message);
}

/**
 * 校验供应商 API 地址是否可以安全访问。不通过时抛 PROVIDER_URL_NOT_ALLOWED。
 *
 * 注意:DNS 结果可能在校验之后、真实请求之前改变(DNS rebinding)。
 * 这里做的是"配置写入期"的防护;真实调用由 Worker 侧适配层承担,
 * 适配层需要在建立连接时再做一次地址检查。
 */
export async function assertSafeProviderUrl(
  rawUrl: string,
  overrides: Partial<ProviderUrlPolicy> = {},
): Promise<URL> {
  const policy = resolvePolicy(overrides);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    reject('API 地址不是合法的 URL');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    reject('API 地址只支持 http 或 https 协议');
  }
  if (policy.requireHttps && url.protocol !== 'https:') {
    reject('生产环境的 API 地址必须使用 https');
  }
  if (url.username || url.password) {
    reject('API 地址中不允许携带账号密码');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) {
    reject('API 地址缺少主机名');
  }
  if (isBlockedHostname(hostname)) {
    if (!policy.allowPrivateNetwork) {
      reject('API 地址不允许指向本机或内网域名');
    }
  }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (BLOCKED_PORTS.has(port)) {
    reject(`API 地址不允许使用 ${port} 端口`);
  }

  if (policy.allowPrivateNetwork) {
    // 开发/压测模式:跳过网段检查,但协议、端口与主机名格式仍然校验
    return url;
  }

  // 主机名本身就是 IP 字面量时直接判定,不必也不能走 DNS
  if (isIP(hostname) !== 0) {
    if (isPrivateOrReservedAddress(hostname)) {
      reject('API 地址指向内网或保留地址,已拒绝');
    }
    return url;
  }

  let addresses: string[];
  try {
    addresses = await policy.resolveHost(hostname);
  } catch {
    reject('无法解析 API 地址的主机名,请检查域名是否正确');
  }

  if (addresses.length === 0) {
    reject('API 地址的主机名没有解析到任何地址');
  }
  // 任意一条记录落在内网即拒绝:攻击者可以让域名同时返回公网与内网地址
  for (const address of addresses) {
    if (isPrivateOrReservedAddress(address)) {
      reject('API 地址解析到内网或保留地址,已拒绝');
    }
  }

  return url;
}
