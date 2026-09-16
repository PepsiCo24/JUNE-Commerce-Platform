'use client';

import type { SessionUser } from '@june/shared';
import { LogOut, Settings, Shield, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { Avatar } from '@/components/ui/avatar';
import { DropdownMenu } from '@/components/ui/dropdown-menu';
import { truncate } from '@/lib/utils';
import { useAuth } from '@/providers/auth-provider';
import { usePreferences } from '@/providers/preferences-provider';

/**
 * 顶栏右侧的用户菜单。
 *
 * 关于「管理后台」入口:
 *   `user.isAdmin` 只用来决定这一行菜单是否渲染,纯粹是体验优化。
 *   `/admin` 的访问权限由后端 RolesGuard 强制校验(且管理站使用独立会话 Cookie),
 *   即便有人手动敲 URL、改前端状态或伪造 Cookie,也拿不到任何管理数据。
 */
export function UserMenu({ user, theme }: { user: SessionUser; theme: 'dark' | 'light' }): React.JSX.Element {
  const router = useRouter();
  const { logout } = useAuth();
  const { reducedMotion, setReducedMotionOverride } = usePreferences();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
      setConfirmOpen(false);
    }
  };

  return (
    <>
      <DropdownMenu
        align="end"
        theme={theme}
        trigger={
          <button
            type="button"
            className="flex items-center gap-2 rounded-full border border-border-default bg-surface py-1 pr-3 pl-1 text-sm text-fg transition-colors hover:bg-surface-hover"
            aria-label={`账号菜单:${user.displayName}`}
          >
            <Avatar src={user.avatarUrl} name={user.displayName} size={28} />
            {/* 昵称在窄屏隐藏,只留头像,避免顶栏被挤压换行 */}
            <span className="hidden max-w-[10rem] truncate sm:inline">{truncate(user.displayName, 12)}</span>
          </button>
        }
        items={[
          { type: 'label' as const, label: user.email },
          { type: 'separator' as const },
          {
            type: 'item' as const,
            label: '个人设置',
            icon: <Settings size={16} aria-hidden="true" />,
            onSelect: () => {
              router.push('/settings');
            },
          },
          {
            type: 'item' as const,
            label: reducedMotion ? '恢复动态效果' : '减少动态效果',
            icon: <Sparkles size={16} aria-hidden="true" />,
            // 写入用户偏好并持久化,globals.css 会据此整站降级动效
            onSelect: () => setReducedMotionOverride(!reducedMotion),
          },
          // 仅管理员可见的入口 —— 只是少渲染一行菜单,不构成任何权限控制
          ...(user.isAdmin
            ? [
                { type: 'separator' as const },
                {
                  type: 'item' as const,
                  label: '管理后台',
                  icon: <Shield size={16} aria-hidden="true" />,
                  onSelect: () => {
                    router.push('/admin');
                  },
                },
              ]
            : []),
          { type: 'separator' as const },
          {
            type: 'item' as const,
            label: '退出登录',
            icon: <LogOut size={16} aria-hidden="true" />,
            danger: true,
            onSelect: () => setConfirmOpen(true),
          },
        ]}
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="退出登录?"
        description="退出后需要重新输入邮箱与密码。其他设备上的登录不受影响。"
        confirmLabel="退出登录"
        danger
        loading={loggingOut}
        theme={theme}
        onConfirm={handleLogout}
      />
    </>
  );
}
