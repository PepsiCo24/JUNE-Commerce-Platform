/**
 * 商品 CSV 批量导入 Worker。
 *
 * 设计要点:
 *  1. **流式逐行读取**:用 papaparse 的 NODE_STREAM_INPUT 直接接对象存储的下载流,
 *     不把整个 CSV 读进内存(5000 行的宽表也可能有几十 MB)。
 *  2. **分批事务**:每 BATCH_SIZE 行一个事务。
 *     不做"整个文件一个事务"——长事务会长时间持有行锁、拖爆连接池,
 *     而且一行错就全量回滚,与"逐行报错、其余继续"的产品需求相冲突。
 *  3. **逐行错误**写入 ImportJob.rowErrors,并实时更新 processedRows/successRows/failedRows,
 *     让前端进度条真实反映进展(不是估算)。
 *  4. 最终状态:全成功 SUCCEEDED / 部分成功 PARTIAL / 全失败 FAILED。
 */
import { ImportStatus, ProductStatus, type Prisma } from '@june/db';
import {
  PRODUCT_IMPORT_MAX_ROWS,
  QUEUE_NAMES,
  type ProductImportJob,
  type ProductImportRowError,
} from '@june/shared';
import { Worker, type Job } from 'bullmq';
import Papa from 'papaparse';

import { loadEnv } from '../config/env';
import { createLogger } from '../lib/logger';
import { recordFailed, recordProcessed } from '../lib/metrics';
import { getPrisma } from '../lib/prisma';
import { queueConnection } from '../lib/redis';
import { getS3 } from '../lib/s3';

const log = createLogger('product-import');

/** 每个事务处理的行数。200 行是"事务够短 + 往返够少"的折中 */
const BATCH_SIZE = 200;
/** rowErrors 最多保留的条目数,防止 Json 列被撑爆 */
const MAX_ROW_ERRORS = 500;

type DuplicateStrategy = 'skip' | 'update' | 'fail';

interface ImportOptions {
  duplicateStrategy: DuplicateStrategy;
  continueOnRowError: boolean;
}

export function createProductImportWorker(): Worker<ProductImportJob> {
  const env = loadEnv();
  return new Worker<ProductImportJob>(QUEUE_NAMES.productImport, (job) => handle(job), {
    connection: queueConnection(),
    prefix: env.QUEUE_PREFIX,
    concurrency: env.CONCURRENCY_IMPORT,
    lockDuration: 30 * 60_000,
    stalledInterval: 30_000,
    // 导入会写业务数据,重投可能造成重复写入,交给人工重新触发更安全
    maxStalledCount: 0,
  });
}

