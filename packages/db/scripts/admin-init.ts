/**
 * 管理员初始化命令。
 *
 * 安全约定(重要):
 *  1. 绝不写死任何默认密码。账号与密码只能来自:
 *     - 环境变量 ADMIN_INIT_EMAIL / ADMIN_INIT_PASSWORD(适合 CI 与自动化部署);
 *     - 或交互式安全输入(密码不回显、不进入 shell 历史)。
 *  2. 密码使用 Argon2id 不可逆哈希存储,明文不落库、不打印、不写日志。
 *  3. 已存在同邮箱账号时默认不改密码,只补齐角色;需要重置须显式加 --reset-password。
 *  4. 密码强度按 @june/shared 的 PASSWORD_MIN_LENGTH 校验,并要求包含多种字符类型。
 *
 * 用法:
 *   pnpm --filter @june/db admin:init                       # 交互式输入
 *   ADMIN_INIT_EMAIL=... ADMIN_INIT_PASSWORD=... pnpm --filter @june/db admin:init
 *   pnpm --filter @june/db admin:init -- --role admin        # 只创建普通管理员(默认 super_admin)
 *   pnpm --filter @june/db admin:init -- --reset-password    # 重置已有账号密码
 *   pnpm --filter @june/db admin:init -- --list              # 只列出现有管理员
 */

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

import 'dotenv/config';
import { hash } from '@node-rs/argon2';

import { createPrismaClient } from '../src/client';
import { ROLE_ADMIN, ROLE_SUPER_ADMIN, ROLE_LEVEL, type RoleSlug } from '../src/constants';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('缺少 DATABASE_URL。请先复制 .env.example 为 .env 并填写数据库连接串。');
}

const prisma = createPrismaClient({ connectionString, poolMax: 3, logQueries: false });

const MIN_PASSWORD_LENGTH = 10;
const DEFAULT_QUOTA_BYTES = BigInt(5 * 1024 * 1024 * 1024);

/** Argon2id 参数。与 apps/api 的 CryptoService 保持一致,否则登录校验会失败。 */
const ARGON2_OPTIONS = {
  algorithm: 2, // Argon2id
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

interface Args {
  role: RoleSlug;
  resetPassword: boolean;
  list: boolean;
  displayName?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { role: ROLE_SUPER_ADMIN, resetPassword: false, list: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    switch (arg) {
      case '--role': {
        const value = argv[i + 1];
        if (value !== ROLE_ADMIN && value !== ROLE_SUPER_ADMIN) {
          throw new Error(`--role 只能是 ${ROLE_ADMIN} 或 ${ROLE_SUPER_ADMIN}`);
        }
        args.role = value;
        i += 1;
        break;
      }
      case '--name': {
        args.displayName = argv[i + 1];
        i += 1;
        break;
      }
      case '--reset-password':
        args.resetPassword = true;
        break;
      case '--list':
        args.list = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`未知参数:${arg}`);
    }
  }

  return args;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * 无回显读取密码。
 * 直接操作 raw mode 而不是让 readline 打印,保证终端与 shell 历史里都不会留下明文。
 */
function askSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      reject(
        new Error(
          '当前不是交互式终端,无法安全读取密码。请改用环境变量 ADMIN_INIT_PASSWORD(注意避免写入 shell 历史)。',
        ),
      );
      return;
    }

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        switch (char) {
          case '\n':
          case '\r':
          case '\u0004': // Ctrl-D
            cleanup();
            stdout.write('\n');
            resolve(value);
            return;
          case '\u0003': // Ctrl-C
            cleanup();
            stdout.write('\n');
            reject(new Error('已取消'));
            return;
          case '\u007f': // Backspace
          case '\b':
            value = value.slice(0, -1);
            break;
          default:
            // 忽略其余控制字符
            if (char >= ' ') value += char;
        }
      }
    };

    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    stdin.on('data', onData);
  });
}

function validateEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`邮箱格式不正确:${email}`);
  }
}

/** 密码强度:长度 + 至少三类字符,避免弱口令直接进生产 */
function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
  if (password.length > 200) {
    throw new Error('密码不能超过 200 位');
  }

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    throw new Error('密码需包含小写字母、大写字母、数字、符号中的至少三类');
  }

  const weak = ['password', '12345678', 'admin123', 'qwerty', 'june', 'letmein'];
  const lower = password.toLowerCase();
  if (weak.some((w) => lower.includes(w))) {
    throw new Error('密码包含常见弱口令片段,请更换');
  }
}

