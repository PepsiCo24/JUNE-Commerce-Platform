import { describe, expect, it } from 'vitest';

import {
  assertSafeProviderUrl,
  isBlockedHostname,
  isPrivateOrReservedAddress,
  type ProviderUrlPolicy,
} from './provider-url.validator';

/**
 * SSRF 防护单测。
 *
 * 这里不依赖真实 DNS:解析器通过 policy 注入,
 * 这样每个网段都能被确定性地覆盖,CI 里也不会因为网络波动而抖动。
 */

const policy = (addresses: string[], overrides: Partial<ProviderUrlPolicy> = {}): Partial<ProviderUrlPolicy> => ({
  allowPrivateNetwork: false,
  requireHttps: false,
  resolveHost: async () => addresses,
  ...overrides,
});

describe('isPrivateOrReservedAddress', () => {
  const blocked = [
    ['0.0.0.0/8', '0.0.0.0'],
    ['回环 127/8', '127.0.0.1'],
    ['回环 127/8 非 .1', '127.9.9.9'],
    ['私网 10/8', '10.0.0.1'],
    ['私网 172.16/12 下界', '172.16.0.1'],
    ['私网 172.16/12 上界', '172.31.255.254'],
    ['私网 192.168/16', '192.168.1.1'],
    ['链路本地 169.254/16', '169.254.1.1'],
    ['云元数据 169.254.169.254', '169.254.169.254'],
    ['运营商 NAT 100.64/10', '100.64.0.1'],
    ['运营商 NAT 100.64/10 上界', '100.127.255.255'],
    ['组播 224/4', '224.0.0.1'],
    ['保留 240/4', '240.0.0.1'],
    ['广播', '255.255.255.255'],
    ['IPv6 回环', '::1'],
    ['IPv6 未指定', '::'],
    ['唯一本地 fc00::/7', 'fc00::1'],
    ['唯一本地 fd00', 'fd12:3456:789a::1'],
    ['链路本地 fe80::/10', 'fe80::1'],
    ['IPv6 组播', 'ff02::1'],
    ['IPv4-mapped 回环', '::ffff:127.0.0.1'],
    ['IPv4-mapped 私网', '::ffff:10.1.2.3'],
    ['IPv4-mapped 元数据', '::ffff:169.254.169.254'],
    ['IPv4-compatible 回环', '::127.0.0.1'],
    ['NAT64', '64:ff9b::1'],
  ] as const;

  for (const [label, address] of blocked) {
    it(`拒绝 ${label}(${address})`, () => {
      expect(isPrivateOrReservedAddress(address)).toBe(true);
    });
  }

  const allowed = [
    ['公网 IPv4', '8.8.8.8'],
    ['公网 IPv4(172.32 已在 /12 之外)', '172.32.0.1'],
    ['公网 IPv4(100.63 在 /10 之外)', '100.63.255.255'],
    ['公网 IPv4(11/8)', '11.0.0.1'],
    ['公网 IPv6', '2001:4860:4860::8888'],
    ['IPv4-mapped 公网', '::ffff:8.8.8.8'],
  ] as const;

  for (const [label, address] of allowed) {
    it(`放行 ${label}(${address})`, () => {
      expect(isPrivateOrReservedAddress(address)).toBe(false);
    });
  }

  it('无法解析的地址按不安全处理', () => {
    expect(isPrivateOrReservedAddress('not-an-ip')).toBe(true);
    expect(isPrivateOrReservedAddress('999.1.1.1')).toBe(true);
  });
});

describe('isBlockedHostname', () => {
  for (const host of [
    'localhost',
    'LOCALHOST',
    'api.localhost',
    'service.internal',
    'metadata.google.internal',
    'printer.local',
    'box.localdomain',
  ]) {
    it(`拒绝主机名 ${host}`, () => {
      expect(isBlockedHostname(host)).toBe(true);
    });
  }

  it('放行普通公网域名', () => {
    expect(isBlockedHostname('api.openai.com')).toBe(false);
    expect(isBlockedHostname('ark.cn-beijing.volces.com')).toBe(false);
  });
});

describe('assertSafeProviderUrl', () => {
  it('放行解析到公网地址的 https 域名', async () => {
    const url = await assertSafeProviderUrl('https://api.example.com/v1', policy(['93.184.216.34']));
    expect(url.hostname).toBe('api.example.com');
  });

  it('拒绝非 http(s) 协议', async () => {
    await expect(assertSafeProviderUrl('file:///etc/passwd', policy([]))).rejects.toMatchObject({
      code: 'PROVIDER_URL_NOT_ALLOWED',
    });
    await expect(assertSafeProviderUrl('gopher://example.com', policy([]))).rejects.toMatchObject({
      code: 'PROVIDER_URL_NOT_ALLOWED',
    });
  });

  it('生产环境拒绝 http', async () => {
    await expect(
      assertSafeProviderUrl('http://api.example.com', policy(['93.184.216.34'], { requireHttps: true })),
    ).rejects.toMatchObject({ code: 'PROVIDER_URL_NOT_ALLOWED' });
  });

  it('拒绝 localhost', async () => {
    await expect(assertSafeProviderUrl('http://localhost:8080', policy([]))).rejects.toMatchObject({
      code: 'PROVIDER_URL_NOT_ALLOWED',
    });
  });

  it('拒绝 IP 字面量形式的内网地址(不经过 DNS)', async () => {
    for (const raw of [
      'http://127.0.0.1:9000',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5',
      'http://192.168.0.1',
      'http://[::1]:3000',
      'http://[fd00::1]',
    ]) {
      await expect(assertSafeProviderUrl(raw, policy([]))).rejects.toMatchObject({
        code: 'PROVIDER_URL_NOT_ALLOWED',
      });
    }
  });

  it('拒绝解析到内网的公网域名(DNS rebinding 场景)', async () => {
    await expect(
      assertSafeProviderUrl('https://evil.example.com', policy(['127.0.0.1'])),
    ).rejects.toMatchObject({ code: 'PROVIDER_URL_NOT_ALLOWED' });
  });

  it('多条 A 记录中只要有一条落在内网就拒绝', async () => {
    await expect(
      assertSafeProviderUrl('https://mixed.example.com', policy(['93.184.216.34', '10.1.2.3'])),
    ).rejects.toMatchObject({ code: 'PROVIDER_URL_NOT_ALLOWED' });
  });

  it('拒绝携带账号密码的地址', async () => {
    await expect(
      assertSafeProviderUrl('https://user:pass@api.example.com', policy(['93.184.216.34'])),
    ).rejects.toMatchObject({ code: 'PROVIDER_URL_NOT_ALLOWED' });
  });

  it('拒绝明显不属于 HTTP API 的端口', async () => {
    await expect(
      assertSafeProviderUrl('https://api.example.com:6379', policy(['93.184.216.34'])),
    ).rejects.toMatchObject({ code: 'PROVIDER_URL_NOT_ALLOWED' });
  });

  it('解析失败时拒绝', async () => {
    await expect(
      assertSafeProviderUrl(
        'https://nowhere.example.com',
        policy([], {
          resolveHost: async () => {
            throw new Error('ENOTFOUND');
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_URL_NOT_ALLOWED' });
  });

  it('开发模式(PROVIDER_URL_ALLOW_PRIVATE_NETWORK=true)放行本地模拟服务', async () => {
    const url = await assertSafeProviderUrl(
      'http://localhost:4010/mock',
      policy([], { allowPrivateNetwork: true }),
    );
    expect(url.port).toBe('4010');
  });
});
