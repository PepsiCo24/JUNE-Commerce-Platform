import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { describeEnv, loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger:
      env.NODE_ENV === 'production'
        ? ['error', 'warn', 'log']
        : ['error', 'warn', 'log', 'debug', 'verbose'],
    // 由 AllExceptionsFilter 统一处理,关闭 Nest 默认的错误输出
    bufferLogs: true,
  });

  app.setGlobalPrefix('api', { exclude: ['health', 'health/detail'] });

  // Nginx 单层反代:信任固定层数的代理头,才能拿到真实客户端 IP 做限流
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(cookieParser());
  app.use(
    compression({
      // SSE 必须关闭压缩,否则事件会被缓冲住无法即时下发
      filter: (req, res) => {
        if (req.path.includes('/events/stream')) return false;
        const type = res.getHeader('Content-Type');
        if (typeof type === 'string' && type.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );

  app.use(
    helmet({
      // 前端资源由 Next.js 提供,API 只返回 JSON,这里关掉与页面渲染相关的策略
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      // 允许前端页面跨源读取 API 响应(受 CORS 白名单约束)
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  app.enableCors({
    origin: (origin, callback) => {
      // 同源请求与服务端到服务端调用没有 Origin 头
      if (!origin) return callback(null, true);
      if (env.CORS_ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error(`来源不被允许:${origin}`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-june-csrf', 'x-june-reauth', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'Retry-After'],
    maxAge: 600,
  });

  // JSON 体积上限:富文本正文最大 512KB,留出余量
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { limit: '2mb', extended: true });

  app.useGlobalFilters(new AllExceptionsFilter());
  // 业务校验统一由 zod 管道完成,不挂载 Nest ValidationPipe(避免依赖未安装的 class-validator)

  app.enableShutdownHooks();

  await app.listen(env.API_PORT, '0.0.0.0');

  logger.log(`JUNE API 已启动:http://0.0.0.0:${env.API_PORT}/api`);
  logger.log(`运行配置:${JSON.stringify(describeEnv(env))}`);
}

void bootstrap().catch((err: unknown) => {
  // 启动失败必须让进程退出,便于容器重启策略介入
  // eslint-disable-next-line no-console
  console.error('[Bootstrap] API 启动失败:', err instanceof Error ? err.message : err);
  // eslint-disable-next-line no-console
  console.error('[Bootstrap] detail:', err);
  process.exit(1);
});
