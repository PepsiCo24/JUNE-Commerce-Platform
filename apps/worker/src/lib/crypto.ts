/**
 * 供应商 API Key 解密。
 *
 * **必须与 apps/api/src/common/crypto/crypto.service.ts 的 seal/open 完全一致**,
 * 否则 API 加密写入的密文在 Worker 侧解不出来:
 *  - 算法 aes-256-gcm,authTagLength 16 字节;
 *  - IV 96 位(12 字节),base64 存储;
 *  - AAD 约定为 `provider:${providerId}`(把密文与它所属记录绑定,
 *    这样即使有人把 A 供应商的密文复制到 B 供应商,解密也会失败);
 *  - 密钥来自 PROVIDER_SECRET_ENCRYPTION_KEY(base64 的 32 字节)。
 *
 * Worker 只需要解密(open),不需要加密(seal)——密文只在 /admin 录入时由 API 生成。
 */
import { createDecipheriv } from 'node:crypto';

import { loadEnv } from '../config/env';

export interface SealedSecret {
  cipher: string;
  iv: string;
  tag: string;
  keyVersion?: number;
}

/** 与 API 侧 SecretPurpose 对应。Worker 只用到 provider 这一类密钥。 */
export type SecretPurpose = 'provider';

/** AAD 约定,必须与 API 侧写入时使用的字符串逐字节一致 */
export function providerAad(providerId: string): string {
  return `provider:${providerId}`;
}

function keysFor(_purpose: SecretPurpose): Buffer[] {
  const env = loadEnv();
  const current = Buffer.from(env.PROVIDER_SECRET_ENCRYPTION_KEY, 'base64');
  // 供应商密钥当前不配置轮换旧钥(与 API 侧 keysFor('provider') 行为一致)
  return [current];
}

/**
 * 解密。失败抛出通用错误,错误信息中不含任何密文、密钥或 AAD 片段。
 */
export function open(sealed: SealedSecret, purpose: SecretPurpose, aad: string): string {
  const iv = Buffer.from(sealed.iv, 'base64');
  const tag = Buffer.from(sealed.tag, 'base64');
  const data = Buffer.from(sealed.cipher, 'base64');

  for (const key of keysFor(purpose)) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      // 换下一个密钥继续尝试
    }
  }

  throw new Error('密文解密失败:密钥不匹配或数据已损坏');
}

/**
 * 从 ModelProvider 行读出明文 API Key。
 * 任何字段缺失都视为"未配置凭据",由调用方置 MODEL_CREDENTIAL_MISSING,不去调用上游。
 */
export function openProviderApiKey(provider: {
  id: string;
  apiKeyCipher: string | null;
  apiKeyIv: string | null;
  apiKeyTag: string | null;
}): string | null {
  if (!provider.apiKeyCipher || !provider.apiKeyIv || !provider.apiKeyTag) return null;
  return open(
    { cipher: provider.apiKeyCipher, iv: provider.apiKeyIv, tag: provider.apiKeyTag },
    'provider',
    providerAad(provider.id),
  );
}
