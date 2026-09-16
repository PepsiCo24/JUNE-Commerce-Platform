/**
 * Prisma 7 配置文件。
 * Prisma 7 起 datasource.url、迁移路径与 seed 脚本都在此声明,
 * schema.prisma 里不再写 url,且运行时不会自动加载 .env,必须显式引入 dotenv。
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { config as loadEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// monorepo 中真实的环境变量放在仓库根目录 .env,这里向上回溯加载
for (const candidate of ['../../.env', '../../.env.local']) {
  const full = resolve(__dirname, candidate);
  if (existsSync(full)) {
    loadEnv({ path: full, override: false });
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
    // 本地开发做 migrate dev 时可选;生产使用 migrate deploy 不需要影子库
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL ? env('SHADOW_DATABASE_URL') : undefined,
  },
});
