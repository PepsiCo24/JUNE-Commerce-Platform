import { Injectable, Logger } from '@nestjs/common';
import { PostStatus } from '@june/db';
import {
  htmlToExcerpt,
  type ShareCapabilities,
  type ShareMeta,
  type ShareResponse,
} from '@june/shared';
import { toString as qrcodeToString } from 'qrcode';

import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app-exception';
import { loadEnv } from '../../config/env';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { AssetUrlService } from '../assets/asset-url.service';
import { buildPostPublicUrl } from './community.util';

/** 分享配置在 SystemConfig 中的键(由管理站 /admin/share 维护) */
const SHARE_WECHAT_KEY = 'share.wechat';
const SHARE_QQ_KEY = 'share.qq';

/** 微信凭据缓存 7000 秒:官方有效期 7200 秒,留出 200 秒余量避免边界失效 */
const WECHAT_CACHE_TTL_SECONDS = 7000;
/** 调用微信接口的超时,超时即降级,不拖垮分享接口 */
const WECHAT_TIMEOUT_MS = 8000;

const WECHAT_JS_API_LIST = [
  'updateAppMessageShareData',
  'updateTimelineShareData',
  'onMenuShareAppMessage',
  'onMenuShareTimeline',
];

const QQ_SHARE_ENDPOINT = 'https://connect.qq.com/widget/shareqq/index.html';

interface WechatShareConfig {
  appId: string;
  /** 只在服务端内存中短暂存在,绝不缓存到 Redis、绝不下发前端、绝不写日志 */
  appSecret: string;
}

/**
 * 帖子分享。
 *
 * 原则:**不伪造可用性**。渠道没配置、或上游调用失败时,如实返回
 * `available: false` + 原因 + 降级方式(二维码/复制链接),
 * 前端据此隐藏对应按钮,而不是让用户点了之后静默失败。
 */
