import { z } from 'zod';

import {
  INHERITABLE_SHOP_FIELD_VALUES,
  PRODUCT_IMPORT_MAX_ROWS,
  PRODUCT_NAME_MAX,
  PRODUCT_SKU_MAX,
  SHOP_NAME_MAX,
} from '../constants';
import { cursorQuerySchema, idSchema, pageQuerySchema } from './common';

// ---------------------------------------------------------------------------
// 店铺
// ---------------------------------------------------------------------------

export const shopBaseFieldsSchema = z.object({
  name: z.string().trim().min(1, '店铺名称不能为空').max(SHOP_NAME_MAX),
  platform: z.string().trim().max(60).nullable().optional(),
  url: z.url('店铺链接格式不正确').max(500).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  contactName: z.string().trim().max(80).nullable().optional(),
  contactInfo: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'CLOSED']).default('ACTIVE'),
});

export const shopCreateSchema = shopBaseFieldsSchema.extend({
  /** 传 parentId 即创建子店铺;父店必须是同一用户的主店铺 */
  parentId: idSchema.nullable().optional(),
});
export type ShopCreateInput = z.infer<typeof shopCreateSchema>;

export const shopUpdateSchema = shopBaseFieldsSchema.partial().extend({
  parentId: idSchema.nullable().optional(),
  /**
   * 主店字段变更时是否同步到未覆盖该字段的子店。默认 true。
   * 已被子店覆盖的字段永不被同步覆盖。
   */
  propagateToChildren: z.boolean().default(true),
});
export type ShopUpdateInput = z.infer<typeof shopUpdateSchema>;

/** 子店铺重置某个继承字段:清除覆盖标记并重新取主店的值 */
export const shopResetInheritanceSchema = z.object({
  fields: z.array(z.enum(INHERITABLE_SHOP_FIELD_VALUES)).min(1),
});

export const shopListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  type: z.enum(['ALL', 'MAIN', 'SUB']).default('ALL'),
  status: z.enum(['ALL', 'ACTIVE', 'PAUSED', 'CLOSED']).default('ALL'),
  parentId: idSchema.optional(),
});

/**
 * 删除主店铺时必须显式声明如何处理其子店、商品与凭据,不做静默级联删除。
 */
export const shopDeleteSchema = z
  .object({
    /** 子店铺处理方式 */
    childrenStrategy: z.enum(['reject', 'promote_to_main', 'move_to_shop', 'delete']).default('reject'),
    /** childrenStrategy=move_to_shop 时的目标主店 */
    childrenTargetShopId: idSchema.optional(),
    /** 商品处理方式 */
    productsStrategy: z.enum(['reject', 'move_to_shop', 'archive', 'delete']).default('reject'),
    productsTargetShopId: idSchema.optional(),
    /** 凭据处理方式。凭据不允许迁移到其他店铺(用途与账号强绑定),只能删除或先手动处理 */
    credentialsStrategy: z.enum(['reject', 'delete']).default('reject'),
    /** 二次确认:必须回填店铺名称 */
    confirmName: z.string().min(1),
  })
  .refine((v) => v.childrenStrategy !== 'move_to_shop' || !!v.childrenTargetShopId, {
    message: '请选择子店铺迁移到的目标主店铺',
    path: ['childrenTargetShopId'],
  })
  .refine((v) => v.productsStrategy !== 'move_to_shop' || !!v.productsTargetShopId, {
    message: '请选择商品迁移到的目标店铺',
    path: ['productsTargetShopId'],
  });
export type ShopDeleteInput = z.infer<typeof shopDeleteSchema>;

export interface ShopFieldInheritance {
  field: string;
  /** 当前生效值 */
  value: string | null;
  /** 是否被子店覆盖。false 表示继承主店 */
  overridden: boolean;
  /** 主店的值,便于界面展示"继承自主店:xxx" */
  inheritedValue: string | null;
}

export interface ShopSummary {
  id: string;
  name: string;
  type: 'MAIN' | 'SUB';
  status: 'ACTIVE' | 'PAUSED' | 'CLOSED';
  platform: string | null;
  url: string | null;
  parentId: string | null;
  parentName: string | null;
  productCount: number;
  childCount: number;
  credentialCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShopDetail extends ShopSummary {
  description: string | null;
  contactName: string | null;
  contactInfo: string | null;
  note: string | null;
  /** 可继承字段的继承/覆盖状态 */
  inheritance: ShopFieldInheritance[];
}

export interface ShopStats {
  total: number;
  mainCount: number;
  subCount: number;
  /** 每店商品数 */
  productCountByShop: Array<{ shopId: string; shopName: string; productCount: number }>;
}

/** 店铺关系图数据(前端交给 Dagre 自动布局) */
export interface ShopGraph {
  nodes: Array<{
    id: string;
    name: string;
    type: 'MAIN' | 'SUB';
    status: 'ACTIVE' | 'PAUSED' | 'CLOSED';
    productCount: number;
    platform: string | null;
  }>;
  edges: Array<{ id: string; source: string; target: string }>;
}

// ---------------------------------------------------------------------------
// 店铺凭据
// ---------------------------------------------------------------------------

export const credentialCreateSchema = z.object({
  purpose: z.string().trim().min(1, '请填写用途').max(120),
  account: z.string().trim().min(1, '请填写账号').max(200),
  password: z.string().min(1, '请填写密码').max(500),
  loginUrl: z.url('登录网址格式不正确').max(500).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});
export type CredentialCreateInput = z.infer<typeof credentialCreateSchema>;

export const credentialUpdateSchema = credentialCreateSchema.partial().extend({
  /** 不传 password 表示不修改密码 */
  password: z.string().min(1).max(500).optional(),
});

export const credentialListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
});

