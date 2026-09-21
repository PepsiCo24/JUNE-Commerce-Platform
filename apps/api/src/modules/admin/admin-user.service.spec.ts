import 'reflect-metadata';

import { ERROR_CODES } from '@june/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-context';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { SessionService } from '../auth/session.service';
import { AdminUserService } from './admin-user.service';

/**
 * 用 mock 的 PrismaService,不连真实数据库。
 * 覆盖两类硬性要求:
 *  1. 最后一个超级管理员保护 —— 撤销角色 / 禁用 / 删除三条路径都必须抛 LAST_SUPER_ADMIN;
 *  2. 店铺凭据下钻接口绝不返回 password(明文与密文都不返回)。
 */

const SUPER_ADMIN_ACTOR: AuthUser = {
  id: 'actor-super',
  email: 'root@june.test',
  displayName: '超级管理员',
  status: 'ACTIVE',
  roles: ['super_admin'],
  permissions: ['user.role.write'],
  roleLevel: 100,
  isAdmin: true,
  isSuperAdmin: true,
};

const META = { ip: '127.0.0.1', userAgent: 'vitest' };

interface TxMock {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  userRole: {
    deleteMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
  };
}

function createHarness(options: { remainingSuperAdmins: number }) {
  const tx: TxMock = {
    user: {
      // 目标用户本身是"处于 ACTIVE 且拥有 super_admin"的账号
      findUnique: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        deletedAt: null,
        roles: [{ role: { slug: 'super_admin' } }],
      }),
      // 除目标之外还剩几个可用超级管理员
      count: vi.fn().mockResolvedValue(options.remainingSuperAdmins),
      update: vi.fn().mockResolvedValue({}),
    },
    userRole: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };

  const db = {
    $transaction: vi.fn(async (cb: (client: TxMock) => Promise<unknown>) => cb(tx)),
    user: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'target-1',
        email: 'target@june.test',
        status: 'ACTIVE',
        roles: [{ role: { slug: 'super_admin' } }],
      }),
    },
    role: {
      findMany: vi.fn().mockResolvedValue([{ id: 'role-admin', slug: 'admin' }]),
    },
  };

  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
    buildDiff: vi.fn().mockReturnValue({}),
  };
  const sessions = { revokeAllForUser: vi.fn().mockResolvedValue(undefined) };
  const crypto = {
    hashPassword: vi.fn().mockResolvedValue('argon2id$hashed'),
  };

  const service = new AdminUserService(
    { db } as unknown as PrismaService,
    audit as unknown as AuditService,
    sessions as unknown as SessionService,
    crypto as unknown as import('../../common/crypto/crypto.service').CryptoService,
  );

  return { service, db, tx, audit, sessions, crypto };
}