async function handle(job: Job<ProductImportJob>): Promise<void> {
  const startedAt = Date.now();
  const prisma = getPrisma();
  const s3 = getS3();
  const { importJobId, ownerId } = job.data;

  const importJob = await prisma.importJob.findFirst({ where: { id: importJobId, ownerId } });
  if (!importJob) {
    log.warn(`导入作业 ${importJobId} 不存在或归属不符,跳过`);
    return;
  }
  if (importJob.status === ImportStatus.CANCELED) return;
  if (
    importJob.status === ImportStatus.SUCCEEDED ||
    importJob.status === ImportStatus.PARTIAL ||
    importJob.status === ImportStatus.FAILED
  ) {
    log.info(`导入作业 ${importJobId} 已是终态 ${importJob.status},跳过(幂等)`);
    return;
  }
  if (!importJob.shopId) {
    await finishJob(importJobId, ImportStatus.FAILED, '导入作业没有指定目标店铺');
    return;
  }
  if (!importJob.fileAssetId) {
    await finishJob(importJobId, ImportStatus.FAILED, '导入作业没有关联 CSV 文件');
    return;
  }

  // 目标店铺必须属于同一用户(带归属条件查询,不做"先查再比对")
  const shop = await prisma.shop.findFirst({
    where: { id: importJob.shopId, ownerId, deletedAt: null },
    select: { id: true },
  });
  if (!shop) {
    await finishJob(importJobId, ImportStatus.FAILED, '目标店铺不存在或不属于当前用户');
    return;
  }

  const fileAsset = await prisma.asset.findFirst({
    where: { id: importJob.fileAssetId, ownerId },
    select: { objectKey: true },
  });
  if (!fileAsset) {
    await finishJob(importJobId, ImportStatus.FAILED, 'CSV 文件不存在或不属于当前用户');
    return;
  }

  const options = resolveImportOptions(importJob.kind);
  await prisma.importJob.update({
    where: { id: importJobId },
    data: { status: ImportStatus.RUNNING, startedAt: new Date(), errorMessage: null },
  });

  const source = await s3.getStream(fileAsset.objectKey);
  if (!source) {
    await finishJob(importJobId, ImportStatus.FAILED, 'CSV 文件对象已不存在');
    return;
  }

  const rowErrors: ProductImportRowError[] = [];
  let processed = 0;
  let success = 0;
  let failed = 0;
  let aborted: string | null = null;

  const pushError = (error: ProductImportRowError): void => {
    if (rowErrors.length < MAX_ROW_ERRORS) rowErrors.push(error);
  };

  try {
    const parseStream = Papa.parse(Papa.NODE_STREAM_INPUT, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (header) => header.trim().toLowerCase(),
    });
    source.pipe(parseStream);

    let batch: Array<{ rowNumber: number; raw: Record<string, string> }> = [];

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const current = batch;
      batch = [];

      // 分批事务:一批内部要么整体成功要么整体回滚,批与批之间互不影响
      const outcome = await importBatch({
        ownerId,
        shopId: shop.id,
        rows: current,
        options,
      });
      success += outcome.success;
      failed += outcome.failed;
      processed += current.length;
      for (const error of outcome.errors) pushError(error);
      if (outcome.abortReason) aborted = outcome.abortReason;

      // 实时回写进度,前端据此显示真实进度而不是估算
      await prisma.importJob.update({
        where: { id: importJobId },
        data: {
          processedRows: processed,
          successRows: success,
          failedRows: failed,
          rowErrors: rowErrors as unknown as Prisma.InputJsonValue,
        },
      });
    };

    let rowNumber = 0;
    for await (const chunk of parseStream) {
      rowNumber += 1;
      if (rowNumber > PRODUCT_IMPORT_MAX_ROWS) {
        aborted = `CSV 行数超过上限 ${PRODUCT_IMPORT_MAX_ROWS}`;
        break;
      }
      batch.push({ rowNumber, raw: normalizeRow(chunk) });
      if (batch.length >= BATCH_SIZE) {
        await flush();
        if (aborted) break;
      }
    }
    if (!aborted) await flush();

    // 数据流结束后销毁,避免上游连接悬挂
    source.destroy();

    const total = rowNumber > PRODUCT_IMPORT_MAX_ROWS ? PRODUCT_IMPORT_MAX_ROWS : rowNumber;
    const status =
      aborted && success === 0
        ? ImportStatus.FAILED
        : failed === 0 && !aborted
          ? ImportStatus.SUCCEEDED
          : success > 0
            ? ImportStatus.PARTIAL
            : ImportStatus.FAILED;

    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        status,
        totalRows: total,
        processedRows: processed,
        successRows: success,
        failedRows: failed,
        rowErrors: rowErrors as unknown as Prisma.InputJsonValue,
        errorMessage: aborted,
        finishedAt: new Date(),
      },
    });

    recordProcessed(job.queueName, Date.now() - startedAt);
    log.info(
      `导入作业 ${importJobId} 完成:${status},共 ${total} 行,成功 ${success},失败 ${failed}` +
        (aborted ? `,中止原因:${aborted}` : ''),
    );
  } catch (err) {
    recordFailed(job.queueName);
    source.destroy();
    log.error(`导入作业 ${importJobId} 异常`, err);
    await prisma.importJob
      .update({
        where: { id: importJobId },
        data: {
          status: success > 0 ? ImportStatus.PARTIAL : ImportStatus.FAILED,
          processedRows: processed,
          successRows: success,
          failedRows: failed,
          rowErrors: rowErrors as unknown as Prisma.InputJsonValue,
          errorMessage: `导入过程中出现异常:${(err as Error).message}`.slice(0, 1_000),
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 单批导入(一个事务)
// ---------------------------------------------------------------------------

interface BatchOutcome {
  success: number;
  failed: number;
  errors: ProductImportRowError[];
  abortReason: string | null;
}

async function importBatch(params: {
  ownerId: string;
  shopId: string;
  rows: Array<{ rowNumber: number; raw: Record<string, string> }>;
  options: ImportOptions;
}): Promise<BatchOutcome> {
  const prisma = getPrisma();
  const errors: ProductImportRowError[] = [];
  let success = 0;
  let failed = 0;
  let abortReason: string | null = null;

  // 先做纯校验(不碰数据库),把明显不合规的行剔掉,减少事务里的工作量
  const parsedRows: Array<{ rowNumber: number; value: ParsedProductRow }> = [];
  for (const { rowNumber, raw } of params.rows) {
    const parsed = parseProductRow(raw);
    if (!parsed.ok) {
      failed += 1;
      errors.push({ row: rowNumber, field: parsed.field, code: parsed.code, message: parsed.message });
      if (!params.options.continueOnRowError) {
        abortReason = `第 ${rowNumber} 行校验失败且未开启"忽略错误行继续导入"`;
        return { success, failed, errors, abortReason };
      }
      continue;
    }
    parsedRows.push({ rowNumber, value: parsed.value });
  }
  if (parsedRows.length === 0) return { success, failed, errors, abortReason };

  // 批量查一次已存在的 SKU,避免逐行查询造成 N+1
  const skus = parsedRows.map((r) => r.value.sku).filter((s): s is string => !!s);
  const existing =
    skus.length > 0
      ? await prisma.product.findMany({
          where: { shopId: params.shopId, sku: { in: skus }, deletedAt: null },
          select: { id: true, sku: true },
        })
      : [];
  const existingBySku = new Map(existing.filter((p) => p.sku).map((p) => [p.sku as string, p.id]));

  await prisma
    .$transaction(async (tx) => {
      for (const { rowNumber, value } of parsedRows) {
        const duplicateId = value.sku ? existingBySku.get(value.sku) : undefined;

        if (duplicateId) {
          if (params.options.duplicateStrategy === 'skip') {
            failed += 1;
            errors.push({
              row: rowNumber,
              field: 'sku',
              code: 'PRODUCT_SKU_DUPLICATE',
              message: `SKU ${value.sku} 已存在,按"跳过"策略未导入`,
            });
            continue;
          }
          if (params.options.duplicateStrategy === 'fail') {
            errors.push({
              row: rowNumber,
              field: 'sku',
              code: 'PRODUCT_SKU_DUPLICATE',
              message: `SKU ${value.sku} 已存在,按"失败"策略中止导入`,
            });
            failed += 1;
            abortReason = `第 ${rowNumber} 行 SKU 重复,重复策略为"失败"故中止`;
            // 抛出让本批事务回滚:重复策略为 fail 时不允许留下半批数据
            throw new AbortBatch(abortReason);
          }
          // update
          await tx.product.update({
            where: { id: duplicateId },
            data: {
              name: value.name,
              title: value.title,
              description: value.description,
              price: value.price,
              currency: value.currency,
              stock: value.stock,
              status: value.status,
              attributes: value.attributes as unknown as Prisma.InputJsonValue,
            },
          });
          success += 1;
          continue;
        }

        const created = await tx.product.create({
          data: {
            ownerId: params.ownerId,
            shopId: params.shopId,
            name: value.name,
            sku: value.sku,
            title: value.title,
            description: value.description,
            price: value.price,
            currency: value.currency,
            stock: value.stock,
            status: value.status,
            attributes: value.attributes as unknown as Prisma.InputJsonValue,
          },
          select: { id: true, sku: true },
        });
        // 同一批文件内部也可能出现重复 SKU,写入后立刻登记
        if (created.sku) existingBySku.set(created.sku, created.id);
        success += 1;
      }
    })
    .catch((err) => {
      if (err instanceof AbortBatch) {
        // 本批已回滚,成功计数要归零(数据库里没留下任何一行)
        success = 0;
        return;
      }
      throw err;
    });

  return { success, failed, errors, abortReason };
}

class AbortBatch extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AbortBatch';
  }
}

// ---------------------------------------------------------------------------
// 行解析
// ---------------------------------------------------------------------------

interface ParsedProductRow {
  name: string;
  sku: string | null;
  title: string | null;
  description: string | null;
  price: string | null;
  currency: string;
  stock: number;
  status: ProductStatus;
  attributes: Record<string, string>;
}

type ParseResult =
  { ok: true; value: ParsedProductRow } | { ok: false; field: string | null; code: string; message: string };

/** CSV 列名见 @june/shared 的 PRODUCT_CSV_COLUMNS */
export function parseProductRow(raw: Record<string, string>): ParseResult {
  const name = (raw.name ?? '').trim();
  if (!name) {
    return { ok: false, field: 'name', code: 'VALIDATION_FAILED', message: '商品名称不能为空' };
  }
  if (name.length > 200) {
    return { ok: false, field: 'name', code: 'VALIDATION_FAILED', message: '商品名称超过 200 字' };
  }

  const sku = (raw.sku ?? '').trim() || null;
  if (sku && sku.length > 80) {
    return { ok: false, field: 'sku', code: 'VALIDATION_FAILED', message: 'SKU 超过 80 字' };
  }

  let price: string | null = null;
  const priceRaw = (raw.price ?? '').trim();
  if (priceRaw) {
    const numeric = Number(priceRaw.replace(/[,¥$\s]/g, ''));
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 99_999_999) {
      return {
        ok: false,
        field: 'price',
        code: 'VALIDATION_FAILED',
        message: `价格 ${priceRaw} 不是合法金额`,
      };
    }
    // 金额用字符串交给 Prisma 的 Decimal,绝不经过浮点运算
    price = numeric.toFixed(2);
  }

  const currencyRaw = (raw.currency ?? '').trim().toUpperCase();
  if (currencyRaw && currencyRaw.length !== 3) {
    return { ok: false, field: 'currency', code: 'VALIDATION_FAILED', message: '币种需为 3 位代码,如 CNY' };
  }

  let stock = 0;
  const stockRaw = (raw.stock ?? '').trim();
  if (stockRaw) {
    const numeric = Number(stockRaw);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 9_999_999) {
      return {
        ok: false,
        field: 'stock',
        code: 'VALIDATION_FAILED',
        message: `库存 ${stockRaw} 不是合法整数`,
      };
    }
    stock = numeric;
  }

  const statusRaw = (raw.status ?? '').trim().toUpperCase();
  const statusMap: Record<string, ProductStatus> = {
    '': ProductStatus.DRAFT,
    DRAFT: ProductStatus.DRAFT,
    ACTIVE: ProductStatus.ACTIVE,
    OFF_SHELF: ProductStatus.OFF_SHELF,
    ARCHIVED: ProductStatus.ARCHIVED,
  };
  const status = statusMap[statusRaw];
  if (!status) {
    return {
      ok: false,
      field: 'status',
      code: 'VALIDATION_FAILED',
      message: `状态 ${statusRaw} 无效,可选:DRAFT / ACTIVE / OFF_SHELF / ARCHIVED`,
    };
  }

  const attributesRaw = (raw.attributes ?? '').trim();
  let attributes: Record<string, string> = {};
  if (attributesRaw) {
    const parsed = parseAttributes(attributesRaw);
    if (!parsed) {
      return {
        ok: false,
        field: 'attributes',
        code: 'VALIDATION_FAILED',
        message: '扩展属性需为 JSON 对象或 key=value;key2=value2 形式',
      };
    }
    attributes = parsed;
  }

  const title = (raw.title ?? '').trim() || null;
  if (title && title.length > 300) {
    return { ok: false, field: 'title', code: 'VALIDATION_FAILED', message: '营销标题超过 300 字' };
  }
  const description = (raw.description ?? '').trim() || null;
  if (description && description.length > 20_000) {
    return { ok: false, field: 'description', code: 'VALIDATION_FAILED', message: '描述超过 20000 字' };
  }

  return {
    ok: true,
    value: {
      name,
      sku,
      title,
      description,
      price,
      currency: currencyRaw || 'CNY',
      stock,
      status,
      attributes,
    },
  };
}

