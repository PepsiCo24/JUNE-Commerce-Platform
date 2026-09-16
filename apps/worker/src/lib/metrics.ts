/**
 * 进程内指标。刻意保持极简(不引入 prom-client),
 * /metrics 输出 Prometheus 文本格式,单机部署下用 node_exporter + 一条 scrape 即可。
 */
import { QUEUE_NAMES, type QueueName } from '@june/shared';

import { queueCounts } from './queues';

interface Counter {
  processed: number;
  failed: number;
  /** 因为并发闸门未取到而被延迟重排的次数,是判断"是否需要加并发额度"的关键信号 */
  deferred: number;
  lastDurationMs: number;
}

const counters = new Map<string, Counter>();

function counterFor(queue: string): Counter {
  let counter = counters.get(queue);
  if (!counter) {
    counter = { processed: 0, failed: 0, deferred: 0, lastDurationMs: 0 };
    counters.set(queue, counter);
  }
  return counter;
}

export function recordProcessed(queue: string, durationMs: number): void {
  const counter = counterFor(queue);
  counter.processed += 1;
  counter.lastDurationMs = Math.round(durationMs);
}

export function recordFailed(queue: string): void {
  counterFor(queue).failed += 1;
}

export function recordDeferred(queue: string): void {
  counterFor(queue).deferred += 1;
}

export function snapshotCounters(): Record<string, Counter> {
  return Object.fromEntries([...counters.entries()].map(([k, v]) => [k, { ...v }]));
}

export function totalProcessed(): number {
  let total = 0;
  for (const counter of counters.values()) total += counter.processed;
  return total;
}

/** Prometheus 文本格式。纯文本、无鉴权,因此只监听内网地址。 */
export async function renderMetrics(): Promise<string> {
  const lines: string[] = [];
  const mem = process.memoryUsage();

  lines.push('# HELP june_worker_uptime_seconds Worker 进程运行时长');
  lines.push('# TYPE june_worker_uptime_seconds gauge');
  lines.push(`june_worker_uptime_seconds ${Math.round(process.uptime())}`);

  lines.push('# HELP june_worker_memory_bytes 进程内存占用');
  lines.push('# TYPE june_worker_memory_bytes gauge');
  lines.push(`june_worker_memory_bytes{kind="rss"} ${mem.rss}`);
  lines.push(`june_worker_memory_bytes{kind="heap_used"} ${mem.heapUsed}`);
  lines.push(`june_worker_memory_bytes{kind="heap_total"} ${mem.heapTotal}`);
  lines.push(`june_worker_memory_bytes{kind="external"} ${mem.external}`);

  lines.push('# HELP june_worker_jobs_total 本进程已处理任务数');
  lines.push('# TYPE june_worker_jobs_total counter');
  lines.push('# HELP june_worker_job_last_duration_ms 最近一次任务耗时');
  lines.push('# TYPE june_worker_job_last_duration_ms gauge');
  for (const [queue, counter] of Object.entries(snapshotCounters())) {
    lines.push(`june_worker_jobs_total{queue="${queue}",result="processed"} ${counter.processed}`);
    lines.push(`june_worker_jobs_total{queue="${queue}",result="failed"} ${counter.failed}`);
    lines.push(`june_worker_jobs_total{queue="${queue}",result="deferred"} ${counter.deferred}`);
    lines.push(`june_worker_job_last_duration_ms{queue="${queue}"} ${counter.lastDurationMs}`);
  }

  lines.push('# HELP june_queue_jobs 队列各状态任务数');
  lines.push('# TYPE june_queue_jobs gauge');
  for (const name of Object.values(QUEUE_NAMES) as QueueName[]) {
    const counts = await queueCounts(name);
    for (const [state, value] of Object.entries(counts)) {
      lines.push(`june_queue_jobs{queue="${name}",state="${state}"} ${value}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
