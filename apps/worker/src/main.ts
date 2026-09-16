/**
 * Worker 进程入口。
 *
 * 启动顺序:
 *   校验环境 → 闸门对账 + 回收遗留 RUNNING 任务 → 起各队列 Worker → 注册定时任务 → 起指标服务。
 *   对账放在起 Worker **之前**,否则新任务会和"幽灵计数"抢额度。
 *
 * 优雅停机(直接关系到"重启后不重复计费"):
 *   收到 SIGTERM / SIGINT 后
 *     1. 先停止取新任务并**等待正在跑的任务自然结束**(worker.close(),带 WORKER_SHUTDOWN_TIMEOUT_MS 超时);
 *        正在等上游返回的调用不会被强行中断——中断只会得到"结果未知",反而更糟。
 *     2. 再关闭队列、Prisma、Redis。
 *   超时兜底:超过预算仍未结束就强制关闭。此时数据库里残留的 RUNNING 任务
 *   会在下次启动时被 reclaimStaleRunningTasks 转成 UNKNOWN(有上游调用记录)
 *   或退回 QUEUED(从未触达上游),因此**不会被盲目重跑**。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { Worker } from 'bullmq';

import { describeEnv, loadEnv } from './config/env';
import { reconcileGates, reclaimStaleRunningTasks } from './lib/gate-reconcile';
import { createLogger } from './lib/logger';
import { renderMetrics, totalProcessed } from './lib/metrics';
import { disconnectPrisma, pingDatabase } from './lib/prisma';
import { closeQueues } from './lib/queues';
import { disconnectRedis, pingRedis } from './lib/redis';
import { providersAvailable } from './lib/provider-registry';
import { registerSchedules } from './scheduler';
import { createImageDeriveWorker } from './workers/image-derive.worker';
import { createImageGenerationWorker } from './workers/image-generation.worker';
import { createMaintenanceWorker } from './workers/maintenance.worker';
import { createProductImportWorker } from './workers/product-import.worker';
import { createTextGenerationWorker } from './workers/text-generation.worker';

const log = createLogger('main');

const workers: Array<{ name: string; worker: Worker }> = [];
let shuttingDown = false;

async function bootstrap(): Promise<void> {
  // 环境变量校验失败直接抛错退出,不允许"带着错配置跑起来"
  const env = loadEnv();
  log.info(`Worker 启动中:${JSON.stringify(describeEnv(env))}`);

  const [dbOk, redisOk] = await Promise.all([pingDatabase(), pingRedis()]);
  if (!dbOk) throw new Error('数据库连接失败,Worker 拒绝启动');
  if (!redisOk) throw new Error('Redis 连接失败,Worker 拒绝启动');

  if (!providersAvailable()) {
    // 适配层不可用不阻止启动:派生图、导入、清理这些不依赖上游的队列仍然要工作。
    // 生图/文案任务会以 MODEL_NOT_AVAILABLE 失败,且不会产生任何上游调用。
    log.warn('供应商适配层 @june/providers 当前不可用,生图/文案任务将直接失败(不会调用上游)');
  }

  // ---- 崩溃恢复:必须在开始消费之前 ----
  await reclaimStaleRunningTasks();
  await reconcileGates();

  workers.push({ name: 'image-generation', worker: createImageGenerationWorker() });
  workers.push({ name: 'text-generation', worker: createTextGenerationWorker() });
  workers.push({ name: 'image-derive', worker: createImageDeriveWorker() });
  workers.push({ name: 'product-import', worker: createProductImportWorker() });
  workers.push({ name: 'maintenance', worker: createMaintenanceWorker() });

  for (const { name, worker } of workers) {
    worker.on('error', (err) => log.error(`Worker[${name}] 错误`, err));
    worker.on('failed', (job, err) => log.warn(`Worker[${name}] 任务 ${job?.id ?? '?'} 失败:${err.message}`));
    worker.on('stalled', (jobId) =>
      log.warn(`Worker[${name}] 任务 ${jobId} 被判定 stalled(不会自动重投,避免重复计费)`),
    );
  }
  log.info(`已启动 ${workers.length} 个队列消费者`);

  await registerSchedules();
  startMetricsServer();

  log.info('Worker 就绪');
}

// ---------------------------------------------------------------------------
// 健康检查 / 指标(只监听内网)
// ---------------------------------------------------------------------------

function startMetricsServer(): void {
  const env = loadEnv();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    if (url.startsWith('/health')) {
      void handleHealth(res);
      return;
    }
    if (url.startsWith('/metrics')) {
      void handleMetrics(res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  });

  server.on('error', (err) => log.error('指标服务出错', err));
  // 默认只绑定回环地址:/metrics 无鉴权,绝不能暴露到公网
  server.listen(env.WORKER_METRICS_PORT, env.WORKER_METRICS_HOST, () => {
    log.info(`指标服务监听 http://${env.WORKER_METRICS_HOST}:${env.WORKER_METRICS_PORT}(/health,/metrics)`);
  });
  metricsServer = server;
}

let metricsServer: ReturnType<typeof createServer> | null = null;

async function handleHealth(res: ServerResponse): Promise<void> {
  const [dbOk, redisOk] = await Promise.all([pingDatabase(), pingRedis()]);
  const ok = dbOk && redisOk && !shuttingDown;
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify({
      status: ok ? 'ok' : 'degraded',
      shuttingDown,
      database: dbOk ? 'ok' : 'down',
      redis: redisOk ? 'ok' : 'down',
      workers: workers.map((w) => w.name),
      processedJobs: totalProcessed(),
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );
}

async function handleMetrics(res: ServerResponse): Promise<void> {
  try {
    const body = await renderMetrics();
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(body);
  } catch (err) {
    log.error('生成指标失败', err);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('metrics unavailable\n');
  }
}

// ---------------------------------------------------------------------------
// 优雅停机
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const env = loadEnv();
  log.info(`收到 ${signal},开始优雅停机(最多等待 ${env.WORKER_SHUTDOWN_TIMEOUT_MS}ms 让在跑任务收尾)`);

  // 先摘掉健康检查,让编排系统尽快把流量/新任务挪走
  metricsServer?.close();

  // worker.close() 不传 force:等待正在处理的任务自然结束。
  // 正在等上游返回的调用**不主动中断**——中断只会把明确的结果变成"未知"。
  const closing = Promise.allSettled(
    workers.map(async ({ name, worker }) => {
      await worker.close();
      log.info(`Worker[${name}] 已停止`);
    }),
  );

  const timedOut = await Promise.race([
    closing.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), env.WORKER_SHUTDOWN_TIMEOUT_MS)),
  ]);

  if (timedOut) {
    log.warn(
      '等待超时,强制关闭剩余任务。' +
        '残留的 RUNNING 任务会在下次启动时由 reclaimStaleRunningTasks 转为 UNKNOWN 待核对,不会被自动重跑',
    );
    await Promise.allSettled(workers.map(({ worker }) => worker.close(true)));
  }

  await closeQueues();
  await disconnectPrisma();
  await disconnectRedis();

  log.info(`停机完成,本进程共处理 ${totalProcessed()} 个任务`);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal)
      .then(() => process.exit(0))
      .catch((err) => {
        log.error('停机过程出错', err);
        process.exit(1);
      });
  });
}

process.on('unhandledRejection', (reason) => {
  log.error('未处理的 Promise 拒绝', reason);
});
process.on('uncaughtException', (err) => {
  // 未捕获异常意味着进程状态不可信,记录后交给编排系统重启;
  // 重启后的对账逻辑会把遗留任务安全地转成 UNKNOWN 或退回 QUEUED
  log.error('未捕获异常,进程即将退出', err);
  void shutdown('uncaughtException').finally(() => process.exit(1));
});

bootstrap().catch((err) => {
  log.error('Worker 启动失败', err);
  process.exit(1);
});