@Injectable()
export class ShareService {
  private readonly logger = new Logger(ShareService.name);
  private readonly env = loadEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly urls: AssetUrlService,
  ) {}

  /**
   * 生成某篇帖子的分享信息。
   * 草稿、被隐藏、已删除的帖子一律拒绝——分享接口是公开的,
   * 不能成为绕过可见性限制读取内容摘要的后门。
   */
  async getShare(slug: string): Promise<ShareResponse> {
    const post = await this.prisma.db.post.findFirst({
      where: { slug, status: PostStatus.PUBLISHED, deletedAt: null },
      select: {
        id: true,
        slug: true,
        title: true,
        excerpt: true,
        contentHtml: true,
        coverAsset: {
          select: { objectKey: true, visibility: true, derivatives: true },
        },
      },
    });
    if (!post) throw AppException.notFound();

    const url = buildPostPublicUrl(this.env.PUBLIC_WEB_ORIGIN, post.slug);
    const meta: ShareMeta = {
      url,
      title: post.title,
      description: post.excerpt ?? htmlToExcerpt(post.contentHtml, 120),
      imageUrl: post.coverAsset ? await this.urls.previewUrl(post.coverAsset) : null,
    };

    const [qrcodeSvg, wechat, qq] = await Promise.all([
      this.renderQrcode(url),
      this.buildWechatCapability(url),
      this.buildQqCapability(meta),
    ]);

    const capabilities: ShareCapabilities = {
      link: { available: true },
      qrcode: { available: true },
      wechat,
      qq,
    };

    return { meta, capabilities, qrcodeSvg };
  }

  // ---------------------------------------------------------------------------
  // 二维码
  // ---------------------------------------------------------------------------

  private async renderQrcode(url: string): Promise<string> {
    // 在后端生成 SVG,前端不需要再引入二维码库,也避免不同端渲染结果不一致
    return qrcodeToString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  }

  // ---------------------------------------------------------------------------
  // 微信:JS-SDK 签名
  // ---------------------------------------------------------------------------

  private async buildWechatCapability(url: string): Promise<ShareCapabilities['wechat']> {
    const config = await this.loadWechatConfig();
    if (!config) {
      return { available: false, reason: '微信分享尚未配置', fallback: 'qrcode' };
    }

    const ticket = await this.getJsapiTicket(config);
    if (!ticket) {
      return { available: false, reason: '微信分享服务暂时不可用,请使用二维码', fallback: 'qrcode' };
    }

    const nonceStr = this.crypto.randomToken(12).replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // 参与签名的 url 不包含 # 及其后面的部分
    const signUrl = url.split('#')[0] ?? url;

    // 四个参数按 key 的字典序拼接后做 sha1
    const raw = Object.entries({
      jsapi_ticket: ticket,
      noncestr: nonceStr,
      timestamp,
      url: signUrl,
    })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    return {
      available: true,
      mode: 'jssdk',
      // 只下发 appId 与签名,appSecret 永远留在服务端
      signature: {
        appId: config.appId,
        timestamp,
        nonceStr,
        signature: this.crypto.sha1(raw),
        jsApiList: [...WECHAT_JS_API_LIST],
      },
    };
  }

  /** 读取并解密微信分享配置。任何一环缺失都视为"未配置",不做任何猜测。 */
  private async loadWechatConfig(): Promise<WechatShareConfig | null> {
    const row = await this.prisma.db.systemConfig.findUnique({ where: { key: SHARE_WECHAT_KEY } });
    if (!row) return null;

    const value = this.readConfigObject(row.value);
    const enabled = value.enabled === true;
    const appId = typeof value.appId === 'string' ? value.appId.trim() : '';
    if (!enabled || !appId) return null;

    if (!row.isSecret || !row.valueCipher || !row.valueIv || !row.valueTag) return null;

    try {
      const appSecret = this.crypto.open(
        {
          cipher: row.valueCipher,
          iv: row.valueIv,
          tag: row.valueTag,
          keyVersion: row.keyVersion,
        },
        'provider',
        `systemConfig:${row.key}`,
      );
      if (!appSecret) return null;
      return { appId, appSecret };
    } catch {
      // 不打印任何密文片段
      this.logger.warn('微信分享密钥解密失败,分享能力按"未配置"降级');
      return null;
    }
  }

  /**
   * jsapi_ticket。
   * access_token 与 ticket 都有调用次数限制,两者都必须缓存(各 7000 秒),
   * 不能每次分享都去换一次。
   */
  private async getJsapiTicket(config: WechatShareConfig): Promise<string | null> {
    const cacheKey = `community:wechat:jsapi_ticket:${config.appId}`;
    const cached = await this.redis.getJson<{ ticket: string }>(cacheKey);
    if (cached?.ticket) return cached.ticket;

    const accessToken = await this.getAccessToken(config);
    if (!accessToken) return null;

    const data = await this.requestWechat<{ ticket?: string; errcode?: number }>(
      `https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${encodeURIComponent(accessToken)}&type=jsapi`,
      'jsapi_ticket',
    );
    if (!data?.ticket) {
      this.logger.warn(`微信 jsapi_ticket 获取失败(errcode=${data?.errcode ?? 'unknown'}),分享降级为二维码`);
      return null;
    }

    await this.redis.setJson(cacheKey, { ticket: data.ticket }, WECHAT_CACHE_TTL_SECONDS);
    return data.ticket;
  }

  private async getAccessToken(config: WechatShareConfig): Promise<string | null> {
    const cacheKey = `community:wechat:access_token:${config.appId}`;
    const cached = await this.redis.getJson<{ token: string }>(cacheKey);
    if (cached?.token) return cached.token;

    const data = await this.requestWechat<{ access_token?: string; errcode?: number }>(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(
        config.appId,
      )}&secret=${encodeURIComponent(config.appSecret)}`,
      'access_token',
    );
    if (!data?.access_token) {
      this.logger.warn(`微信 access_token 获取失败(errcode=${data?.errcode ?? 'unknown'}),分享降级为二维码`);
      return null;
    }

    await this.redis.setJson(cacheKey, { token: data.access_token }, WECHAT_CACHE_TTL_SECONDS);
    return data.access_token;
  }

  /**
   * 调用微信接口。失败一律返回 null 由上层降级,不向调用方抛 500——
   * 分享面板不该因为第三方抖动而整体不可用。
   * 日志里只写用途标识,**绝不打印请求 URL**(其中包含 appSecret)。
   */
  private async requestWechat<T>(url: string, label: string): Promise<T | null> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(WECHAT_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        this.logger.warn(`微信接口 ${label} 返回 HTTP ${response.status}`);
        return null;
      }
      return (await response.json()) as T;
    } catch (err) {
      this.logger.warn(`微信接口 ${label} 调用失败:${(err as Error).message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // QQ:官方网页分享
  // ---------------------------------------------------------------------------

  private async buildQqCapability(meta: ShareMeta): Promise<ShareCapabilities['qq']> {
    const row = await this.prisma.db.systemConfig.findUnique({ where: { key: SHARE_QQ_KEY } });
    const value = this.readConfigObject(row?.value ?? null);
    const enabled = value.enabled === true;
    const appId = typeof value.appId === 'string' ? value.appId.trim() : '';

    if (!enabled || !appId) {
      return { available: false, reason: 'QQ 分享尚未配置', fallback: 'qrcode' };
    }

    const params = [
      ['url', meta.url],
      ['title', meta.title],
      ['desc', meta.description],
      ['summary', meta.description],
      ['pics', meta.imageUrl ?? ''],
      ['site', this.env.PUBLIC_WEB_ORIGIN],
    ]
      .filter(([, value]) => Boolean(value))
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join('&');

    return { available: true, shareUrl: `${QQ_SHARE_ENDPOINT}?${params}` };
  }

  // ---------------------------------------------------------------------------

  /** SystemConfig.value 是任意 JSON,这里只接受对象形态,其余按空配置处理 */
  private readConfigObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  }
}