describe('AdminUserService 最后一个超级管理员保护', () => {
  it('撤销 super_admin 角色时,若这是最后一个超管则抛 LAST_SUPER_ADMIN', async () => {
    const { service, tx, sessions } = createHarness({ remainingSuperAdmins: 0 });

    await expect(
      service.setRoles(SUPER_ADMIN_ACTOR, 'target-1', { roles: ['admin'] }, META),
    ).rejects.toMatchObject({ code: ERROR_CODES.LAST_SUPER_ADMIN });

    // 保护生效时不得落库、也不得撤销会话
    expect(tx.userRole.deleteMany).not.toHaveBeenCalled();
    expect(tx.userRole.createMany).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('禁用用户时,若这是最后一个超管则抛 LAST_SUPER_ADMIN', async () => {
    const { service, tx, sessions } = createHarness({ remainingSuperAdmins: 0 });

    await expect(
      service.setStatus(SUPER_ADMIN_ACTOR, 'target-1', { status: 'DISABLED' }, META),
    ).rejects.toMatchObject({ code: ERROR_CODES.LAST_SUPER_ADMIN });

    expect(tx.user.update).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('删除用户时,若这是最后一个超管则抛 LAST_SUPER_ADMIN', async () => {
    const { service, tx } = createHarness({ remainingSuperAdmins: 0 });

    await expect(service.remove(SUPER_ADMIN_ACTOR, 'target-1', '离职', META)).rejects.toMatchObject({
      code: ERROR_CODES.LAST_SUPER_ADMIN,
    });

    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('检查在事务内完成:count 与写操作使用同一个事务客户端', async () => {
    const { service, db, tx } = createHarness({ remainingSuperAdmins: 0 });

    await expect(
      service.setStatus(SUPER_ADMIN_ACTOR, 'target-1', { status: 'DISABLED' }, META),
    ).rejects.toMatchObject({ code: ERROR_CODES.LAST_SUPER_ADMIN });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.count).toHaveBeenCalledTimes(1);
    // 判定口径:排除目标本人,只数 ACTIVE、未软删除且拥有 super_admin 的账号
    expect(tx.user.count.mock.calls[0]?.[0]).toMatchObject({
      where: {
        id: { not: 'target-1' },
        deletedAt: null,
        status: 'ACTIVE',
        roles: { some: { role: { slug: 'super_admin' } } },
      },
    });
  });

  it('仍有其他超级管理员时,三条路径都可以正常执行', async () => {
    const disable = createHarness({ remainingSuperAdmins: 1 });
    await expect(
      disable.service.setStatus(SUPER_ADMIN_ACTOR, 'target-1', { status: 'DISABLED' }, META),
    ).resolves.toMatchObject({ status: 'DISABLED' });
    // 禁用后必须立即失效其所有会话(内部会递增 sessionEpoch)
    expect(disable.sessions.revokeAllForUser).toHaveBeenCalledWith('target-1', 'disabled');

    const demote = createHarness({ remainingSuperAdmins: 1 });
    await expect(
      demote.service.setRoles(SUPER_ADMIN_ACTOR, 'target-1', { roles: ['admin'] }, META),
    ).resolves.toMatchObject({ roles: ['admin'] });
    expect(demote.tx.userRole.createMany).toHaveBeenCalled();

    const removed = createHarness({ remainingSuperAdmins: 1 });
    await expect(
      removed.service.remove(SUPER_ADMIN_ACTOR, 'target-1', undefined, META),
    ).resolves.toMatchObject({ deleted: true });
    expect(removed.tx.user.update).toHaveBeenCalled();
  });

  it('不允许把角色提升到高于操作者自身的等级(防提权)', async () => {
    const { service } = createHarness({ remainingSuperAdmins: 1 });
    const admin: AuthUser = { ...SUPER_ADMIN_ACTOR, id: 'admin-1', roleLevel: 50, isSuperAdmin: false };

    await expect(
      service.setRoles(admin, 'admin-1', { roles: ['super_admin'] }, META),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('不允许禁用自己的账号', async () => {
    const { service } = createHarness({ remainingSuperAdmins: 5 });
    await expect(
      service.setStatus(SUPER_ADMIN_ACTOR, SUPER_ADMIN_ACTOR.id, { status: 'DISABLED' }, META),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });
});

describe('AdminUserService 店铺凭据下钻', () => {
  let service: AdminUserService;
  let shopFindMany: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    shopFindMany = vi.fn().mockResolvedValue([
      {
        id: 'shop-1',
        name: '主店',
        type: 'MAIN',
        status: 'ACTIVE',
        platform: 'taobao',
        parentId: null,
        url: null,
        contactName: null,
        contactInfo: null,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-02T00:00:00.000Z'),
        parent: null,
        credentials: [
          {
            id: 'cred-1',
            purpose: '卖家后台',
            account: 'seller@shop.test',
            loginUrl: 'https://seller.example.com',
            note: '主账号',
            // 故意混入密码相关字段,验证服务层不会把它们透出去
            password: 'plain-should-never-appear',
            passwordCipher: 'cipher-should-never-appear',
            passwordIv: 'iv',
            passwordTag: 'tag',
            keyVersion: 1,
          },
        ],
      },
    ]);

    const db = {
      user: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) },
      shop: { findMany: shopFindMany, groupBy: vi.fn().mockResolvedValue([]) },
      product: { groupBy: vi.fn().mockResolvedValue([{ shopId: 'shop-1', _count: { _all: 3 } }]) },
    };

    service = new AdminUserService(
      { db } as unknown as PrismaService,
      { record: vi.fn(), buildDiff: vi.fn() } as unknown as AuditService,
      { revokeAllForUser: vi.fn() } as unknown as SessionService,
      { hashPassword: vi.fn() } as unknown as import('../../common/crypto/crypto.service').CryptoService,
    );
  });

  it('只返回脱敏后的凭据字段,不含任何 password 与账号明文', async () => {
    const result = await service.listShops('u1', { limit: 20 });
    const credential = result.items[0]?.credentials[0];

    expect(credential).toBeDefined();
    expect(Object.keys(credential ?? {}).sort()).toEqual([
      'account',
      'id',
      'loginUrl',
      'note',
      'purpose',
    ]);

    expect(credential?.account).toBe('sel****test');
    expect(credential?.note).toBeNull();

    // 明文与密文都不能出现在响应体的任何位置
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('seller@shop.test');
    expect(serialized).not.toContain('plain-should-never-appear');
    expect(serialized).not.toContain('cipher-should-never-appear');
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toContain('keyVersion');
    expect(serialized).not.toContain('主账号');
  });

  it('查询本身也不读取密码列(select 白名单)', async () => {
    await service.listShops('u1', { limit: 20 });

    const args = shopFindMany.mock.calls[0]?.[0] as {
      select: { credentials: { select: Record<string, boolean> } };
    };
    expect(Object.keys(args.select.credentials.select).sort()).toEqual([
      'account',
      'id',
      'loginUrl',
      'note',
      'purpose',
    ]);
  });
});

describe('AdminUserService.createAdmin', () => {
  function createCreateHarness(existing: { id: string; deletedAt: Date | null } | null) {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const tx = {
      role: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'role-admin', slug: 'admin' }),
      },
      user: {
        create: vi.fn().mockResolvedValue({
          id: 'new-admin',
          email: 'new@june.test',
          displayName: '新管理员',
          status: 'ACTIVE',
          createdAt,
          lastLoginAt: null,
          lastActiveAt: null,
          roles: [{ role: { slug: 'admin' } }],
        }),
      },
    };

    const db = {
      user: {
        findUnique: vi.fn().mockResolvedValue(existing),
      },
      $transaction: vi.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
    };

    const audit = { record: vi.fn().mockResolvedValue(undefined), buildDiff: vi.fn() };
    const sessions = { revokeAllForUser: vi.fn() };
    const crypto = { hashPassword: vi.fn().mockResolvedValue('argon2id$hashed') };

    const service = new AdminUserService(
      { db } as unknown as PrismaService,
      audit as unknown as AuditService,
      sessions as unknown as SessionService,
      crypto as unknown as import('../../common/crypto/crypto.service').CryptoService,
    );

    return { service, db, tx, audit, crypto };
  }

  it('邮箱已存在时返回 CONFLICT,不写库', async () => {
    const { service, tx, crypto } = createCreateHarness({ id: 'u1', deletedAt: null });

    await expect(
      service.createAdmin(
        SUPER_ADMIN_ACTOR,
        {
          email: 'taken@june.test',
          password: 'SecurePass1!',
          displayName: '占用',
          role: 'admin',
        },
        META,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });

    expect(crypto.hashPassword).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('成功创建时哈希密码并写审计(不含明文密码)', async () => {
    const { service, tx, audit, crypto } = createCreateHarness(null);

    const result = await service.createAdmin(
      SUPER_ADMIN_ACTOR,
      {
        email: 'new@june.test',
        password: 'SecurePass1!',
        displayName: '新管理员',
        role: 'admin',
      },
      META,
    );

    expect(result).toMatchObject({
      id: 'new-admin',
      email: 'new@june.test',
      roles: ['admin'],
      shopCount: 0,
    });
    expect(crypto.hashPassword).toHaveBeenCalledWith('SecurePass1!');
    expect(tx.user.create).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.user.create_admin',
        metadata: { email: 'new@june.test', role: 'admin' },
      }),
    );
    const serialized = JSON.stringify(audit.record.mock.calls[0]?.[0]);
    expect(serialized).not.toContain('SecurePass1!');
  });
});
