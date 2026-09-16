import { BrandLogo } from '@june/brand';
import { BRAND_FULL_NAME } from '@june/shared';

/**
 * 登录 / 注册共用的卡片外壳:品牌标识 + 半透明卡片 + 底部完整名称。
 * 无状态、无 hooks,可以在服务端组件里直接渲染。
 */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  /** 卡片底部的跳转链接区 */
  footer?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="w-full">
      <div className="mb-7 flex justify-center">
        {/* 完整品牌组合。宽度用 min() 收敛,390px 屏也不会顶到边 */}
        <BrandLogo variant="full" theme="dark" size="xl" className="h-auto w-[min(13rem,68vw)]" title={BRAND_FULL_NAME} />
      </div>

      <div className="june-glass rounded-2xl p-6 sm:p-8">
        <h1 className="text-lg font-semibold text-fg">{title}</h1>
        {description ? <p className="mt-1.5 text-sm text-fg-muted">{description}</p> : null}

        <div className="mt-6">{children}</div>

        {footer ? (
          <div className="mt-6 border-t border-border-default pt-4 text-sm text-fg-muted">{footer}</div>
        ) : null}

        <p className="mt-6 text-center text-xs text-fg-subtle">{BRAND_FULL_NAME}</p>
      </div>
    </div>
  );
}
