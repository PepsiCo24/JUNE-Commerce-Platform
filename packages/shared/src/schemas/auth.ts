import { z } from 'zod';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../constants';

/**
 * 密码强度:长度 + 至少三类字符。规则前后端一致,后端为最终判定方。
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 位`)
  .max(PASSWORD_MAX_LENGTH)
  .refine(
    (value) => {
      const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
      return classes >= 3;
    },
    { message: '密码需包含小写字母、大写字母、数字、符号中的至少三类' },
  );

export const emailSchema = z.email('邮箱格式不正确').max(200).toLowerCase().trim();

export const displayNameSchema = z
  .string()
  .trim()
  .min(2, '昵称至少 2 个字符')
  .max(40, '昵称最多 40 个字符')
  // 禁止控制字符与首尾空白
  .regex(/^[^\p{Cc}\p{Cf}]+$/u, '昵称包含不允许的字符');

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, '请输入密码').max(PASSWORD_MAX_LENGTH),
  /** 记住登录状态:延长会话有效期 */
  remember: z.boolean().default(false),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, '请输入当前密码').max(PASSWORD_MAX_LENGTH),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: '新密码不能与当前密码相同',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const updateProfileSchema = z.object({
  displayName: displayNameSchema.optional(),
  bio: z.string().trim().max(500).nullable().optional(),
  /** 头像 Asset id;传 null 表示清除头像 */
  avatarAssetId: z.string().min(8).max(64).nullable().optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** 敏感操作前的重新验证:用当前密码换取一次性短时令牌 */
export const reauthSchema = z.object({
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  purpose: z.literal('credential.reveal'),
});
export type ReauthInput = z.infer<typeof reauthSchema>;

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  status: 'ACTIVE' | 'DISABLED';
  roles: string[];
  permissions: string[];
  /** 便于前端快速判断是否展示 /admin 入口 */
  isAdmin: boolean;
  isSuperAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthStateResponse {
  user: SessionUser | null;
  /** 双提交 Cookie 模式下前端需要回填到请求头的 CSRF 令牌 */
  csrfToken: string | null;
}