/** 普通接口返回的凭据:密码始终为掩码,不含明文 */
export interface CredentialSummary {
  id: string;
  shopId: string;
  shopName: string;
  purpose: string;
  account: string;
  loginUrl: string | null;
  note: string | null;
  /** 固定掩码,不反映真实长度 */
  passwordMask: string;
  passwordUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** 解密接口的响应。仅在通过重新验证后由专用受控接口返回。 */
export interface CredentialRevealResponse {
  id: string;
  password: string;
  /** 明文在前端的建议保留时长(秒),到期自动隐藏 */
  expiresInSeconds: number;
}

// ---------------------------------------------------------------------------
// 商品
// ---------------------------------------------------------------------------

export const productAttributesSchema = z.record(z.string().max(60), z.string().max(500)).default({});

export const productCreateSchema = z.object({
  shopId: idSchema,
  name: z.string().trim().min(1, '商品名称不能为空').max(PRODUCT_NAME_MAX),
  sku: z.string().trim().max(PRODUCT_SKU_MAX).nullable().optional(),
  title: z.string().trim().max(300).nullable().optional(),
  description: z.string().max(20_000).nullable().optional(),
  price: z.coerce.number().min(0).max(99_999_999).nullable().optional(),
  currency: z.string().trim().length(3).default('CNY'),
  stock: z.coerce.number().int().min(0).max(9_999_999).default(0),
  status: z.enum(['DRAFT', 'ACTIVE', 'OFF_SHELF', 'ARCHIVED']).default('DRAFT'),
  attributes: productAttributesSchema,
  coverAssetId: idSchema.nullable().optional(),
  imageAssetIds: z.array(idSchema).max(20).default([]),
});
export type ProductCreateInput = z.infer<typeof productCreateSchema>;

export const productUpdateSchema = productCreateSchema.partial().omit({ shopId: true }).extend({
  /** 允许在同一用户的店铺之间移动商品 */
  shopId: idSchema.optional(),
});
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;

export const productListQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  shopId: idSchema.optional(),
  status: z.enum(['ALL', 'DRAFT', 'ACTIVE', 'OFF_SHELF', 'ARCHIVED']).default('ALL'),
  sort: z.enum(['updated_desc', 'created_desc', 'name_asc', 'price_asc', 'price_desc']).default('updated_desc'),
});

export interface ProductSummary {
  id: string;
  shopId: string;
  shopName: string;
  name: string;
  sku: string | null;
  title: string | null;
  price: string | null;
  currency: string;
  stock: number;
  status: 'DRAFT' | 'ACTIVE' | 'OFF_SHELF' | 'ARCHIVED';
  coverUrl: string | null;
  imageCount: number;
  updatedAt: string;
}

export interface ProductDetail extends ProductSummary {
  description: string | null;
  attributes: Record<string, string>;
  images: Array<{ assetId: string; url: string; previewUrl: string; width: number | null; height: number | null }>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 商品 CSV 导入
// ---------------------------------------------------------------------------

export const productImportPreviewSchema = z.object({
  shopId: idSchema,
  fileAssetId: idSchema,
});

export const productImportCommitSchema = z.object({
  shopId: idSchema,
  fileAssetId: idSchema,
  /** 遇到重复 SKU 的处理方式 */
  duplicateStrategy: z.enum(['skip', 'update', 'fail']).default('skip'),
  /** 是否忽略校验失败的行继续导入其余行 */
  continueOnRowError: z.boolean().default(true),
});
export type ProductImportCommitInput = z.infer<typeof productImportCommitSchema>;

export interface ProductImportRowError {
  row: number;
  field: string | null;
  code: string;
  message: string;
}

export interface ProductImportPreview {
  totalRows: number;
  /** 前若干行的解析结果预览 */
  sample: Array<Record<string, string>>;
  errors: ProductImportRowError[];
  /** 超过上限时直接拒绝 */
  maxRows: number;
  detectedColumns: string[];
  missingRequiredColumns: string[];
}

export interface ImportJobStatus {
  id: string;
  status: 'PENDING' | 'VALIDATING' | 'RUNNING' | 'PARTIAL' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
  rowErrors: ProductImportRowError[];
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export { PRODUCT_IMPORT_MAX_ROWS };
