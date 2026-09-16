/**
 * 压测规模数据播种。
 *
 * 边界:
 *  - 邮箱一律 `@loadtest.invalid`,显示名带 `[LOADTEST]` 前缀,
 *    与真实数据、演示数据(@demo.june.invalid)互不混淆;
 *  - 幂等:按固定 id / email upsert,可重复执行;
 *  - 启用 `mock-loadtest` 供应商(packages/providers/src/image/mock.ts),
 *    产出带 MOCK 字样,不代表真实模型能力;
 *  - 若缺少 PROVIDER_SECRET_ENCRYPTION_KEY,只启用模型可见性并打印警告,
 *    生图压测会得到 MODEL_CREDENTIAL_MISSING,不会伪造成功。
 *
 * 用法:
 *   pnpm loadtest:seed
 *   LOADTEST_USERS=50 LOADTEST_POSTS=200 LOADTEST_PASSWORD='Loadtest-Passw0rd!' pnpm loadtest:seed
 */

import { createCipheriv, randomBytes } from 'node:crypto';

import 'dotenv/config';
import { hash } from '@node-rs/argon2';

import { createPrismaClient } from '../src/client';
import { ROLE_USER } from '../src/constants';
import { PostStatus, ProductStatus, ShopStatus, ShopType } from '../generated/prisma/client';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('缺少 DATABASE_URL。请先复制 .env.example 为 .env。');
}

const prisma = createPrismaClient({ connectionString, poolMax: 5, logQueries: false });

const EMAIL_DOMAIN = 'loadtest.invalid';
const PREFIX = '[LOADTEST]';
const USER_COUNT = Math.max(1, Number(process.env.LOADTEST_USERS ?? 50));
const POST_COUNT = Math.max(1, Number(process.env.LOADTEST_POSTS ?? 200));
const SHOP_COUNT = Math.max(1, Number(process.env.LOADTEST_SHOPS ?? 20));
const PASSWORD = process.env.LOADTEST_PASSWORD ?? 'Loadtest-Passw0rd!';
const QUOTA_BYTES = BigInt(5 * 1024 * 1024 * 1024);

