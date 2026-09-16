'use client';

import { ShieldCheck } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { describeError } from '@/lib/api/errors';

/**
 * 敏感操作的重新验证。
 *
 * 后端 ReauthGuard 的实现决定了这里的用法(见 apps/api/.../reauth.guard.ts):
 * 令牌以 `updateMany` 条件更新的方式**一次性消费**,用途绑定 credential.reveal。
 * 也就是说**每次查看、每次复制都必须重新验证**,不存在"有效期内复用同一令牌"的空间,
 * 所以这里刻意不缓存令牌:拿到即用,用完即弃。
 *
 * 令牌只作为 Promise 的 resolve 值短暂存在于调用栈中,
 * 不写 state、不写 query cache、不写 storage。
 */

interface PendingRequest {
  resolve: (token: string | null) => void;
}

export interface UseReauthResult {
  /** 打开重验弹窗;用户完成验证后 resolve 一次性令牌,取消则 resolve null */
  requestToken: (reason?: string) => Promise<string | null>;
  /** 挂载在页面上的弹窗节点 */
  dialog: ReactNode;
}

export function useReauth(): UseReauthResult {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pendingRef = useRef<PendingRequest | null>(null);

  const settle = useCallback((token: string | null) => {
    pendingRef.current?.resolve(token);
    pendingRef.current = null;
    // 密码输入框内容立即清空,不在内存里多留一刻
    setPassword('');
    setError(null);
    setSubmitting(false);
    setOpen(false);
  }, []);

  const requestToken = useCallback((nextReason?: string) => {
    return new Promise<string | null>((resolve) => {
      // 已有未完成的请求:先把它当作取消处理,避免 Promise 悬挂
      pendingRef.current?.resolve(null);
      pendingRef.current = { resolve };
      setReason(nextReason ?? null);
      setPassword('');
      setError(null);
      setOpen(true);
    });
  }, []);

  const submit = useCallback(async () => {
    if (!password) {
      setError('请输入当前登录密码');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post<{ token: string; expiresAt: string }>('/auth/reauth', {
        password,
        purpose: 'credential.reveal',
      });
      settle(result.token);
    } catch (cause) {
      setError(describeError(cause));
      setSubmitting(false);
    }
  }, [password, settle]);

  const dialog = (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(null);
      }}
      theme="dark"
      size="sm"
      title="重新验证身份"
      description={
        reason ??
        '该操作涉及店铺账号密码明文,需要先用当前登录密码确认是你本人操作。本次查看会写入审计日志。'
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => settle(null)}>
            取消
          </Button>
          <Button loading={submitting} iconLeft={<ShieldCheck size={16} />} onClick={() => void submit()}>
            验证并继续
          </Button>
        </div>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="当前登录密码" htmlFor="reauth-password" required error={error}>
          <Input
            id="reauth-password"
            type="password"
            autoComplete="current-password"
            value={password}
            invalid={Boolean(error)}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="请输入登录密码"
          />
        </Field>
        {/* 隐藏的提交按钮:让回车键也能提交,键盘用户不必去点按钮 */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
          提交
        </button>
      </form>
    </Dialog>
  );

  return { requestToken, dialog };
}
