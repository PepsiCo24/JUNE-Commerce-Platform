/**
 * 主子店继承与层级关系的纯计算。
 *
 * 这里刻意不依赖 Prisma、Nest 与任何 IO:
 *  - 继承/覆盖的判定规则是业务的核心语义,必须能被单元测试直接覆盖(见 shop-inheritance.test.ts);
 *  - 服务层只负责取数据、落库与抛错,规则本身在此唯一定义。
 *
 * 数据落地约定(很关键):可继承字段的**生效值始终写实**在子店行上,
 * 子店只额外用 `overriddenFields` 记录"哪些字段已被自己覆盖"。
 * 这样列表/详情查询不需要回溯主店,子店升为主店时也不会出现字段突然变空。
 */
import {
  INHERITABLE_SHOP_FIELD_VALUES,
  SHOP_MAX_DEPTH,
  type InheritableShopField,
  type ShopFieldInheritance,
} from '@june/shared';

/** 参与继承计算所需的最小店铺形状 */
export interface InheritableShopShape {
  platform: string | null;
  contactName: string | null;
  contactInfo: string | null;
  note: string | null;
}

export type InheritableValues = Record<InheritableShopField, string | null>;

/**
 * 沿 parent 链向上遍历的最大跳数。
 * 比业务层级上限留出余量:遇到脏数据形成的环或超长链时能停下来,而不是死循环。
 */
export const SHOP_ANCESTOR_WALK_MAX_HOPS = SHOP_MAX_DEPTH + 8;

/** 取父店 id 的解析器。返回 null 表示已到根,undefined 表示该店不在可见集合内。 */
export type ParentResolver = (shopId: string) => string | null | undefined;
/** 取直接子店 id 的解析器 */
export type ChildrenResolver = (shopId: string) => readonly string[] | undefined;

export function pickInheritableValues(shop: InheritableShopShape): InheritableValues {
  return {
    platform: shop.platform,
    contactName: shop.contactName,
    contactInfo: shop.contactInfo,
    note: shop.note,
  };
}

/** 该字段当前是"继承自主店"还是"已被子店覆盖" */
export function isInheritedField(
  overriddenFields: readonly string[],
  field: InheritableShopField,
): boolean {
  return !overriddenFields.includes(field);
}

/**
 * 计算详情页需要的继承状态数组。
 * 主店没有可继承来源,统一返回 overridden=true / inheritedValue=null,表示"自有值"。
 */
export function computeShopInheritance(args: {
  shop: InheritableShopShape;
  overriddenFields: readonly string[];
  parent: InheritableShopShape | null;
}): ShopFieldInheritance[] {
  const own = pickInheritableValues(args.shop);
  const parent = args.parent ? pickInheritableValues(args.parent) : null;

  return INHERITABLE_SHOP_FIELD_VALUES.map((field) => ({
    field,
    value: own[field],
    overridden: parent === null ? true : !isInheritedField(args.overriddenFields, field),
    inheritedValue: parent ? parent[field] : null,
  }));
}

/** 请求体中显式给出的可继承字段(显式传 null 也算显式:表示"覆盖为空") */
export function collectExplicitInheritableFields(
  patch: Partial<Record<InheritableShopField, string | null | undefined>>,
): InheritableShopField[] {
  return INHERITABLE_SHOP_FIELD_VALUES.filter((field) => patch[field] !== undefined);
}

/**
 * 创建子店时的取值:显式传入的字段用自己的值并记为覆盖,其余字段继承主店。
 */
export function resolveCreateInheritance(
  patch: Partial<Record<InheritableShopField, string | null | undefined>>,
  parent: InheritableShopShape | null,
): { values: Partial<InheritableValues>; overriddenFields: InheritableShopField[] } {
  const explicit = collectExplicitInheritableFields(patch);
  const values: Partial<InheritableValues> = {};

  for (const field of INHERITABLE_SHOP_FIELD_VALUES) {
    if (explicit.includes(field)) {
      values[field] = patch[field] ?? null;
    } else if (parent) {
      values[field] = pickInheritableValues(parent)[field];
    }
  }

  // 主店没有继承来源,覆盖标记恒为空
  return { values, overriddenFields: parent ? explicit : [] };
}

/** 合并覆盖标记:本次显式传入的字段并入原有标记,去重并保持稳定顺序 */
export function mergeOverriddenFields(
  current: readonly string[],
  explicit: readonly InheritableShopField[],
): InheritableShopField[] {
  const merged = new Set<string>([...current, ...explicit]);
  // 只保留合法字段,顺便清掉历史脏值
  return INHERITABLE_SHOP_FIELD_VALUES.filter((field) => merged.has(field));
}