const ARGON2_OPTIONS = {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

function pad(n: number): string {
  return String(n).padStart(3, '0');
}

function sealProviderKey(plain: string, providerId: string, keyB64: string): { cipher: string; iv: string; tag: string } {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error('PROVIDER_SECRET_ENCRYPTION_KEY 必须是 base64 编码的 32 字节');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`provider:${providerId}`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    cipher: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

async function enableMockProvider(): Promise<{ enabled: boolean; reason: string }> {
  const provider = await prisma.modelProvider.findUnique({ where: { slug: 'mock-loadtest' } });
  if (!provider) {
    return { enabled: false, reason: '找不到 slug=mock-loadtest 的供应商,请先 pnpm db:seed' };
  }

  const encKey = process.env.PROVIDER_SECRET_ENCRYPTION_KEY?.trim() ?? '';
  const dummyKey = 'mock-not-a-real-upstream-key';

  if (!encKey) {
    await prisma.modelProvider.update({
      where: { id: provider.id },
      data: { enabled: true, deletedAt: null },
    });
    await prisma.modelConfig.updateMany({
      where: { providerId: provider.id },
      data: { enabled: true, visible: true, deletedAt: null },
    });
    return {
      enabled: false,
      reason: '未设置 PROVIDER_SECRET_ENCRYPTION_KEY,已启用 MOCK 供应商但 hasCredential=false。生图提交会返回 MODEL_CREDENTIAL_MISSING。',
    };
  }

  const sealed = sealProviderKey(dummyKey, provider.id, encKey);
  await prisma.modelProvider.update({
    where: { id: provider.id },
    data: {
      enabled: true,
      deletedAt: null,
      hasCredential: true,
      apiKeyMasked: 'mock-****key',
      apiKeyCipher: sealed.cipher,
      apiKeyIv: sealed.iv,
      apiKeyTag: sealed.tag,
      keyVersion: 1,
      baseUrl: process.env.MOCK_PROVIDER_BASE_URL
        ? `${process.env.MOCK_PROVIDER_BASE_URL.replace(/\/$/, '')}/v1`
        : provider.baseUrl,
    },
  });
  await prisma.modelConfig.updateMany({
    where: { providerId: provider.id },
    data: { enabled: true, visible: true, deletedAt: null },
  });

  await prisma.configRevision.updateMany({
    where: { scope: 'models' },
    data: { version: { increment: 1 } },
  });

  return { enabled: true, reason: '已写入 MOCK 占位凭据(掩码 mock-****key,明文不会打印)。' };
}

async function main(): Promise<void> {
  const userRole = await prisma.role.findUnique({ where: { slug: ROLE_USER } });
  if (!userRole) throw new Error('缺少 user 角色,请先 pnpm db:seed');

  const passwordHash = await hash(PASSWORD, ARGON2_OPTIONS);
  const userIds: string[] = [];

  for (let i = 1; i <= USER_COUNT; i += 1) {
    const email = `loadtest-${pad(i)}@${EMAIL_DOMAIN}`;
    const id = `loadtest-user-${pad(i)}`;
    const user = await prisma.user.upsert({
      where: { email },
      create: {
        id,
        email,
        passwordHash,
        displayName: `${PREFIX} 用户 ${i}`,
        bio: '压测账号,与真实用户隔离。',
        roles: { create: { roleId: userRole.id, grantedBy: 'loadtest:seed' } },
        storageUsage: { create: { quotaBytes: QUOTA_BYTES } },
      },
      update: { passwordHash, deletedAt: null, status: 'ACTIVE' },
    });
    userIds.push(user.id);
  }

  const ownerId = userIds[0];
  if (!ownerId) throw new Error('压测用户创建失败');

  for (let i = 1; i <= SHOP_COUNT; i += 1) {
    const id = `loadtest-shop-${pad(i)}`;
    await prisma.shop.upsert({
      where: { id },
      create: {
        id,
        ownerId,
        type: i === 1 ? ShopType.MAIN : ShopType.SUB,
        status: ShopStatus.ACTIVE,
        name: `${PREFIX} 店铺 ${i}`,
        platform: 'taobao',
        parentId: i === 1 ? null : 'loadtest-shop-001',
      },
      update: {},
    });
    await prisma.product.upsert({
      where: { id: `loadtest-product-${pad(i)}` },
      create: {
        id: `loadtest-product-${pad(i)}`,
        ownerId,
        shopId: 'loadtest-shop-001',
        status: ProductStatus.ACTIVE,
        name: `${PREFIX} 商品 ${i}`,
        sku: `LT-${pad(i)}`,
        price: '19.90',
        stock: 10,
      },
      update: {},
    });
  }

  for (let i = 1; i <= POST_COUNT; i += 1) {
    const id = `loadtest-post-${pad(i)}`;
    const slug = `loadtest-post-${pad(i)}`;
    await prisma.post.upsert({
      where: { id },
      create: {
        id,
        slug,
        authorId: userIds[(i - 1) % userIds.length] ?? ownerId,
        status: PostStatus.PUBLISHED,
        title: `${PREFIX} 帖子 ${i}`,
        contentHtml: `<p>压测正文 ${i}。不代表真实社区内容。</p>`,
        excerpt: `压测摘要 ${i}`,
        publishedAt: new Date(),
      },
      update: {},
    });
  }

  const mock = await enableMockProvider();

  console.log(
    [
      `[loadtest:seed] 用户 ${USER_COUNT} / 店铺 ${SHOP_COUNT} / 商品 ${SHOP_COUNT} / 帖子 ${POST_COUNT}`,
      `  账号:loadtest-001@${EMAIL_DOMAIN} … loadtest-${pad(USER_COUNT)}@${EMAIL_DOMAIN}`,
      `  密码:${PASSWORD}`,
      `  MOCK 供应商:${mock.enabled ? '已启用' : '未完全启用'} — ${mock.reason}`,
      '  下一步:docker compose --profile loadtest up -d mock-provider',
      '         MOCK_PROVIDER_ENABLED=true PROVIDER_URL_ALLOW_PRIVATE_NETWORK=true',
      '         k6 run loadtest/k6/mixed-50vu-30m.js',
    ].join('\n'),
  );
}

main()
  .catch((error) => {
    console.error('[loadtest:seed] 失败', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
