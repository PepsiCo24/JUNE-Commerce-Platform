/**
 * @june/db 对外出口。
 * 应用层只从这里导入 Prisma 类型与枚举,不直接引用 generated 目录,
 * 这样以后调整生成路径或拆分数据库时不需要改业务代码。
 *
 * 注意:Prisma 7 把模型行类型与枚举都收敛到 generated/prisma/client 入口,
 * models/enums 是纯类型 barrel,枚举的运行时值只能从 client 取。
 */
export { createPrismaClient } from './client';
export type { JunePrismaClient, JuneTransactionClient, PrismaClientOptions } from './client';

export { Prisma, PrismaClient } from '../generated/prisma/client';

// 枚举:既作为类型也作为运行时值使用
export {
  AssetKind,
  AssetStatus,
  AssetVisibility,
  CommentStatus,
  ContentRuleType,
  ImportStatus,
  ModelCapability,
  PostStatus,
  ProductStatus,
  ProviderKind,
  ResultStatus,
  RuleAction,
  SessionScope,
  ShopStatus,
  ShopType,
  TaskStatus,
  TaskType,
  UserStatus,
} from '../generated/prisma/client';

// 模型行类型
export type {
  Asset,
  AuditLog,
  CleanupRun,
  Comment,
  ConfigRevision,
  ContentRule,
  ContentRuleVersion,
  GenerationResult,
  GenerationTask,
  ImportJob,
  Like,
  ModelConfig,
  ModelProvider,
  Post,
  Product,
  ReauthToken,
  Role,
  Session,
  Shop,
  ShopCredential,
  StorageUsage,
  SystemConfig,
  User,
  UserRole,
} from '../generated/prisma/client';

export {
  DEFAULT_ROLES,
  ROLE_ADMIN,
  ROLE_LEVEL,
  ROLE_SUPER_ADMIN,
  ROLE_USER,
  type RoleSlug,
} from './constants';