/** 移除覆盖标记(重置继承) */
export function removeOverriddenFields(
  current: readonly string[],
  fields: readonly InheritableShopField[],
): InheritableShopField[] {
  return INHERITABLE_SHOP_FIELD_VALUES.filter(
    (field) => current.includes(field) && !fields.includes(field),
  );
}

export interface PropagationStep {
  field: InheritableShopField;
  value: string | null;
}

/**
 * 主店本次改动中需要向子店同步的字段。
 * 只取"请求里显式给出的可继承字段",没提到的字段不会被动改写子店。
 */
export function buildPropagationPlan(
  patch: Partial<Record<InheritableShopField, string | null | undefined>>,
): PropagationStep[] {
  return collectExplicitInheritableFields(patch).map((field) => ({
    field,
    value: patch[field] ?? null,
  }));
}

/** 单个字段一条 updateMany 的入参。守卫条件保证已覆盖的字段永不被主店改写。 */
export interface PropagationUpdate {
  where: {
    parentId: string;
    deletedAt: null;
    NOT: { overriddenFields: { has: InheritableShopField } };
  };
  data: Partial<InheritableValues>;
}

export function buildPropagationUpdates(
  parentId: string,
  plan: readonly PropagationStep[],
): PropagationUpdate[] {
  return plan.map((step) => ({
    where: {
      parentId,
      deletedAt: null,
      // 关键守卫:overriddenFields 含该字段的子店被排除在同步之外
      NOT: { overriddenFields: { has: step.field } },
    },
    data: { [step.field]: step.value } as Partial<InheritableValues>,
  }));
}

// ---------------------------------------------------------------------------
// 层级与循环
// ---------------------------------------------------------------------------

/**
 * 判断把 shopId 挂到 newParentId 下是否形成循环。
 *
 * 沿新父店的 parent 链向上走:
 *  - 走到 shopId 自己 → 说明 shopId 是新父店的祖先,挂接会成环;
 *  - 重复遇到同一节点,或超过最大跳数仍未到根 → 数据已脏,同样按循环拒绝(避免死循环)。
 */
export function detectShopCycle(args: {
  shopId: string;
  newParentId: string;
  getParent: ParentResolver;
  maxHops?: number;
}): boolean {
  if (args.shopId === args.newParentId) return true;

  const maxHops = args.maxHops ?? SHOP_ANCESTOR_WALK_MAX_HOPS;
  const seen = new Set<string>();
  let cursor: string | null = args.newParentId;
  let hops = 0;

  while (cursor !== null && hops < maxHops) {
    if (cursor === args.shopId) return true;
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = args.getParent(cursor) ?? null;
    hops += 1;
  }

  // 跳数用尽却还没到根:视为脏数据,拒绝挂接
  return cursor !== null;
}

/** 店铺所处层级。根(主店)为 1。数据成环或超长时返回 maxHops + 1,必然触发层级校验失败。 */
export function computeShopDepth(
  shopId: string,
  getParent: ParentResolver,
  maxHops: number = SHOP_ANCESTOR_WALK_MAX_HOPS,
): number {
  const seen = new Set<string>([shopId]);
  let depth = 1;
  let cursor: string | null = getParent(shopId) ?? null;

  while (cursor !== null && depth <= maxHops) {
    if (seen.has(cursor)) return maxHops + 1;
    seen.add(cursor);
    depth += 1;
    cursor = getParent(cursor) ?? null;
  }

  return cursor !== null ? maxHops + 1 : depth;
}

/** 子树高度。叶子为 1。用于"带着下级一起搬迁"时的层级校验。 */
export function computeSubtreeHeight(
  shopId: string,
  getChildren: ChildrenResolver,
  maxHops: number = SHOP_ANCESTOR_WALK_MAX_HOPS,
): number {
  const seen = new Set<string>([shopId]);
  let frontier: string[] = [shopId];
  let height = 1;

  while (frontier.length > 0 && height <= maxHops) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of getChildren(id) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        next.push(child);
      }
    }
    if (next.length === 0) break;
    frontier = next;
    height += 1;
  }

  return height;
}

/**
 * 挂接后的最深层级是否越界。
 * 新层级 = 新父店层级 + 被挂接子树的高度(叶子高度为 1)。
 */
export function exceedsMaxDepth(args: {
  newParentId: string;
  subtreeHeight: number;
  getParent: ParentResolver;
  maxDepth?: number;
}): boolean {
  const maxDepth = args.maxDepth ?? SHOP_MAX_DEPTH;
  return computeShopDepth(args.newParentId, args.getParent) + args.subtreeHeight > maxDepth;
}
