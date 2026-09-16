import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createCipheriv, createDecipheriv } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { type Algorithm, hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { loadEnv } from '../../config/env';

/**
 * Argon2id。@node-rs/argon2 把 Algorithm 声明为 ambient const enum,
 * 在 isolatedModules 下无法按值引用,因此这里用其数值(Argon2d=0 / Argon2i=1 / Argon2id=2)。
 * Argon2id 同时抵抗 GPU 破解与侧信道,是密码哈希的推荐算法。
 */
const ARGON2ID = 2 as Algorithm;

export interface SealedSecret {
  cipher: string;
  iv: string;
  tag: string;
  keyVersion: number;
}

/** 密钥用途。两类密钥物理分离,泄漏其一不影响另一类。 */
export type SecretPurpose = 'credential' | 'provider';

/**
 * 密码与密钥服务。
 *
 * 两套完全不同的机制,不可混用:
 *  1. 平台登录密码 —— Argon2id 单向哈希,永不可逆。
 *  2. 店铺账号密码 / 供应商 API Key —— AES-256-GCM 认证加密,需要取回明文。
 *     密钥来自环境变量(生产建议由密钥管理服务注入),支持版本化轮换。
 *
 * 加密时绑定 AAD(附加认证数据),把密文与它所属的记录绑定,
 * 这样即使有人把 A 记录的密文复制到 B 记录,解密也会失败。
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly env = loadEnv();

  /** 当前密钥版本。轮换时把新密钥放到 *_ENCRYPTION_KEY,旧密钥追加到 *_ENCRYPTION_KEY_OLD */
  private readonly currentKeyVersion = 1;

  // ---------------------------------------------------------------------------
  // 登录密码:Argon2id
  // ---------------------------------------------------------------------------

  async hashPassword(plain: string): Promise<string> {
    return argonHash(plain, {
      algorithm: ARGON2ID,
      memoryCost: this.env.PASSWORD_HASH_MEMORY_KIB,
      timeCost: this.env.PASSWORD_HASH_ITERATIONS,
      parallelism: this.env.PASSWORD_HASH_PARALLELISM,
    });
  }

  /**
   * 校验密码。任何异常都返回 false,不向上抛出——
   * 避免通过错误类型区分"哈希格式损坏"与"密码错误"。
   */
  async verifyPassword(hashed: string, plain: string): Promise<boolean> {
    try {
      return await argonVerify(hashed, plain);
    } catch (err) {
      this.logger.warn(`密码校验异常(已按失败处理):${(err as Error).message}`);
      return false;
    }
  }

  /**
   * 登录失败时也执行一次等价开销的哈希运算,抹平"用户不存在"与"密码错误"的响应时间差,
   * 避免通过计时差异枚举已注册邮箱。
   */
  async dummyPasswordWork(): Promise<void> {
    await this.hashPassword(randomBytes(16).toString('hex'));
  }

  // ---------------------------------------------------------------------------
  // 可逆加密:AES-256-GCM
  // ---------------------------------------------------------------------------

  private keysFor(purpose: SecretPurpose): { current: Buffer; all: Buffer[] } {
    const primary =
      purpose === 'credential' ? this.env.CREDENTIAL_ENCRYPTION_KEY : this.env.PROVIDER_SECRET_ENCRYPTION_KEY;
    const current = Buffer.from(primary, 'base64');
    const olds = purpose === 'credential' ? this.env.CREDENTIAL_ENCRYPTION_KEY_OLD : [];
    const all = [current, ...olds.map((k) => Buffer.from(k, 'base64')).filter((b) => b.length === 32)];
    return { current, all };
  }

  /**
   * 加密。aad 用于绑定归属,建议传入 `${purpose}:${recordId}` 之类的稳定标识。
   */
  seal(plain: string, purpose: SecretPurpose, aad: string): SealedSecret {
    const { current } = this.keysFor(purpose);
    // GCM 推荐 96 位 IV
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', current, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return {
      cipher: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      keyVersion: this.currentKeyVersion,
    };
  }

  /**
   * 解密。会依次尝试当前密钥与历史密钥,支持平滑轮换。
   * 解密失败抛出通用错误,错误信息中不含任何密文或密钥片段。
   */
  open(sealed: SealedSecret, purpose: SecretPurpose, aad: string): string {
    const { all } = this.keysFor(purpose);
    const iv = Buffer.from(sealed.iv, 'base64');
    const tag = Buffer.from(sealed.tag, 'base64');
    const data = Buffer.from(sealed.cipher, 'base64');

    for (const key of all) {
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

  /** 判断某条密文是否需要用新密钥重新加密(轮换后的迁移判断) */
  needsRewrap(keyVersion: number): boolean {
    return keyVersion !== this.currentKeyVersion;
  }

  // ---------------------------------------------------------------------------
  // 令牌与摘要
  // ---------------------------------------------------------------------------

  /** 生成高熵随机令牌(会话、重验令牌、CSRF) */
  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** 会话令牌只以 sha256 摘要入库,数据库泄漏也无法直接冒用会话 */
  sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  /** 文件内容哈希(用于同用户去重) */
  sha256Buffer(buf: Buffer | Uint8Array): string {
    return createHash('sha256').update(buf).digest('hex');
  }

  /** CSRF 令牌:HMAC 绑定会话,避免攻击者自行构造 */
  signCsrfToken(sessionToken: string): string {
    const nonce = randomBytes(16).toString('base64url');
    const mac = createHmac('sha256', this.env.CSRF_SECRET)
      .update(`${nonce}.${this.sha256(sessionToken)}`)
      .digest('base64url');
    return `${nonce}.${mac}`;
  }

  verifyCsrfToken(token: string, sessionToken: string): boolean {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [nonce, mac] = parts as [string, string];
    const expected = createHmac('sha256', this.env.CSRF_SECRET)
      .update(`${nonce}.${this.sha256(sessionToken)}`)
      .digest('base64url');
    return this.constantTimeEquals(mac, expected);
  }

  /** 定时安全比较,防止通过响应时间侧信道推断令牌 */
  constantTimeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  /** 微信 JS-SDK 签名用的 sha1 */
  sha1(value: string): string {
    return createHash('sha1').update(value, 'utf8').digest('hex');
  }
}
