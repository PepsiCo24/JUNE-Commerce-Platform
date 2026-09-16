'use client';

import type { ShareMeta, WechatJsSdkConfig } from '@june/shared';
import { useQuery } from '@tanstack/react-query';
import { Copy, Link2, MessageCircle, QrCode, Share2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Popover } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/progress';
import { describeError } from '@/lib/api/errors';

import { communityKeys, fetchShare } from '../api';
import { isWechatBrowser } from '../utils';

/**
 * 帖子分享。
 *
 * 渠道可用性以后端 `/community/posts/:slug/share` 为准:
 * 微信只在微信内置浏览器且 JS-SDK 可用时尝试配置分享数据,
 * 否则展示二维码 / 复制链接引导,绝不把"配置成功"说成"已经分享出去"。
 */

interface WxSharePayload {
  title: string;
  desc: string;
  link: string;
  imgUrl: string;
  success?: () => void;
  cancel?: () => void;
  fail?: (res: { errMsg?: string }) => void;
}

interface WxJsSdk {
  config: (config: {
    debug?: boolean;
    appId: string;
    timestamp: number | string;
    nonceStr: string;
    signature: string;
    jsApiList: string[];
  }) => void;
  ready: (cb: () => void) => void;
  error: (cb: (res: { errMsg?: string }) => void) => void;
  updateAppMessageShareData?: (payload: WxSharePayload) => void;
  updateTimelineShareData?: (payload: WxSharePayload) => void;
}

type WindowWithWx = Window & { wx?: WxJsSdk };

function getWx(): WxJsSdk | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as WindowWithWx).wx;
}

function loadWeixinScript(): Promise<WxJsSdk> {
  const existing = getWx();
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const scriptSelector = 'script[data-weixin-jssdk]';
    const already = document.querySelector(scriptSelector);
    if (already) {
      already.addEventListener('load', () => {
        const sdk = getWx();
        if (sdk) resolve(sdk);
        else reject(new Error('微信 JS-SDK 未就绪'));
      });
      already.addEventListener('error', () => reject(new Error('微信 JS-SDK 加载失败')));
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js';
    script.async = true;
    script.dataset.weixinJssdk = 'true';
    script.onload = () => {
      const sdk = getWx();
      if (sdk) resolve(sdk);
      else reject(new Error('微信 JS-SDK 未就绪'));
    };
    script.onerror = () => reject(new Error('微信 JS-SDK 加载失败'));
    document.head.appendChild(script);
  });
}

/** 配置微信分享数据。成功只表示菜单文案已定制,用户仍需点右上角才能发出去。 */
function configureWechatShare(signature: WechatJsSdkConfig, meta: ShareMeta): Promise<void> {
  return loadWeixinScript().then(
    (wx) =>
      new Promise<void>((resolve, reject) => {
        wx.config({
          debug: false,
          appId: signature.appId,
          timestamp: signature.timestamp,
          nonceStr: signature.nonceStr,
          signature: signature.signature,
          jsApiList: signature.jsApiList,
        });
        wx.error((res) => {
          reject(new Error(res.errMsg || '微信 JS-SDK 配置失败'));
        });
        wx.ready(() => {
          const payload: WxSharePayload = {
            title: meta.title,
            desc: meta.description,
            link: meta.url,
            imgUrl: meta.imageUrl ?? '',
          };
          wx.updateAppMessageShareData?.(payload);
          wx.updateTimelineShareData?.(payload);
          resolve();
        });
      }),
  );
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 降级到 execCommand,不把权限失败当成已经复制
  }

  try {
    const input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    input.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(input);
    return ok;
  } catch {
    return false;
  }
}

export function SharePanel({
  slug,
  title,
  compact = false,
}: {
  slug: string;
  title: string;
  compact?: boolean;
}): React.JSX.Element {
  const trigger = compact ? (
    <button
      type="button"
      className="flex items-center gap-1 text-xs text-fg-muted hover:text-accent"
      aria-label={`分享《${title}》`}
    >
      <Share2 size={14} aria-hidden />
      <span className="sr-only sm:not-sr-only sm:inline">分享</span>
    </button>
  ) : (
    <Button variant="outline" size="sm" iconLeft={<Share2 size={16} />} aria-label={`分享《${title}》`}>
      分享
    </Button>
  );

  return (
    <Popover trigger={trigger} align="end" theme="light">
      <SharePanelBody slug={slug} />
    </Popover>
  );
}

