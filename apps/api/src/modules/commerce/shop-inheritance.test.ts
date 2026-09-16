import { INHERITABLE_SHOP_FIELD_VALUES, SHOP_MAX_DEPTH } from '@june/shared';
import { describe, expect, it } from 'vitest';

import {
  buildPropagationPlan,
  buildPropagationUpdates,
  computeShopInheritance,
  detectShopCycle,
  exceedsMaxDepth,
  mergeOverriddenFields,
  removeOverriddenFields,
  resolveCreateInheritance,
  type InheritableValues,
  type PropagationUpdate,
} from './shop-inheritance';

/** 测试用的子店行 */
interface ChildRow extends InheritableValues {
  id: string;
  parentId: string | null;
  deletedAt: Date | null;
  overriddenFields: string[];
}

function child(id: string, overriddenFields: string[], values: Partial<InheritableValues> = {}): ChildRow {
  return {
    id,
    parentId: 'main-1',
    deletedAt: null,
    overriddenFields,
    platform: 'taobao',
    contactName: '旧联系人',
    contactInfo: '13800000000',
    note: '旧备注',
    ...values,
  };
}

/**
 * 按 Prisma updateMany 的语义在内存里执行一次同步:
 * where 命中的行才会被改写。这样测试验证的是服务层真正下发的那份 where/data。
 */
function applyUpdateMany(rows: ChildRow[], update: PropagationUpdate): number {
  let affected = 0;
  for (const row of rows) {
    if (row.parentId !== update.where.parentId) continue;
    if (row.deletedAt !== update.where.deletedAt) continue;
    if (row.overriddenFields.includes(update.where.NOT.overriddenFields.has)) continue;
    Object.assign(row, update.data);
    affected += 1;
  }
  return affected;
}

describe('主店更新向子店同步', () => {
  it('只同步子店未覆盖的字段,已覆盖字段保持原值', () => {
    // 子店 A 覆盖了联系人;子店 B 完全继承
    const rows = [
      child('sub-a', ['contactName'], { contactName: 'A 自己的联系人' }),
      child('sub-b', []),
    ];

    // 主店本次把平台与联系人都改了
    const plan = buildPropagationPlan({ platform: 'douyin', contactName: '新联系人' });
    const updates = buildPropagationUpdates('main-1', plan);

    expect(updates).toHaveLength(2);
    // 每个字段一条 updateMany,且都带"排除已覆盖"的守卫
    expect(updates.map((u) => u.where.NOT.overriddenFields.has)).toEqual(['platform', 'contactName']);

    const affected = updates.map((u) => applyUpdateMany(rows, u));
    expect(affected).toEqual([2, 1]);

    const [subA, subB] = rows;
    // 未覆盖的平台被同步
    expect(subA?.platform).toBe('douyin');
    expect(subB?.platform).toBe('douyin');
    // 已覆盖的联系人永不被主店改写
    expect(subA?.contactName).toBe('A 自己的联系人');
    expect(subB?.contactName).toBe('新联系人');
  });

  it('主店没有提到的可继承字段不会被动改写子店', () => {
    const rows = [child('sub-b', [])];
    const updates = buildPropagationUpdates('main-1', buildPropagationPlan({ platform: 'jd' }));

    for (const update of updates) applyUpdateMany(rows, update);

    expect(rows[0]?.platform).toBe('jd');
    expect(rows[0]?.note).toBe('旧备注');
    expect(rows[0]?.contactInfo).toBe('13800000000');
  });

  it('显式传入字段即视为覆盖,显式传 null 也算', () => {
    const created = resolveCreateInheritance(
      { contactName: '子店自己的联系人', note: null },
      { platform: 'taobao', contactName: '主店联系人', contactInfo: '400-000', note: '主店备注' },
    );

    expect(created.overriddenFields).toEqual(['contactName', 'note']);
    // 未显式传入的字段默认继承主店
    expect(created.values.platform).toBe('taobao');
    expect(created.values.contactInfo).toBe('400-000');
    expect(created.values.note).toBeNull();

    expect(mergeOverriddenFields(['note'], ['platform'])).toEqual(['platform', 'note']);
    expect(removeOverriddenFields(['platform', 'note'], ['note'])).toEqual(['platform']);
  });

  it('详情的继承状态能区分继承与覆盖', () => {
    const inheritance = computeShopInheritance({
      shop: { platform: 'taobao', contactName: '子店联系人', contactInfo: null, note: null },
      overriddenFields: ['contactName'],
      parent: { platform: 'taobao', contactName: '主店联系人', contactInfo: null, note: '主店备注' },
    });

    expect(inheritance).toHaveLength(INHERITABLE_SHOP_FIELD_VALUES.length);
    const contactName = inheritance.find((entry) => entry.field === 'contactName');
    expect(contactName).toMatchObject({
      value: '子店联系人',
      overridden: true,
      inheritedValue: '主店联系人',
    });
    const note = inheritance.find((entry) => entry.field === 'note');
    expect(note).toMatchObject({ value: null, overridden: false, inheritedValue: '主店备注' });
  });
});

describe('循环挂接检测', () => {
  // main -> sub -> grand(脏数据造出的三级,用于验证祖先命中)
  const parentOf = new Map<string, string | null>([
    ['main', null],
    ['sub', 'main'],
    ['grand', 'sub'],
    ['other-main', null],
  ]);
  const getParent = (id: string): string | null | undefined => parentOf.get(id);

  it('挂到自己下面被拒绝', () => {
    expect(detectShopCycle({ shopId: 'sub', newParentId: 'sub', getParent })).toBe(true);
  });

  it('挂到自己的后代下面被拒绝', () => {
    expect(detectShopCycle({ shopId: 'main', newParentId: 'sub', getParent })).toBe(true);
    expect(detectShopCycle({ shopId: 'main', newParentId: 'grand', getParent })).toBe(true);
  });

  it('挂到无关的主店下面允许', () => {
    expect(detectShopCycle({ shopId: 'sub', newParentId: 'other-main', getParent })).toBe(false);
  });

  it('已成环的脏数据不会死循环,直接判为循环', () => {
    const dirty = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(
      detectShopCycle({ shopId: 'x', newParentId: 'a', getParent: (id) => dirty.get(id) }),
    ).toBe(true);
  });

  it('层级超限被拒绝', () => {
    // 把叶子挂到主店下 => 两级,正好等于上限
    expect(
      exceedsMaxDepth({ newParentId: 'main', subtreeHeight: 1, getParent, maxDepth: SHOP_MAX_DEPTH }),
    ).toBe(false);
    // 带着一层下级搬到主店下 => 三级,超限
    expect(
      exceedsMaxDepth({ newParentId: 'main', subtreeHeight: 2, getParent, maxDepth: SHOP_MAX_DEPTH }),
    ).toBe(true);
    // 挂到已经是二级的店下 => 三级,超限
    expect(
      exceedsMaxDepth({ newParentId: 'sub', subtreeHeight: 1, getParent, maxDepth: SHOP_MAX_DEPTH }),
    ).toBe(true);
  });
});