function parseAttributes(raw: string): Record<string, string> | null {
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (key.length > 60) return null;
        out[key] = String(value).slice(0, 500);
      }
      return out;
    } catch {
      return null;
    }
  }

  const out: Record<string, string> = {};
  for (const pair of raw.split(/[;;]/)) {
    if (!pair.trim()) continue;
    const index = pair.indexOf('=');
    if (index <= 0) return null;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key || key.length > 60) return null;
    out[key] = value.slice(0, 500);
  }
  return out;
}

function normalizeRow(chunk: unknown): Record<string, string> {
  const row = (chunk ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.trim().toLowerCase()] = value === null || value === undefined ? '' : String(value);
  }
  return out;
}

/**
 * 导入选项来源。
 *
 * 注意:当前 ImportJob 表没有独立的 options 列,而 ProductImportJob 载荷里也只有
 * importJobId / ownerId(队列契约不能改)。因此按以下顺序解析,两种方式都兼容:
 *   1. `kind` 字段的扩展编码:`product_csv:<duplicateStrategy>[:strict]`
 *      (例:product_csv:update、product_csv:fail:strict);
 *   2. 都不匹配时使用与 productImportCommitSchema 一致的默认值:
 *      duplicateStrategy=skip、continueOnRowError=true。
 */
export function resolveImportOptions(kind: string): ImportOptions {
  const parts = kind.split(':');
  const strategy = parts[1];
  const mode = parts[2];
  const duplicateStrategy: DuplicateStrategy =
    strategy === 'update' || strategy === 'fail' || strategy === 'skip' ? strategy : 'skip';
  return {
    duplicateStrategy,
    continueOnRowError: mode !== 'strict',
  };
}

async function finishJob(importJobId: string, status: ImportStatus, message: string): Promise<void> {
  log.warn(`导入作业 ${importJobId} 终止:${message}`);
  await getPrisma()
    .importJob.update({
      where: { id: importJobId },
      data: { status, errorMessage: message.slice(0, 1_000), finishedAt: new Date() },
    })
    .catch(() => undefined);
}