function SharePanelBody({ slug }: { slug: string }): React.JSX.Element {
  const [guide, setGuide] = useState<'qrcode' | 'link' | null>(null);

  const query = useQuery({
    queryKey: communityKeys.share(slug),
    queryFn: ({ signal }) => fetchShare(slug, signal),
    staleTime: 60_000,
  });

  if (query.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-fg-muted" role="status">
        <Spinner size={16} />
        正在获取分享信息
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="space-y-2 py-2" role="alert">
        <p className="text-sm text-state-danger-fg">分享信息加载失败</p>
        <p className="text-xs text-fg-muted">{describeError(query.error)}</p>
        <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
          重试
        </Button>
      </div>
    );
  }

  const share = query.data;
  const wechat = share.capabilities.wechat;
  const qq = share.capabilities.qq;

  const copyLink = async (): Promise<void> => {
    const ok = await copyText(share.meta.url);
    if (ok) toast.success('链接已复制');
    else toast.error('复制失败,请手动选择链接');
  };

  const shareWechat = async (): Promise<void> => {
    if (!isWechatBrowser()) {
      setGuide('qrcode');
      toast.info('当前不在微信内,请扫描二维码或复制链接后到微信打开');
      return;
    }
    if (!wechat.available) {
      setGuide(wechat.fallback);
      toast.info(wechat.reason);
      return;
    }
    try {
      await configureWechatShare(wechat.signature, share.meta);
      toast.info('请点击微信右上角菜单,分享给好友或朋友圈');
    } catch (error) {
      setGuide('qrcode');
      toast.error(describeError(error));
    }
  };

  const shareQq = (): void => {
    if (!qq.available) {
      setGuide(qq.fallback);
      toast.info(qq.reason);
      return;
    }
    const popup = window.open(qq.shareUrl, '_blank', 'noopener,noreferrer');
    if (!popup) {
      setGuide('link');
      toast.info('弹窗被拦截,请允许弹窗后重试,或复制链接手动分享');
    }
  };

  const showQr = guide === 'qrcode' || guide === null;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-fg">分享这篇内容</p>
      <p className="text-xs break-all text-fg-muted">{share.meta.url}</p>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" size="sm" iconLeft={<Copy size={14} />} onClick={() => void copyLink()}>
          复制链接
        </Button>
        <Button variant="secondary" size="sm" iconLeft={<QrCode size={14} />} onClick={() => setGuide('qrcode')}>
          二维码
        </Button>
        <Button variant="secondary" size="sm" iconLeft={<MessageCircle size={14} />} onClick={() => void shareWechat()}>
          微信
        </Button>
        <Button variant="secondary" size="sm" iconLeft={<Link2 size={14} />} onClick={shareQq}>
          QQ
        </Button>
      </div>

      {!wechat.available ? (
        <p className="text-xs text-fg-subtle">微信:{wechat.reason}</p>
      ) : !isWechatBrowser() ? (
        <p className="text-xs text-fg-subtle">微信分享仅在微信内置浏览器中可用,可扫码打开。</p>
      ) : null}

      {!qq.available ? <p className="text-xs text-fg-subtle">QQ:{qq.reason}</p> : null}

      {showQr ? <QrcodePreview svg={share.qrcodeSvg} /> : null}
    </div>
  );
}

function QrcodePreview({ svg }: { svg: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 border-t border-border-default pt-3">
      {/* eslint-disable-next-line react/no-danger -- 二维码 SVG 由后端 qrcode 库生成,不含用户输入 */}
      <div
        className="size-40 text-fg [&_svg]:h-full [&_svg]:w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <p className="text-center text-xs text-fg-subtle">用微信或 QQ 扫描二维码打开</p>
    </div>
  );
}