async function listAdmins(): Promise<void> {
  const admins = await prisma.user.findMany({
    where: {
      deletedAt: null,
      roles: { some: { role: { level: { gte: ROLE_LEVEL[ROLE_ADMIN] } } } },
    },
    select: {
      email: true,
      displayName: true,
      status: true,
      lastLoginAt: true,
      roles: { select: { role: { select: { slug: true, level: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (admins.length === 0) {
    console.log('[admin:init] 当前没有任何管理员账号');
    return;
  }

  console.log(`[admin:init] 现有管理员 ${admins.length} 个:`);
  for (const a of admins) {
    const roles = a.roles.map((r) => r.role.slug).join(',');
    const lastLogin = a.lastLoginAt ? a.lastLoginAt.toISOString() : '从未登录';
    console.log(`  - ${a.email}  [${roles}]  ${a.status}  最后登录:${lastLogin}  ${a.displayName}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    await listAdmins();
    return;
  }

  // 角色表必须先由种子写入
  const role = await prisma.role.findUnique({ where: { slug: args.role } });
  if (!role) {
    throw new Error(`角色 ${args.role} 不存在。请先执行:pnpm --filter @june/db seed`);
  }

  const email = (process.env.ADMIN_INIT_EMAIL ?? (await ask('管理员邮箱: '))).trim().toLowerCase();
  validateEmail(email);

  const displayNameInput =
    args.displayName ?? process.env.ADMIN_INIT_NAME ?? (await ask('显示名称(留空则使用邮箱前缀): '));
  const displayName = displayNameInput || (email.split('@')[0] ?? email);

  const existing = await prisma.user.findUnique({
    where: { email },
    include: { roles: { include: { role: true } } },
  });

  // ---- 已存在账号:默认只补角色,不动密码 ----
  if (existing && !args.resetPassword) {
    const hasRole = existing.roles.some((r) => r.roleId === role.id);
    if (hasRole) {
      console.log(`[admin:init] 账号 ${email} 已存在且已拥有 ${args.role} 角色,无需处理。`);
      console.log('[admin:init] 如需重置密码请加 --reset-password');
      return;
    }

    await prisma.userRole.create({ data: { userId: existing.id, roleId: role.id, grantedBy: 'admin:init' } });
    await prisma.auditLog.create({
      data: {
        actorId: existing.id,
        actorEmail: email,
        actorRole: 'system',
        action: 'user.role.grant',
        targetType: 'user',
        targetId: existing.id,
        diff: { added: args.role },
        metadata: { source: 'admin:init' },
      },
    });
    console.log(`[admin:init] 已为已有账号 ${email} 追加 ${args.role} 角色。密码保持不变。`);
    return;
  }

  // ---- 需要密码:环境变量优先,否则交互输入 ----
  let password = process.env.ADMIN_INIT_PASSWORD ?? '';
  if (password) {
    console.log('[admin:init] 使用环境变量 ADMIN_INIT_PASSWORD');
  } else {
    password = await askSecret('设置密码(不回显): ');
    const confirm = await askSecret('再次输入密码: ');
    if (password !== confirm) throw new Error('两次输入的密码不一致');
  }
  validatePassword(password);

  const passwordHash = await hash(password, ARGON2_OPTIONS);
  // 尽早解除对明文的引用
  password = '';

  if (existing) {
    // ---- 重置已有账号密码 ----
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          // 前移 sessionEpoch,使该账号所有旧会话立即失效
          sessionEpoch: { increment: 1 },
          status: 'ACTIVE',
        },
      });
      await tx.session.updateMany({
        where: { userId: existing.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'admin_init_password_reset' },
      });
      if (!existing.roles.some((r) => r.roleId === role.id)) {
        await tx.userRole.create({ data: { userId: existing.id, roleId: role.id, grantedBy: 'admin:init' } });
      }
      await tx.auditLog.create({
        data: {
          actorId: existing.id,
          actorEmail: email,
          actorRole: 'system',
          action: 'user.password.reset',
          targetType: 'user',
          targetId: existing.id,
          // 审计只记录动作,绝不记录密码或哈希
          metadata: { source: 'admin:init', role: args.role },
        },
      });
    });

    console.log(`[admin:init] 已重置 ${email} 的密码,并使其所有旧会话失效。`);
    return;
  }

  // ---- 创建新管理员 ----
  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        passwordHash,
        displayName,
        status: 'ACTIVE',
        passwordChangedAt: new Date(),
        roles: { create: { roleId: role.id, grantedBy: 'admin:init' } },
        storageUsage: { create: { quotaBytes: DEFAULT_QUOTA_BYTES } },
      },
      select: { id: true, email: true },
    });

    await tx.auditLog.create({
      data: {
        actorId: user.id,
        actorEmail: email,
        actorRole: 'system',
        action: 'user.create',
        targetType: 'user',
        targetId: user.id,
        metadata: { source: 'admin:init', role: args.role },
      },
    });

    return user;
  });

  console.log(`[admin:init] 已创建管理员:${created.email}(角色 ${args.role})`);
  console.log('[admin:init] 登录入口:/admin/login(与普通用户登录入口相互独立)');
}

main()
  .catch((error: unknown) => {
    console.error(`[admin:init] 失败:${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
