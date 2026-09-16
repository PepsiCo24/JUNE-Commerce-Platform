/**
 * 数据层常量。与 Prisma schema 中的注释保持一致,是种子数据与运行时校验的唯一来源。
 */

export const ROLE_USER = 'user' as const;
export const ROLE_ADMIN = 'admin' as const;
export const ROLE_SUPER_ADMIN = 'super_admin' as const;

export type RoleSlug = typeof ROLE_USER | typeof ROLE_ADMIN | typeof ROLE_SUPER_ADMIN;

/** 角色等级:数值越大权限越高,用于"至少 ADMIN"这类比较 */
export const ROLE_LEVEL: Record<RoleSlug, number> = {
  [ROLE_USER]: 10,
  [ROLE_ADMIN]: 50,
  [ROLE_SUPER_ADMIN]: 100,
};

/**
 * 系统内置角色定义。
 * 权限点用于比"角色等级"更细的控制,例如只给某管理员内容管理权而不给模型管理权。
 */
export const DEFAULT_ROLES: Array<{
  slug: RoleSlug;
  name: string;
  description: string;
  level: number;
  permissions: string[];
}> = [
  {
    slug: ROLE_USER,
    name: '普通用户',
    description: '可使用社区与工作台,只能访问自己的业务数据',
    level: ROLE_LEVEL[ROLE_USER],
    permissions: [],
  },
  {
    slug: ROLE_ADMIN,
    name: '管理员',
    description: '可进入 /admin,管理内容、用户与模型配置',
    level: ROLE_LEVEL[ROLE_ADMIN],
    permissions: [
      'admin.access',
      'dashboard.read',
      'user.read',
      'user.status.write',
      'post.manage',
      'comment.manage',
      'model.manage',
      'content_rule.manage',
      'share_config.manage',
      'task.read',
      'storage.read',
      'audit.read',
    ],
  },
  {
    slug: ROLE_SUPER_ADMIN,
    name: '超级管理员',
    description: '管理员全部权限,并可管理管理员账号与系统配置',
    level: ROLE_LEVEL[ROLE_SUPER_ADMIN],
    permissions: [
      'admin.access',
      'dashboard.read',
      'user.read',
      'user.status.write',
      'user.role.write',
      'post.manage',
      'comment.manage',
      'model.manage',
      'content_rule.manage',
      'share_config.manage',
      'task.read',
      'task.write',
      'storage.read',
      'storage.cleanup',
      'audit.read',
      'system_config.manage',
    ],
  },
];

// 说明:可继承的店铺字段定义在 @june/shared 的 INHERITABLE_SHOP_FIELDS,
// 由前后端共用,数据层不再重复声明,避免两处定义漂移。
